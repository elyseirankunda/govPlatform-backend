import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/httpError';
import { validate } from '../middleware/validate';
import { authenticate, requirePermission } from '../middleware/auth';
import { audit } from '../middleware/audit';
import { getScope, scopeVillageIds, assertInScope } from '../services/scope.service';
import { notifyLevel } from '../services/notify.service';
import { parsePagination, pageResponse } from '../utils/pagination';

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10),
  location: z.string().optional().or(z.literal('')),
  villageId: z.number().int().positive(),
  responsibleOfficerId: z.number().int().positive().optional(),
  startDate: z.string().optional(),
  expectedEndDate: z.string().optional(),
  budget: z.coerce.number().min(0).default(0),
  fundingSource: z.string().optional().or(z.literal('')),
  beneficiaries: z.coerce.number().int().min(0).default(0),
});

const updateSchema = z.object({
  title: z.string().min(3).optional(),
  description: z.string().min(10).optional(),
  progress: z.coerce.number().int().min(0).max(100).optional(),
  status: z.enum(['PLANNED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'SUSPENDED']).optional(),
  beneficiaries: z.coerce.number().int().min(0).optional(),
  budget: z.coerce.number().min(0).optional(),
  budgetSpent: z.coerce.number().min(0).optional(),
  fundingSource: z.string().optional().or(z.literal('')),
});

const updateSchemaStrict = updateSchema.extend({});

const updateLogSchema = z.object({ content: z.string().min(3), progress: z.coerce.number().int().min(0).max(100) });

function include() {
  return {
    responsibleOfficer: { select: { id: true, fullName: true } },
    village: { include: { cell: { include: { sector: { include: { district: { include: { province: true } } } } } } } },
    updates: { include: { author: { select: { fullName: true } } }, orderBy: { createdAt: 'desc' as const }, take: 20 },
  };
}

async function loadAttachments(projectId: number) {
  return prisma.attachment.findMany({
    where: { entity: 'PROJECT', entityId: projectId },
    include: { uploadedBy: { select: { fullName: true } } },
    orderBy: { createdAt: 'asc' },
  });
}

router.post(
  '/',
  requirePermission('projects.manage'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    if (scope.level === 6) throw forbidden('Citizens cannot create projects');
    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, req.body.villageId);

    const village = await prisma.village.findUnique({
      where: { id: req.body.villageId },
      include: { cell: { include: { sector: { include: { district: true } } } } },
    });
    if (!village) throw notFound('Village not found');

    const project = await prisma.project.create({
      data: {
        title: req.body.title,
        description: req.body.description,
        location: req.body.location || null,
        villageId: village.id,
        cellId: village.cellId,
        sectorId: village.cell.sectorId,
        districtId: village.cell.sector.districtId,
        provinceId: village.cell.sector.district.provinceId,
        level: scope.level,
        responsibleOfficerId: req.body.responsibleOfficerId ?? null,
        startDate: req.body.startDate ? new Date(req.body.startDate) : null,
        expectedEndDate: req.body.expectedEndDate ? new Date(req.body.expectedEndDate) : null,
        budget: req.body.budget,
        fundingSource: req.body.fundingSource || null,
        beneficiaries: req.body.beneficiaries,
        status: 'PLANNED',
      },
      include: include(),
    });

    await audit(req, 'PROJECT_CREATED', 'PROJECT', project.id, null, { title: req.body.title });
    res.status(201).json({ project });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    const { page, limit, skip } = parsePagination(req.query as any);

    let where: any = {};
    if (scope.level === 6) {
      const villageIds = await scopeVillageIds(scope);
      where.villageId = { in: villageIds };
    } else {
      const villageIds = await scopeVillageIds(scope);
      where.villageId = { in: villageIds };
    }
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.q) where.title = { contains: String(req.query.q) };

    const [total, items] = await Promise.all([
      prisma.project.count({ where }),
      prisma.project.findMany({
        where,
        include: {
          responsibleOfficer: { select: { id: true, fullName: true } },
          village: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);
    res.json(pageResponse(items, total, page, limit));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    const project = await prisma.project.findUnique({ where: { id: Number(req.params.id) }, include: include() });
    if (!project) throw notFound('Project not found');
    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, project.villageId);
    const attachments = await loadAttachments(project.id);
    res.json({ project: { ...project, attachments } });
  }),
);

router.put(
  '/:id',
  requirePermission('projects.manage'),
  validate(updateSchemaStrict),
  asyncHandler(async (req, res) => {
    const project = await prisma.project.findUnique({ where: { id: Number(req.params.id) } });
    if (!project) throw notFound('Project not found');

    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, project.villageId);
    if (scope.level > project.level) throw forbidden('Only the owning level or above can update this project');

    const data: any = { ...req.body };
    if (data.progress !== undefined && data.status === undefined) {
      data.status = data.progress >= 100 ? 'COMPLETED' : data.progress > 0 ? 'IN_PROGRESS' : project.status;
    }

    const updated = await prisma.project.update({ where: { id: project.id }, data, include: include() });
    await audit(req, 'PROJECT_UPDATED', 'PROJECT', project.id, null, req.body);

    if (data.progress !== undefined) {
      await notifyLevel(project.level, project.provinceId, project.districtId, project.sectorId, project.cellId, project.villageId,
        'Project progress updated', `${project.title} is now ${data.progress}% complete`, 'PROJECT', `/projects/${project.id}`);
    }
    res.json({ project: updated });
  }),
);

router.post(
  '/:id/updates',
  requirePermission('projects.manage'),
  validate(updateLogSchema),
  asyncHandler(async (req, res) => {
    const project = await prisma.project.findUnique({ where: { id: Number(req.params.id) } });
    if (!project) throw notFound('Project not found');

    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, project.villageId);
    if (scope.level > project.level) throw forbidden('Only the owning level or above can post updates');

    const update = await prisma.projectUpdate.create({
      data: { projectId: project.id, authorId: req.user!.id, content: req.body.content, progress: req.body.progress },
    });

    const updated = await prisma.project.update({
      where: { id: project.id },
      data: { progress: req.body.progress, status: req.body.progress >= 100 ? 'COMPLETED' : req.body.progress > 0 ? 'IN_PROGRESS' : project.status },
      include: include(),
    });

    await audit(req, 'PROJECT_UPDATE_POSTED', 'PROJECT', project.id, null, { progress: req.body.progress });
    res.status(201).json({ update, project: updated });
  }),
);

export default router;

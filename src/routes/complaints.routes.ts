import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../lib/httpError';
import { validate } from '../middleware/validate';
import { authenticate, requirePermission } from '../middleware/auth';
import { audit } from '../middleware/audit';
import { getScope, scopeVillageIds, assertInScope } from '../services/scope.service';
import { notify, notifyLevel } from '../services/notify.service';
import { parsePagination, pageResponse } from '../utils/pagination';
import { toCsv, sendCsv } from '../utils/csv';
import { sortBy } from '../utils/sort';

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  categoryId: z.number().int().positive(),
  title: z.string().min(3).max(200),
  description: z.string().min(10),
  location: z.string().optional().or(z.literal('')),
  villageId: z.number().int().positive(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
});

const statusSchema = z.object({
  status: z.enum(['SUBMITTED', 'RECEIVED', 'UNDER_REVIEW', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']),
  resolution: z.string().optional(),
});

const assignSchema = z.object({ officerId: z.number().int().positive() });

const escalateSchema = z.object({ reason: z.string().min(5) });

const commentSchema = z.object({ comment: z.string().min(1).max(2000) });

const feedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional().or(z.literal('')),
});

const listQuerySchema = z.object({
  status: z.string().optional(),
  categoryId: z.coerce.number().int().optional(),
  priority: z.string().optional(),
  q: z.string().optional(),
});

async function loadComplaint(id: number, includeAll = false) {
  const complaint = await prisma.complaint.findUnique({
    where: { id },
    include: {
      category: true,
      citizen: {
        include: {
          user: { select: { fullName: true } },
          village: true,
        },
      },
      assignedOfficer: { select: { id: true, fullName: true } },
      village: { include: { cell: { include: { sector: { include: { district: { include: { province: true } } } } } } } },
      comments: { include: { user: { select: { id: true, fullName: true, role: { select: { name: true } } } } }, orderBy: { createdAt: 'asc' } },
      feedback: true,
    },
  });
  if (!complaint) return complaint;
  const [escalations, attachments] = await Promise.all([
    prisma.escalation.findMany({
      where: { entity: 'COMPLAINT', entityId: id },
      include: { fromUser: { select: { fullName: true } }, toUser: { select: { fullName: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.attachment.findMany({
      where: { entity: 'COMPLAINT', entityId: id },
      include: { uploadedBy: { select: { fullName: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return { ...complaint, escalations, attachments };
}

router.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    const items = await prisma.complaintCategory.findMany({ orderBy: { name: 'asc' } });
    res.json({ items });
  }),
);

router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const data = req.body;
    const scope = await getScope(req.user!.id);

    // Citizens may only file in their own village.
    if (scope.level === 6) {
      if (!scope.citizenId) throw forbidden('Citizen profile not found');
      if (scope.villageId !== data.villageId) throw forbidden('You can only submit complaints for your own location');
    } else {
      const villageIds = await scopeVillageIds(scope);
      assertInScope(villageIds, data.villageId);
    }

    const village = await prisma.village.findUnique({
      where: { id: data.villageId },
      include: { cell: { include: { sector: { include: { district: true } } } } },
    });
    if (!village) throw notFound('Village not found');

    const citizenId = scope.level === 6 ? scope.citizenId! : await ensureCitizenProfile(req.user!.id, data.villageId);

    const complaint = await prisma.complaint.create({
      data: {
        citizenId,
        categoryId: data.categoryId,
        title: data.title,
        description: data.description,
        location: data.location || null,
        villageId: village.id,
        cellId: village.cellId,
        sectorId: village.cell.sectorId,
        districtId: village.cell.sector.districtId,
        provinceId: village.cell.sector.district.provinceId,
        priority: data.priority,
        status: 'SUBMITTED',
        currentLevel: 5,
      },
    });

    await audit(req, 'COMPLAINT_CREATED', 'COMPLAINT', complaint.id, null, { title: data.title });
    await notifyLevel(5, complaint.provinceId, complaint.districtId, complaint.sectorId, complaint.cellId, complaint.villageId,
      'New complaint submitted', `#${complaint.complaintNo} - ${complaint.title}`, 'COMPLAINT', `/complaints/${complaint.id}`);
    res.status(201).json({ complaint: await loadComplaint(complaint.id) });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    const scope = await getScope(req.user!.id);
    const { page, limit, skip } = parsePagination(req.query as any);

    let where: any = {};
    if (scope.level === 6) {
      where.citizenId = scope.citizenId;
    } else {
      const villageIds = await scopeVillageIds(scope);
      where.villageId = { in: villageIds };
    }
    if (query.status) where.status = query.status;
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.priority) where.priority = query.priority;
    if (query.q) {
      where.OR = [{ title: { contains: query.q } }, { complaintNo: { contains: query.q } }];
    }

    if (String(req.query.export).toLowerCase() === 'csv') {
      const rows = await prisma.complaint.findMany({
        where,
        include: { category: true, citizen: { include: { user: { select: { fullName: true } } } }, village: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      const csv = toCsv(
        ['Complaint No', 'Title', 'Category', 'Priority', 'Status', 'Citizen', 'Village', 'Created'],
        rows.map((c) => [c.complaintNo, c.title, c.category.name, c.priority, c.status, c.citizen.user.fullName, c.village.name, c.createdAt.toISOString()]),
      );
      return sendCsv(res, 'complaints.csv', csv);
    }

    const orderBy = sortBy(req.query.sort, {
      oldest: { createdAt: 'asc' },
      status: [{ status: 'asc' }, { createdAt: 'desc' }],
      priority: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });

    const [total, items] = await Promise.all([
      prisma.complaint.count({ where }),
      prisma.complaint.findMany({
        where,
        include: {
          category: true,
          citizen: { include: { user: { select: { fullName: true } }, village: true } },
          assignedOfficer: { select: { id: true, fullName: true } },
          village: { select: { id: true, name: true } },
        },
        orderBy,
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
    const complaint = await loadComplaint(Number(req.params.id));
    if (!complaint) throw notFound('Complaint not found');

    if (scope.level === 6) {
      if (complaint.citizenId !== scope.citizenId) throw notFound('Complaint not found');
    } else {
      const villageIds = await scopeVillageIds(scope);
      assertInScope(villageIds, complaint.villageId);
    }
    res.json({ complaint });
  }),
);

router.put(
  '/:id/status',
  requirePermission('complaints.manage'),
  validate(statusSchema),
  asyncHandler(async (req, res) => {
    const complaint = await prisma.complaint.findUnique({ where: { id: Number(req.params.id) } });
    if (!complaint) throw notFound('Complaint not found');

    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, complaint.villageId);

    const data: any = { status: req.body.status };
    if (req.body.status === 'RESOLVED' || req.body.status === 'CLOSED') {
      data.resolution = req.body.resolution;
      data.resolutionDate = new Date();
      data.resolvedById = req.user!.id;
    }

    const updated = await prisma.complaint.update({ where: { id: complaint.id }, data });
    await audit(req, `COMPLAINT_${req.body.status}`, 'COMPLAINT', complaint.id, { status: complaint.status }, { status: req.body.status });

    if (['RESOLVED', 'CLOSED'].includes(req.body.status)) {
      await notify(complaint.citizenId ? (await prisma.citizen.findUnique({ where: { id: complaint.citizenId } }))!.userId : 0,
        'Complaint updated', `Your complaint #${complaint.complaintNo} is now ${req.body.status}`, 'COMPLAINT', `/complaints/${complaint.id}`);
    }

    res.json({ complaint: await loadComplaint(complaint.id) });
  }),
);

router.post(
  '/:id/assign',
  requirePermission('complaints.manage'),
  validate(assignSchema),
  asyncHandler(async (req, res) => {
    const complaint = await prisma.complaint.findUnique({ where: { id: Number(req.params.id) } });
    if (!complaint) throw notFound('Complaint not found');

    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, complaint.villageId);

    const officer = await prisma.user.findUnique({ where: { id: req.body.officerId }, include: { role: true } });
    if (!officer || officer.role.level >= scope.level) throw badRequest('Invalid officer');

    const updated = await prisma.complaint.update({
      where: { id: complaint.id },
      data: { assignedOfficerId: officer.id, status: 'ASSIGNED', currentLevel: officer.role.level },
    });
    await audit(req, 'COMPLAINT_ASSIGNED', 'COMPLAINT', complaint.id, null, { officerId: officer.id });
    await notify(officer.id, 'Complaint assigned', `#${complaint.complaintNo} - ${complaint.title}`, 'COMPLAINT', `/complaints/${complaint.id}`);
    res.json({ complaint: await loadComplaint(updated.id) });
  }),
);

router.post(
  '/:id/escalate',
  requirePermission('complaints.escalate'),
  validate(escalateSchema),
  asyncHandler(async (req, res) => {
    const complaint = await prisma.complaint.findUnique({ where: { id: Number(req.params.id) } });
    if (!complaint) throw notFound('Complaint not found');

    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, complaint.villageId);

    // Only the level currently handling it (or above) may escalate it higher.
    if (scope.level > complaint.currentLevel) throw forbidden('Only the current handling level can escalate');

    const toLevel = Math.max(1, complaint.currentLevel - 1);
    const escalation = await prisma.escalation.create({
      data: {
        entity: 'COMPLAINT',
        entityId: complaint.id,
        fromLevel: complaint.currentLevel,
        toLevel,
        fromUserId: req.user!.id,
        reason: req.body.reason,
      },
    });

    const updated = await prisma.complaint.update({
      where: { id: complaint.id },
      data: { status: 'ESCALATED', currentLevel: toLevel, assignedOfficerId: null },
    });

    await audit(req, 'COMPLAINT_ESCALATED', 'COMPLAINT', complaint.id, { currentLevel: complaint.currentLevel }, { currentLevel: toLevel });
    await notifyLevel(toLevel, complaint.provinceId, complaint.districtId, complaint.sectorId, complaint.cellId, complaint.villageId,
      'Complaint escalated to your office', `#${complaint.complaintNo} - ${req.body.reason}`, 'COMPLAINT', `/complaints/${complaint.id}`);

    res.json({ complaint: await loadComplaint(updated.id), escalation });
  }),
);

router.post(
  '/:id/comments',
  validate(commentSchema),
  asyncHandler(async (req, res) => {
    const complaint = await prisma.complaint.findUnique({ where: { id: Number(req.params.id) } });
    if (!complaint) throw notFound('Complaint not found');

    const scope = await getScope(req.user!.id);
    if (scope.level === 6) {
      if (complaint.citizenId !== scope.citizenId) throw notFound('Complaint not found');
    } else {
      const villageIds = await scopeVillageIds(scope);
      assertInScope(villageIds, complaint.villageId);
    }

    const comment = await prisma.complaintComment.create({
      data: { complaintId: complaint.id, userId: req.user!.id, comment: req.body.comment },
      include: { user: { select: { id: true, fullName: true, role: { select: { name: true } } } } },
    });
    await audit(req, 'COMPLAINT_COMMENT', 'COMPLAINT', complaint.id);
    res.status(201).json({ comment });
  }),
);

router.post(
  '/:id/feedback',
  validate(feedbackSchema),
  asyncHandler(async (req, res) => {
    const complaint = await prisma.complaint.findUnique({ where: { id: Number(req.params.id) } });
    if (!complaint) throw notFound('Complaint not found');

    const scope = await getScope(req.user!.id);
    if (scope.level !== 6 || complaint.citizenId !== scope.citizenId) {
      throw forbidden('Only the citizen who filed this complaint can give feedback');
    }
    if (!['RESOLVED', 'CLOSED'].includes(complaint.status)) {
      throw badRequest('Feedback is available only after the complaint is resolved');
    }

    const existing = await prisma.complaintFeedback.findUnique({ where: { complaintId: complaint.id } });
    if (existing) throw conflict('You already gave feedback for this complaint');

    const feedback = await prisma.complaintFeedback.create({
      data: {
        complaintId: complaint.id,
        citizenId: scope.citizenId,
        rating: req.body.rating,
        comment: req.body.comment || null,
      },
    });
    await audit(req, 'COMPLAINT_FEEDBACK', 'COMPLAINT', complaint.id, null, { rating: req.body.rating });
    res.status(201).json({ feedback });
  }),
);

/** Internal helper: create a citizen profile when an admin files on behalf. */
async function ensureCitizenProfile(userId: number, villageId: number): Promise<number> {
  const existing = await prisma.citizen.findUnique({ where: { userId } });
  if (existing) return existing.id;
  const citizen = await prisma.citizen.create({ data: { userId, villageId } });
  return citizen.id;
}

export default router;

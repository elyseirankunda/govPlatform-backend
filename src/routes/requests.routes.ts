import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/httpError';
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
  serviceTypeId: z.number().int().positive(),
  title: z.string().min(3).max(200),
  description: z.string().min(10),
  location: z.string().optional().or(z.literal('')),
  villageId: z.number().int().positive(),
});

const statusSchema = z.object({
  status: z.enum(['SUBMITTED', 'RECEIVED', 'UNDER_REVIEW', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']),
  resolution: z.string().optional(),
});

const assignSchema = z.object({ officerId: z.number().int().positive() });
const escalateSchema = z.object({ reason: z.string().min(5) });

async function loadRequest(id: number) {
  const request = await prisma.serviceRequest.findUnique({
    where: { id },
    include: {
      serviceType: true,
      citizen: { include: { user: { select: { fullName: true } }, village: true } },
      assignedOfficer: { select: { id: true, fullName: true } },
      village: { include: { cell: { include: { sector: { include: { district: { include: { province: true } } } } } } } },
    },
  });
  if (!request) return request;
  const [escalations, attachments] = await Promise.all([
    prisma.escalation.findMany({
      where: { entity: 'SERVICE_REQUEST', entityId: id },
      include: { fromUser: { select: { fullName: true } }, toUser: { select: { fullName: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.attachment.findMany({
      where: { entity: 'SERVICE_REQUEST', entityId: id },
      include: { uploadedBy: { select: { fullName: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return { ...request, escalations, attachments };
}

router.get(
  '/types',
  asyncHandler(async (_req, res) => {
    const items = await prisma.serviceType.findMany({ orderBy: { name: 'asc' } });
    res.json({ items });
  }),
);

router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const data = req.body;
    const scope = await getScope(req.user!.id);

    if (scope.level === 6) {
      if (!scope.citizenId) throw forbidden('Citizen profile not found');
      if (scope.villageId !== data.villageId) throw forbidden('You can only submit requests for your own location');
    } else {
      const villageIds = await scopeVillageIds(scope);
      assertInScope(villageIds, data.villageId);
    }

    const village = await prisma.village.findUnique({
      where: { id: data.villageId },
      include: { cell: { include: { sector: { include: { district: true } } } } },
    });
    if (!village) throw notFound('Village not found');

    const existing = await prisma.citizen.findUnique({ where: { userId: req.user!.id } });
    const citizenId = scope.level === 6 ? scope.citizenId! : (existing?.id ?? (await prisma.citizen.create({ data: { userId: req.user!.id, villageId: village.id } })).id);

    const request = await prisma.serviceRequest.create({
      data: {
        citizenId,
        serviceTypeId: data.serviceTypeId,
        title: data.title,
        description: data.description,
        location: data.location || null,
        villageId: village.id,
        cellId: village.cellId,
        sectorId: village.cell.sectorId,
        districtId: village.cell.sector.districtId,
        provinceId: village.cell.sector.district.provinceId,
        status: 'SUBMITTED',
        currentLevel: 5,
      },
    });

    await audit(req, 'SERVICE_REQUEST_CREATED', 'SERVICE_REQUEST', request.id, null, { title: data.title });
    await notifyLevel(5, request.provinceId, request.districtId, request.sectorId, request.cellId, request.villageId,
      'New service request', `#${request.requestNo} - ${request.title}`, 'SERVICE_REQUEST', `/requests/${request.id}`);
    res.status(201).json({ request: await loadRequest(request.id) });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    const { page, limit, skip } = parsePagination(req.query as any);

    let where: any = {};
    if (scope.level === 6) {
      where.citizenId = scope.citizenId;
    } else {
      const villageIds = await scopeVillageIds(scope);
      where.villageId = { in: villageIds };
    }
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.serviceTypeId) where.serviceTypeId = Number(req.query.serviceTypeId);
    if (req.query.q) {
      where.OR = [{ title: { contains: String(req.query.q) } }, { requestNo: { contains: String(req.query.q) } }];
    }

    if (String(req.query.export).toLowerCase() === 'csv') {
      const rows = await prisma.serviceRequest.findMany({
        where,
        include: { serviceType: true, citizen: { include: { user: { select: { fullName: true } } } }, village: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      const csv = toCsv(
        ['Request No', 'Title', 'Service Type', 'Status', 'Citizen', 'Village', 'Created'],
        rows.map((r) => [r.requestNo, r.title, r.serviceType.name, r.status, r.citizen.user.fullName, r.village.name, r.createdAt.toISOString()]),
      );
      return sendCsv(res, 'requests.csv', csv);
    }

const orderBy = sortBy(req.query.sort, {
      oldest: { createdAt: 'asc' },
      status: [{ status: 'asc' }, { createdAt: 'desc' }],
    });

    const [total, items] = await Promise.all([
      prisma.serviceRequest.count({ where }),
      prisma.serviceRequest.findMany({
        where,
        include: {
          serviceType: true,
          citizen: { include: { user: { select: { fullName: true } } } },
          village: { select: { id: true, name: true } },
          assignedOfficer: { select: { id: true, fullName: true } },
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
    const request = await loadRequest(Number(req.params.id));
    if (!request) throw notFound('Request not found');

    if (scope.level === 6) {
      if (request.citizenId !== scope.citizenId) throw notFound('Request not found');
    } else {
      const villageIds = await scopeVillageIds(scope);
      assertInScope(villageIds, request.villageId);
    }
    res.json({ request });
  }),
);

router.put(
  '/:id/status',
  requirePermission('requests.manage'),
  validate(statusSchema),
  asyncHandler(async (req, res) => {
    const request = await prisma.serviceRequest.findUnique({ where: { id: Number(req.params.id) } });
    if (!request) throw notFound('Request not found');

    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, request.villageId);

    const data: any = { status: req.body.status };
    if (['RESOLVED', 'CLOSED'].includes(req.body.status)) {
      data.resolution = req.body.resolution;
      data.resolutionDate = new Date();
    }

    const updated = await prisma.serviceRequest.update({ where: { id: request.id }, data });
    await audit(req, `SERVICE_REQUEST_${req.body.status}`, 'SERVICE_REQUEST', request.id, { status: request.status }, { status: req.body.status });

    const citizen = await prisma.citizen.findUnique({ where: { id: request.citizenId } });
    if (citizen) {
      await notify(citizen.userId, 'Service request updated', `Your request #${request.requestNo} is now ${req.body.status}`, 'SERVICE_REQUEST', `/requests/${request.id}`);
    }
    res.json({ request: await loadRequest(updated.id) });
  }),
);

router.post(
  '/:id/assign',
  requirePermission('requests.manage'),
  validate(assignSchema),
  asyncHandler(async (req, res) => {
    const request = await prisma.serviceRequest.findUnique({ where: { id: Number(req.params.id) } });
    if (!request) throw notFound('Request not found');

    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, request.villageId);

    const officer = await prisma.user.findUnique({ where: { id: req.body.officerId }, include: { role: true } });
    if (!officer || officer.role.level >= scope.level) throw badRequest('Invalid officer');

    const updated = await prisma.serviceRequest.update({
      where: { id: request.id },
      data: { assignedOfficerId: officer.id, status: 'ASSIGNED', currentLevel: officer.role.level },
    });
    await audit(req, 'SERVICE_REQUEST_ASSIGNED', 'SERVICE_REQUEST', request.id, null, { officerId: officer.id });
    await notify(officer.id, 'Service request assigned', `#${request.requestNo} - ${request.title}`, 'SERVICE_REQUEST', `/requests/${request.id}`);
    res.json({ request: await loadRequest(updated.id) });
  }),
);

router.post(
  '/:id/escalate',
  requirePermission('requests.manage'),
  validate(escalateSchema),
  asyncHandler(async (req, res) => {
    const request = await prisma.serviceRequest.findUnique({ where: { id: Number(req.params.id) } });
    if (!request) throw notFound('Request not found');

    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, request.villageId);
    if (scope.level > request.currentLevel) throw forbidden('Only the current handling level can escalate');

    const toLevel = Math.max(1, request.currentLevel - 1);
    const escalation = await prisma.escalation.create({
      data: {
        entity: 'SERVICE_REQUEST',
        entityId: request.id,
        fromLevel: request.currentLevel,
        toLevel,
        fromUserId: req.user!.id,
        reason: req.body.reason,
      },
    });

    const updated = await prisma.serviceRequest.update({
      where: { id: request.id },
      data: { status: 'ESCALATED', currentLevel: toLevel, assignedOfficerId: null },
    });
    await audit(req, 'SERVICE_REQUEST_ESCALATED', 'SERVICE_REQUEST', request.id, { currentLevel: request.currentLevel }, { currentLevel: toLevel });
    await notifyLevel(toLevel, request.provinceId, request.districtId, request.sectorId, request.cellId, request.villageId,
      'Service request escalated', `#${request.requestNo} - ${req.body.reason}`, 'SERVICE_REQUEST', `/requests/${request.id}`);

    res.json({ request: await loadRequest(updated.id), escalation });
  }),
);

export default router;

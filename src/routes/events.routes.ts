import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, forbidden, notFound } from '../lib/httpError';
import { validate } from '../middleware/validate';
import { authenticate, requirePermission } from '../middleware/auth';
import { audit } from '../middleware/audit';
import { getScope, scopeVillageIds, assertInScope } from '../services/scope.service';
import { parsePagination, pageResponse } from '../utils/pagination';

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(5),
  eventDate: z.string().min(1),
  location: z.string().optional().or(z.literal('')),
  organizer: z.string().optional().or(z.literal('')),
  villageId: z.number().int().positive().optional(),
  cellId: z.number().int().positive().optional(),
  sectorId: z.number().int().positive().optional(),
  districtId: z.number().int().positive().optional(),
  provinceId: z.number().int().positive().optional(),
});

const updateSchema = z.object({
  status: z.enum(['PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
  report: z.string().optional(),
  description: z.string().min(5).optional(),
});

/** Events visible to a user: same-village or below + any within scope. */
function visibleScope(scope: any): any {
  if (scope.level === 6) {
    return scope.villageId ? { villageId: scope.villageId } : { id: -1 };
  }
  return {
    OR: [
      scope.districtId ? { districtId: scope.districtId } : {},
      scope.sectorId ? { sectorId: scope.sectorId } : {},
      scope.cellId ? { cellId: scope.cellId } : {},
      scope.villageId ? { villageId: scope.villageId } : {},
    ].filter((o) => Object.keys(o).length > 0),
  };
}

router.post(
  '/',
  requirePermission('events.manage'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    if (scope.level === 6) throw forbidden('Citizens cannot create events');

    const data = req.body;
    let deepest: { field: string; value: number } | null = null;
    if (data.villageId) deepest = { field: 'villageId', value: data.villageId };
    else if (data.cellId) deepest = { field: 'cellId', value: data.cellId };
    else if (data.sectorId) deepest = { field: 'sectorId', value: data.sectorId };
    else if (data.districtId) deepest = { field: 'districtId', value: data.districtId };
    else deepest = { field: 'provinceId', value: scope.provinceId! };

    const villageIds = await scopeVillageIds(scope);
    let sampleVillageId: number | null = null;
    if (deepest.field === 'villageId') sampleVillageId = deepest.value;
    else if (deepest.field === 'cellId') sampleVillageId = (await prisma.village.findFirst({ where: { cellId: deepest.value } }))?.id ?? null;
    else if (deepest.field === 'sectorId') sampleVillageId = (await prisma.village.findFirst({ where: { cell: { sectorId: deepest.value } } }))?.id ?? null;
    else if (deepest.field === 'districtId') sampleVillageId = (await prisma.village.findFirst({ where: { cell: { sector: { districtId: deepest.value } } } }))?.id ?? null;

    if (sampleVillageId) assertInScope(villageIds, sampleVillageId);

    const event = await prisma.event.create({
      data: {
        title: data.title,
        description: data.description,
        eventDate: new Date(data.eventDate),
        location: data.location || null,
        organizer: data.organizer || null,
        provinceId: scope.provinceId,
        districtId: data.districtId ?? (data.sectorId || data.cellId || data.villageId ? scope.districtId : undefined),
        sectorId: data.sectorId ?? (data.cellId || data.villageId ? scope.sectorId : undefined),
        cellId: data.cellId ?? (data.villageId ? scope.cellId : undefined),
        villageId: data.villageId ?? undefined,
        status: 'PLANNED',
      },
    });

    await audit(req, 'EVENT_CREATED', 'EVENT', event.id, null, { title: data.title });
    res.status(201).json({ event });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    const { page, limit, skip } = parsePagination(req.query as any);

    const where = { ...visibleScope(scope) };
    if (req.query.status) where.status = String(req.query.status);

    const [total, items] = await Promise.all([
      prisma.event.count({ where }),
      prisma.event.findMany({ where, orderBy: { eventDate: 'desc' }, skip, take: limit }),
    ]);
    res.json(pageResponse(items, total, page, limit));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    const event = await prisma.event.findUnique({
      where: { id: Number(req.params.id) },
      include: { participants: true },
    });
    if (!event) throw notFound('Event not found');
    const attachments = await prisma.attachment.findMany({
      where: { entity: 'EVENT', entityId: event.id },
      include: { uploadedBy: { select: { fullName: true } } },
      orderBy: { createdAt: 'asc' },
    });

    // Visibility: citizen only within own village; admin within own scope
    const allowed =
      scope.level === 6
        ? event.villageId === scope.villageId
        : event.districtId === scope.districtId || event.sectorId === scope.sectorId || event.cellId === scope.cellId || event.villageId === scope.villageId;
    if (!allowed && scope.level !== 1) {
      if (!(event.districtId === scope.provinceId)) throw notFound('Event not found');
    }
    res.json({ event: { ...event, attachments } });
  }),
);

router.put(
  '/:id',
  requirePermission('events.manage'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const event = await prisma.event.findUnique({ where: { id: Number(req.params.id) } });
    if (!event) throw notFound('Event not found');
    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    if (event.villageId) assertInScope(villageIds, event.villageId);
    else if (scope.level === 6) throw forbidden();

    const updated = await prisma.event.update({ where: { id: event.id }, data: req.body });
    await audit(req, 'EVENT_UPDATED', 'EVENT', event.id, null, req.body);
    res.json({ event: updated });
  }),
);

router.post(
  '/:id/register',
  asyncHandler(async (req, res) => {
    const event = await prisma.event.findUnique({ where: { id: Number(req.params.id) } });
    if (!event) throw notFound('Event not found');

    const scope = await getScope(req.user!.id);
    if (scope.level === 6) {
      if (event.villageId !== scope.villageId) throw forbidden('You can only register for events in your village');
      const existing = await prisma.eventParticipant.findFirst({ where: { eventId: event.id, citizenId: scope.citizenId! } });
      if (existing) return res.json({ message: 'Already registered' });
      await prisma.eventParticipant.create({ data: { eventId: event.id, citizenId: scope.citizenId! } });
    } else {
      const villageIds = await scopeVillageIds(scope);
      if (event.villageId) assertInScope(villageIds, event.villageId);
      await prisma.eventParticipant.create({ data: { eventId: event.id, name: req.user!.fullName } });
    }
    res.status(201).json({ message: 'Registered for event' });
  }),
);

export default router;

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
import { sortBy } from '../utils/sort';

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().optional().or(z.literal('')),
  meetingDate: z.string().min(1),
  location: z.string().optional().or(z.literal('')),
  agenda: z.string().optional().or(z.literal('')),
  organizer: z.string().optional().or(z.literal('')),
  villageId: z.number().int().positive().optional(),
  cellId: z.number().int().positive().optional(),
  sectorId: z.number().int().positive().optional(),
  districtId: z.number().int().positive().optional(),
});

const updateSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().optional(),
  meetingDate: z.string().optional(),
  location: z.string().optional(),
  agenda: z.string().optional(),
  minutes: z.string().optional(),
  status: z.enum(['PLANNED', 'HELD', 'CANCELLED']).optional(),
});

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
  requirePermission('meetings.manage'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    if (scope.level === 6) throw forbidden('Citizens cannot create meetings');

    const data = req.body;
    const villageIds = await scopeVillageIds(scope);

    let sampleVillageId: number | null = null;
    if (data.villageId) {
      sampleVillageId = data.villageId;
    } else if (data.cellId) {
      sampleVillageId = (await prisma.village.findFirst({ where: { cellId: data.cellId } }))?.id ?? null;
    } else if (data.sectorId) {
      sampleVillageId = (await prisma.village.findFirst({ where: { cell: { sectorId: data.sectorId } } }))?.id ?? null;
    } else if (data.districtId) {
      sampleVillageId = (await prisma.village.findFirst({ where: { cell: { sector: { districtId: data.districtId } } } }))?.id ?? null;
    }
    if (sampleVillageId) assertInScope(villageIds, sampleVillageId);

    const meeting = await prisma.meeting.create({
      data: {
        title: data.title,
        description: data.description || null,
        meetingDate: new Date(data.meetingDate),
        location: data.location || null,
        agenda: data.agenda || null,
        organizer: data.organizer || null,
        provinceId: scope.provinceId,
        districtId: data.districtId ?? (data.sectorId || data.cellId || data.villageId ? scope.districtId : undefined),
        sectorId: data.sectorId ?? (data.cellId || data.villageId ? scope.sectorId : undefined),
        cellId: data.cellId ?? (data.villageId ? scope.cellId : undefined),
        villageId: data.villageId ?? undefined,
        status: 'PLANNED',
      },
    });
    await audit(req, 'MEETING_CREATED', 'MEETING', meeting.id, null, { title: data.title });
    const targetLevel = meeting.villageId ? 5 : meeting.cellId ? 4 : meeting.sectorId ? 3 : meeting.districtId ? 2 : 1;
    await notifyLevel(
      targetLevel,
      meeting.provinceId ?? 0,
      meeting.districtId ?? 0,
      meeting.sectorId ?? 0,
      meeting.cellId ?? 0,
      meeting.villageId ?? 0,
      'New meeting scheduled',
      `${meeting.title} · ${new Date(meeting.meetingDate).toLocaleString()}`,
      'MEETING',
      `/meetings/${meeting.id}`,
    );
    res.status(201).json({ meeting });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    const { page, limit, skip } = parsePagination(req.query as any);
    const where = { ...visibleScope(scope) };
    if (req.query.status) where.status = String(req.query.status);
    const orderBy = sortBy(req.query.sort, {
      oldest: { meetingDate: 'asc' },
      name: { title: 'asc' },
    });

    const [total, items] = await Promise.all([
      prisma.meeting.count({ where }),
      prisma.meeting.findMany({ where, orderBy, skip, take: limit }),
    ]);
    res.json(pageResponse(items, total, page, limit));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const meeting = await prisma.meeting.findUnique({ where: { id: Number(req.params.id) } });
    if (!meeting) throw notFound('Meeting not found');
    res.json({ meeting });
  }),
);

router.put(
  '/:id',
  requirePermission('meetings.manage'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const meeting = await prisma.meeting.findUnique({ where: { id: Number(req.params.id) } });
    if (!meeting) throw notFound('Meeting not found');

    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    if (meeting.villageId) assertInScope(villageIds, meeting.villageId);
    else if (scope.level === 6) throw forbidden();

    const data: any = { ...req.body };
    if (data.meetingDate) data.meetingDate = new Date(data.meetingDate);
    if (data.status === 'HELD') data.heldById = req.user!.id;

    const updated = await prisma.meeting.update({ where: { id: meeting.id }, data });
    await audit(req, 'MEETING_UPDATED', 'MEETING', meeting.id, null, req.body);
    res.json({ meeting: updated });
  }),
);

router.delete(
  '/:id',
  requirePermission('meetings.manage'),
  asyncHandler(async (req, res) => {
    const meeting = await prisma.meeting.findUnique({ where: { id: Number(req.params.id) } });
    if (!meeting) throw notFound('Meeting not found');
    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    if (meeting.villageId) assertInScope(villageIds, meeting.villageId);

    await prisma.meeting.delete({ where: { id: meeting.id } });
    await audit(req, 'MEETING_DELETED', 'MEETING', meeting.id);
    res.json({ message: 'Meeting deleted' });
  }),
);

export default router;
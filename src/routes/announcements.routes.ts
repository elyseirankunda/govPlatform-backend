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
import { sortBy } from '../utils/sort';

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  title: z.string().min(3).max(200),
  content: z.string().min(5),
  targetLevel: z.number().int().min(2).max(6), // levels below the author
  scopeAll: z.boolean().default(true),
  provinceId: z.number().int().optional(),
  districtId: z.number().int().optional(),
  sectorId: z.number().int().optional(),
  cellId: z.number().int().optional(),
  villageId: z.number().int().optional(),
  expirationDate: z.string().optional(),
  publicationDate: z.string().optional(),
});

const statusSchema = z.object({ status: z.enum(['DRAFT', 'PUBLISHED', 'EXPIRED', 'ARCHIVED']) });

/** Chain-prefix visibility check. */
function chainMatches(a: any, c: any): boolean {
  if (a.provinceId && a.provinceId !== c.provinceId) return false;
  if (a.districtId && a.districtId !== c.districtId) return false;
  if (a.sectorId && a.sectorId !== c.sectorId) return false;
  if (a.cellId && a.cellId !== c.cellId) return false;
  if (a.villageId && a.villageId !== c.villageId) return false;
  return true;
}

function isVisible(announcement: any, scope: any): boolean {
  const chain = {
    provinceId: scope.provinceId,
    districtId: scope.districtId,
    sectorId: scope.sectorId,
    cellId: scope.cellId,
    villageId: scope.villageId,
  };

  if (!chainMatches(announcement, chain)) return false;

  const target = announcement.targetLevel;
  if (target === 6) {
    // Everyone (admins + citizens) inside the subtree
    return scope.level >= 1;
  }
  // target is an admin level: only admins at that level or above see it
  return scope.level <= target;
}

router.post(
  '/',
  requirePermission('announcements.create'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    if (scope.level === 6) throw forbidden('Citizens cannot publish announcements');

    const data = req.body;
    if (data.targetLevel <= scope.level) {
      throw badRequest('You can only announce to levels below your own');
    }

    // The selected target subtree must be within the author's scope.
    let selectedVillageId = data.villageId ?? null;
    if (!selectedVillageId && data.cellId) {
      selectedVillageId = (await prisma.village.findFirst({ where: { cellId: data.cellId } }))?.id ?? null;
    }
    if (!selectedVillageId && data.sectorId) {
      selectedVillageId = (await prisma.village.findFirst({ where: { cell: { sectorId: data.sectorId } } }))?.id ?? null;
    }
    if (!selectedVillageId && data.districtId) {
      selectedVillageId = (await prisma.village.findFirst({ where: { cell: { sector: { districtId: data.districtId } } } }))?.id ?? null;
    }

    if (selectedVillageId) {
      const villageIds = await scopeVillageIds(scope);
      assertInScope(villageIds, selectedVillageId);
    }

    // Validate the provided target unit belongs to the author's scope chain.
    const targetUnit = data.villageId
      ? await prisma.village.findUnique({ where: { id: data.villageId }, include: { cell: true } })
      : data.cellId
      ? await prisma.cell.findUnique({ where: { id: data.cellId }, include: { sector: true } })
      : data.sectorId
      ? await prisma.sector.findUnique({ where: { id: data.sectorId }, include: { district: true } })
      : data.districtId
      ? await prisma.district.findUnique({ where: { id: data.districtId }, include: { province: true } })
      : null;

    if (targetUnit) {
      const t = targetUnit as any;
      const chain = t.village
        ? { provinceId: t.cell.sector.district.provinceId, districtId: t.cell.sector.districtId, sectorId: t.cell.sectorId, cellId: t.cellId, villageId: t.id }
        : t.cell
        ? { provinceId: t.cell.sector.district.provinceId, districtId: t.cell.sector.districtId, sectorId: t.cell.sectorId, cellId: t.id, villageId: null }
        : t.sector
        ? { provinceId: t.sector.district.provinceId, districtId: t.sector.districtId, sectorId: t.id, cellId: null, villageId: null }
        : { provinceId: t.district.provinceId, districtId: t.id, sectorId: null, cellId: null, villageId: null };
      const scopeChain = { provinceId: scope.provinceId, districtId: scope.districtId, sectorId: scope.sectorId, cellId: scope.cellId, villageId: scope.villageId };
      if (!chainMatches(chain as any, scopeChain)) {
        throw forbidden('Target unit is outside your jurisdiction');
      }
    }

    const announcement = await prisma.announcement.create({
      data: {
        title: data.title,
        content: data.content,
        authorId: req.user!.id,
        targetLevel: data.targetLevel,
        scopeAll: data.scopeAll,
        provinceId: data.provinceId ?? (data.scopeAll ? scope.provinceId : undefined),
        districtId: data.districtId ?? undefined,
        sectorId: data.sectorId ?? undefined,
        cellId: data.cellId ?? undefined,
        villageId: data.villageId ?? undefined,
        status: data.publicationDate && new Date(data.publicationDate) > new Date() ? 'SCHEDULED' : 'PUBLISHED',
        publicationDate: data.publicationDate ? new Date(data.publicationDate) : new Date(),
        expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
      },
      include: { author: { select: { fullName: true } } },
    });

    await audit(req, 'ANNOUNCEMENT_CREATED', 'ANNOUNCEMENT', announcement.id, null, { title: data.title });

    // Notify the target level officers in the subtree.
    const deepest = announcement.villageId ?? announcement.cellId ?? announcement.sectorId ?? announcement.districtId ?? announcement.provinceId;
    if (deepest) {
      await notifyLevel(data.targetLevel, announcement.provinceId ?? scope.provinceId!, announcement.districtId ?? scope.districtId!, announcement.sectorId ?? scope.sectorId!, announcement.cellId ?? scope.cellId!, announcement.villageId ?? scope.villageId!,
        'New announcement', data.title, 'ANNOUNCEMENT', `/announcements/${announcement.id}`);
    }

    res.status(201).json({ announcement });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    const { page, limit, skip } = parsePagination(req.query as any);

    const recent = await prisma.announcement.findMany({
      where: {
        status: req.query.status
          ? String(req.query.status)
          : scope.level < 6
          ? { in: ['PUBLISHED', 'SCHEDULED'] }
          : 'PUBLISHED',
        ...(req.query.q ? { title: { contains: String(req.query.q) } } : {}),
      },
      include: { author: { select: { id: true, fullName: true } } },
      orderBy: sortBy(req.query.sort, {
        oldest: { publicationDate: 'asc' },
        title: { title: 'asc' },
      }),
      take: 500,
    });

    const visible = recent
      .filter((a) => isVisible(a, scope))
      .filter((a) => {
        const now = new Date();
        if (a.status === 'SCHEDULED' && a.publicationDate <= now) {
          void prisma.announcement.update({ where: { id: a.id }, data: { status: 'PUBLISHED' } });
          return true;
        }
        if (a.status === 'SCHEDULED' && scope.level === 6) return false;
        if (a.expirationDate && a.expirationDate < now) {
          if (a.status === 'PUBLISHED') void prisma.announcement.update({ where: { id: a.id }, data: { status: 'EXPIRED' } });
          return false;
        }
        return true;
      });

    const total = visible.length;
    const items = visible.slice(skip, skip + limit);
    res.json(pageResponse(items, total, page, limit));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    const announcement = await prisma.announcement.findUnique({
      where: { id: Number(req.params.id) },
      include: { author: { select: { id: true, fullName: true } } },
    });
    if (!announcement) throw notFound('Announcement not found');
    if (announcement.authorId !== req.user!.id && !isVisible(announcement, scope)) {
      throw notFound('Announcement not found');
    }
    const attachments = await prisma.attachment.findMany({
      where: { entity: 'ANNOUNCEMENT', entityId: announcement.id },
      include: { uploadedBy: { select: { fullName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ announcement: { ...announcement, attachments } });
  }),
);

router.put(
  '/:id/status',
  requirePermission('announcements.create'),
  validate(statusSchema),
  asyncHandler(async (req, res) => {
    const announcement = await prisma.announcement.findUnique({ where: { id: Number(req.params.id) } });
    if (!announcement) throw notFound('Announcement not found');
    if (announcement.authorId !== req.user!.id) throw forbidden('Only the author can change status');

    const updated = await prisma.announcement.update({ where: { id: announcement.id }, data: { status: req.body.status } });
    await audit(req, `ANNOUNCEMENT_${req.body.status}`, 'ANNOUNCEMENT', announcement.id, { status: announcement.status }, { status: req.body.status });
    if (req.body.status === 'PUBLISHED') {
      await notifyLevel(
        announcement.targetLevel,
        announcement.provinceId ?? 0,
        announcement.districtId ?? 0,
        announcement.sectorId ?? 0,
        announcement.cellId ?? 0,
        announcement.villageId ?? 0,
        'New announcement',
        announcement.title,
        'ANNOUNCEMENT',
        `/announcements/${announcement.id}`,
      );
    }
    res.json({ announcement: updated });
  }),
);

export default router;

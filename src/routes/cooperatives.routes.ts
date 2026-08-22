import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/httpError';
import { validate } from '../middleware/validate';
import { authenticate, requirePermission } from '../middleware/auth';
import { audit } from '../middleware/audit';
import { getScope, scopeVillageIds, assertInScope } from '../services/scope.service';
import { parsePagination, pageResponse } from '../utils/pagination';
import { sortBy } from '../utils/sort';

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  name: z.string().min(3).max(200),
  description: z.string().optional().or(z.literal('')),
  activity: z.string().optional().or(z.literal('')),
  leaderName: z.string().optional().or(z.literal('')),
  membersCount: z.number().int().min(0).default(0),
  villageId: z.number().int().positive(),
});

const updateSchema = z.object({
  name: z.string().min(3).max(200).optional(),
  description: z.string().optional(),
  activity: z.string().optional(),
  leaderName: z.string().optional(),
  membersCount: z.number().int().min(0).optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    if (scope.level === 6) throw forbidden('Citizens cannot view cooperatives');
    const villageIds = await scopeVillageIds(scope);
    const { page, limit, skip } = parsePagination(req.query as any);

    const where: any = { villageId: { in: villageIds } };
    if (req.query.q) where.name = { contains: String(req.query.q) };

    const [total, items] = await Promise.all([
      prisma.cooperative.count({ where }),
      prisma.cooperative.findMany({
        where,
        include: { village: { select: { id: true, name: true } } },
        orderBy: sortBy(req.query.sort, {
          oldest: { createdAt: 'asc' },
          name: { name: 'asc' },
          members: { membersCount: 'desc' },
        }),
        skip,
        take: limit,
      }),
    ]);
    res.json(pageResponse(items, total, page, limit));
  }),
);

router.post(
  '/',
  requirePermission('cooperatives.manage'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    if (scope.level === 6) throw forbidden();

    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, req.body.villageId);

    const cooperative = await prisma.cooperative.create({
      data: {
        name: req.body.name,
        description: req.body.description || null,
        activity: req.body.activity || null,
        leaderName: req.body.leaderName || null,
        membersCount: req.body.membersCount,
        villageId: req.body.villageId,
      },
    });
    await audit(req, 'COOPERATIVE_CREATED', 'COOPERATIVE', cooperative.id, null, { name: req.body.name });
    res.status(201).json({ cooperative });
  }),
);

router.put(
  '/:id',
  requirePermission('cooperatives.manage'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const cooperative = await prisma.cooperative.findUnique({ where: { id: Number(req.params.id) } });
    if (!cooperative) throw notFound('Cooperative not found');

    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, cooperative.villageId);

    const updated = await prisma.cooperative.update({ where: { id: cooperative.id }, data: req.body });
    await audit(req, 'COOPERATIVE_UPDATED', 'COOPERATIVE', cooperative.id, null, req.body);
    res.json({ cooperative: updated });
  }),
);

router.delete(
  '/:id',
  requirePermission('cooperatives.manage'),
  asyncHandler(async (req, res) => {
    const cooperative = await prisma.cooperative.findUnique({ where: { id: Number(req.params.id) } });
    if (!cooperative) throw notFound('Cooperative not found');

    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, cooperative.villageId);

    await prisma.cooperative.delete({ where: { id: cooperative.id } });
    await audit(req, 'COOPERATIVE_DELETED', 'COOPERATIVE', cooperative.id);
    res.json({ message: 'Cooperative deleted' });
  }),
);

export default router;
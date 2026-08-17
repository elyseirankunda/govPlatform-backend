import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler, notFound } from '../lib/httpError';
import { authenticate, requirePermission } from '../middleware/auth';
import { getScope, scopeVillageIds, assertInScope } from '../services/scope.service';
import { parsePagination, pageResponse } from '../utils/pagination';

const router = Router();
router.use(authenticate);

/** List citizens within scope (admins only). Village data is protected. */
router.get(
  '/',
  requirePermission('citizens.view'),
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    if (scope.level === 6) throw notFound();

    const villageIds = await scopeVillageIds(scope);
    const { page, limit, skip } = parsePagination(req.query as any);
    const where: any = { villageId: { in: villageIds } };
    if (req.query.q) {
      where.OR = [
        { user: { fullName: { contains: String(req.query.q) } } },
        { nationalId: { contains: String(req.query.q, ) } },
      ];
    }

    const [total, items] = await Promise.all([
      prisma.citizen.count({ where }),
      prisma.citizen.findMany({
        where,
        include: {
          user: { select: { id: true, fullName: true, email: true, phone: true, createdAt: true } },
          village: { select: { id: true, name: true } },
          household: { select: { id: true, code: true, headName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);
    res.json(pageResponse(items, total, page, limit));
  }),
);

export default router;

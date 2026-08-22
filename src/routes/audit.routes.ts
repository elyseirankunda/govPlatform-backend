import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/httpError';
import { authenticate, atMostLevel, requirePermission } from '../middleware/auth';
import { getScope, scopeVillageIds } from '../services/scope.service';
import { parsePagination, pageResponse } from '../utils/pagination';

const router = Router();
router.use(authenticate, requirePermission('audit.view'), atMostLevel(3));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    const { page, limit, skip } = parsePagination(req.query as any);

    // Only logs concerning entities within the viewer's scope (or user ids within scope).
    const villageIds = await scopeVillageIds(scope);

    const scopedUserIds = await prisma.user.findMany({
      where: { OR: [{ villageId: { in: villageIds } }, { role: { level: 6 } }] },
      select: { id: true },
    });
    const userIds = scopedUserIds.map((u) => u.id).concat(req.user!.id);

    const where: any = {
      AND: [
        {
          OR: [
            { userId: { in: userIds } },
            ...(scope.level === 1
              ? [{ entity: { in: ['COMPLAINT', 'SERVICE_REQUEST', 'REPORT', 'PROJECT', 'ANNOUNCEMENT', 'EVENT'] } }]
              : [{ entity: 'USER' }]),
          ],
        },
      ],
    };

    const q = req.query.q ? String(req.query.q).trim() : '';
    if (q) {
      where.AND.push({
        OR: [
          { action: { contains: q } },
          { entity: { contains: q } },
          { method: { contains: q } },
          { path: { contains: q } },
          { user: { fullName: { contains: q } } },
        ],
      });
    }

    const [total, items] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, fullName: true, role: { select: { name: true } } } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);
    res.json(pageResponse(items, total, page, limit));
  }),
);

export default router;

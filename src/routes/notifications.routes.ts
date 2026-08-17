import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/httpError';
import { authenticate } from '../middleware/auth';
import { parsePagination, pageResponse } from '../utils/pagination';

const router = Router();
router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query as any);
    const where = { userId: req.user!.id };
    const [total, items] = await Promise.all([
      prisma.notification.count({ where }),
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    ]);
    res.json(pageResponse(items, total, page, limit));
  }),
);

router.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const count = await prisma.notification.count({
      where: { userId: req.user!.id, readAt: null },
    });
    res.json({ count });
  }),
);

router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    await prisma.notification.updateMany({
      where: { userId: req.user!.id, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ message: 'All notifications marked as read' });
  }),
);

router.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    await prisma.notification.updateMany({
      where: { id: Number(req.params.id), userId: req.user!.id },
      data: { readAt: new Date() },
    });
    res.json({ message: 'ok' });
  }),
);

export default router;

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/httpError';
import { validate } from '../middleware/validate';
import { authenticate, requirePermission } from '../middleware/auth';
import { audit } from '../middleware/audit';
import { getScope, scopeVillageIds, assertInScope } from '../services/scope.service';
import { notify } from '../services/notify.service';
import { parsePagination, pageResponse } from '../utils/pagination';
import { sortBy } from '../utils/sort';

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().optional().or(z.literal('')),
  assigneeId: z.number().int().positive(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  dueDate: z.string().optional().or(z.literal('')),
});

const updateSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'COMPLETED']).optional(),
  dueDate: z.string().optional().or(z.literal('')),
});

/** Leader-visible tasks: assigned to the leader directly, or to users within scope. */
async function taskWhere(req: any) {
  const scope = await getScope(req.user!.id);
  if (scope.level === 6) return { assigneeId: req.user!.id };
  const villageIds = await scopeVillageIds(scope);
  return {
    OR: [
      { assigneeId: req.user!.id },
      { assignee: { villageId: { in: villageIds } } },
    ],
  };
}

router.get(
  '/assignees',
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    if (scope.level === 6) return res.json({ items: [] });
    const villageIds = await scopeVillageIds(scope);
    const users = await prisma.user.findMany({
      where: { role: { level: { not: 6 } }, villageId: { in: villageIds }, status: 'ACTIVE' },
      select: { id: true, fullName: true, role: { select: { name: true } } },
      orderBy: { fullName: 'asc' },
    });
    res.json({ items: users });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query as any);
    const where = await taskWhere(req);
    if (req.query.status) (where as any).status = String(req.query.status);

    const [total, items] = await Promise.all([
      prisma.task.count({ where }),
      prisma.task.findMany({
        where,
        include: {
          assignee: { select: { id: true, fullName: true, role: { select: { name: true } } } },
          assignedBy: { select: { id: true, fullName: true } },
        },
        orderBy: sortBy(req.query.sort, {
          oldest: { createdAt: 'asc' },
          due: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
          priority: [{ priority: 'asc' }, { createdAt: 'desc' }],
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
  requirePermission('tasks.manage'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    if (scope.level === 6) throw forbidden('Citizens cannot assign tasks');

    const assignee = await prisma.user.findUnique({ where: { id: req.body.assigneeId }, include: { role: true } });
    if (!assignee) throw badRequest('Invalid assignee');
    if (assignee.role.level <= scope.level) throw forbidden('You can only assign tasks to lower-level staff');

    const villageIds = await scopeVillageIds(scope);
    if (assignee.villageId) assertInScope(villageIds, assignee.villageId);

    const task = await prisma.task.create({
      data: {
        title: req.body.title,
        description: req.body.description || null,
        assigneeId: assignee.id,
        assignedById: req.user!.id,
        priority: req.body.priority,
        dueDate: req.body.dueDate ? new Date(req.body.dueDate) : null,
        status: 'OPEN',
      },
    });
    await audit(req, 'TASK_CREATED', 'TASK', task.id, null, { assigneeId: assignee.id, title: req.body.title });
    await notify(assignee.id, 'New task assigned', `${task.title} · Priority ${task.priority}`, 'TASK', `/tasks/${task.id}`);
    res.status(201).json({ task });
  }),
);

router.put(
  '/:id',
  requirePermission('tasks.manage'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const task = await prisma.task.findUnique({ where: { id: Number(req.params.id) } });
    if (!task) throw notFound('Task not found');

    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    if (scope.level !== 6 && task.assigneeId !== req.user!.id) {
      const assignee = await prisma.user.findUnique({ where: { id: task.assigneeId }, include: { role: true } });
      if (assignee?.villageId) assertInScope(villageIds, assignee.villageId);
      else if (assignee && scope.level > assignee.role.level) throw forbidden();
    }

    const data: any = { ...req.body };
    if (data.dueDate !== undefined) data.dueDate = data.dueDate ? new Date(data.dueDate) : null;
    if (data.status === 'COMPLETED') data.completedAt = new Date();
    if (data.status && data.status !== 'COMPLETED') data.completedAt = null;

    const updated = await prisma.task.update({ where: { id: task.id }, data });
    await audit(req, 'TASK_UPDATED', 'TASK', task.id, null, req.body);
    if (task.assignedById && data.status === 'COMPLETED') {
      await notify(task.assignedById, 'Task completed', `${task.title} was marked completed`, 'TASK', `/tasks/${task.id}`);
    }
    res.json({ task: updated });
  }),
);

router.delete(
  '/:id',
  requirePermission('tasks.manage'),
  asyncHandler(async (req, res) => {
    const task = await prisma.task.findUnique({ where: { id: Number(req.params.id) } });
    if (!task) throw notFound('Task not found');
    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    const assignee = await prisma.user.findUnique({ where: { id: task.assigneeId } });
    if (assignee?.villageId) assertInScope(villageIds, assignee.villageId);

    await prisma.task.delete({ where: { id: task.id } });
    await audit(req, 'TASK_DELETED', 'TASK', task.id);
    res.json({ message: 'Task deleted' });
  }),
);

export default router;
import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/httpError';
import { authenticate, requirePermission } from '../middleware/auth';
import { getScope, scopeTree, Scope } from '../services/scope.service';

const router = Router();
router.use(authenticate, requirePermission('dashboard.view'));

/**
 * Where-clause for records that denormalize the full hierarchy
 * (provinceId/districtId/sectorId/cellId/villageId). Scoping by the scope's
 * own unit ids avoids enumerating every village id, which would exceed the
 * SQLite parameter limit (~999) once a province has 2,700+ villages.
 */
function scopeWhere(scope: Scope): any {
  if (scope.level >= 5) {
    return scope.villageId ? { villageId: scope.villageId } : { villageId: -1 };
  }
  const where: any = { provinceId: scope.provinceId ?? -1 };
  if (scope.districtId) where.districtId = scope.districtId;
  if (scope.sectorId) where.sectorId = scope.sectorId;
  if (scope.cellId) where.cellId = scope.cellId;
  return where;
}

/**
 * For models that only carry a villageId (Household, Citizen): scope through
 * the village->cell->sector->district relation chain. Never enumerates village
 * ids, so it is safe at any province size.
 */
function villageScopeWhere(scope: Scope): any {
  if (scope.level >= 5) {
    return scope.villageId ? { villageId: scope.villageId } : { villageId: -1 };
  }
  const districtFilter: any = { ...(scope.provinceId ? { provinceId: scope.provinceId } : {}) };
  if (scope.districtId) districtFilter.id = scope.districtId;
  const sectorFilter: any = { district: districtFilter };
  if (scope.sectorId) sectorFilter.id = scope.sectorId;
  const cellFilter: any = { sector: sectorFilter };
  if (scope.cellId) cellFilter.id = scope.cellId;
  return { village: { cell: cellFilter } };
}

/** Where-clause for a single child unit of the scope (per-unit comparisons). */
function unitWhere(scope: Scope, unit: { id: number; depth: number }): any {
  const where: any = { provinceId: scope.provinceId ?? -1 };
  if (unit.depth === 2) where.districtId = unit.id;
  else if (unit.depth === 3) {
    if (scope.districtId) where.districtId = scope.districtId;
    where.sectorId = unit.id;
  }
  return where;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    const tree = await scopeTree(scope);
    const where = scopeWhere(scope);
    const vWhere = villageScopeWhere(scope);

    // ---------- aggregates ----------
    const [households, citizens, complaints, requests, projects, events, reports, escalations, feedbacks, categories] =
      await Promise.all([
        prisma.household.count({ where: vWhere }),
        prisma.citizen.count({ where: vWhere }),
        prisma.complaint.findMany({
          where,
          select: { id: true, status: true, priority: true, categoryId: true, createdAt: true },
        }),
        prisma.serviceRequest.findMany({
          where,
          select: { id: true, status: true, createdAt: true },
        }),
        prisma.project.findMany({
          where,
          select: { id: true, status: true, budget: true, budgetSpent: true, progress: true, createdAt: true },
        }),
        prisma.event.count({ where: scope.level === 6 ? { villageId: scope.villageId ?? -1 } : visibleEventWhere(scope) }),
        prisma.report.count({ where }),
        prisma.escalation.count({ where: { fromLevel: { gt: 0 }, status: 'PENDING' } }),
        prisma.complaintFeedback.findMany({ where: { complaint: where }, select: { rating: true } }),
        prisma.complaintCategory.findMany({ select: { id: true, name: true } }),
      ]);

    const openComplaints = complaints.filter((c) => !['RESOLVED', 'CLOSED'].includes(c.status)).length;
    const resolvedComplaints = complaints.length - openComplaints;
    const urgentComplaints = complaints.filter((c) => c.priority === 'URGENT' && !['RESOLVED', 'CLOSED'].includes(c.status)).length;
    const openRequests = requests.filter((r) => !['RESOLVED', 'CLOSED'].includes(r.status)).length;
    const resolvedRequests = requests.length - openRequests;
    const activeProjects = projects.filter((p) => p.status === 'IN_PROGRESS').length;
    const plannedProjects = projects.filter((p) => p.status === 'PLANNED').length;
    const completedProjects = projects.filter((p) => p.status === 'COMPLETED').length;
    const totalBudget = projects.reduce((s, p) => s + Number(p.budget || 0), 0);
    const totalSpent = projects.reduce((s, p) => s + Number(p.budgetSpent || 0), 0);
    const avgProgress = projects.length ? Math.round(projects.reduce((s, p) => s + p.progress, 0) / projects.length) : 0;
    const avgSatisfaction = feedbacks.length ? Math.round((feedbacks.reduce((s, f) => s + f.rating, 0) / feedbacks.length) * 20) : 0;

    const recentComplaints = await prisma.complaint.findMany({
      where,
      include: { category: true, village: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 8,
    });

    const recentReports = await prisma.report.findMany({
      where: scope.level === 6 ? { id: -1 } : where,
      include: { author: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 8,
    });

    const recentProjects = await prisma.project.findMany({
      where,
      include: { village: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 8,
    });

    const response: any = {
      scope,
      tree,
      stats: {
        districts: scope.level <= 1 ? tree.children?.length ?? 0 : undefined,
        sectors: countChildren(tree, 1),
        cells: countChildren(tree, 2),
        villages: countChildren(tree, 3),
        households,
        population: citizens,
        openComplaints,
        resolvedComplaints,
        totalComplaints: complaints.length,
        urgentComplaints,
        openRequests,
        resolvedRequests,
        totalRequests: requests.length,
        pendingEscalations: escalations,
        activeProjects,
        plannedProjects,
        completedProjects,
        totalProjects: projects.length,
        totalBudget,
        totalSpent,
        avgProgress,
        avgSatisfaction,
        feedbackCount: feedbacks.length,
        events,
        reports: reports,
      },
      charts: {
        complaintsByStatus: groupBy(complaints, 'status'),
        requestsByStatus: groupBy(requests, 'status'),
        projectsByStatus: groupBy(projects, 'status'),
        complaintsLast30Days: complaintsByDay(complaints),
        requestsLast30Days: complaintsByDay(requests),
        complaintsByCategory: groupByCategory(complaints, categories),
      },
      recent: { complaints: recentComplaints, reports: recentReports, projects: recentProjects },
    };

    // ---------- province/district comparisons ----------
    if (scope.level <= 2) {
      const units = scope.level === 1 ? tree.children! : tree.children![0]?.children ?? [];
      response.performance = [];
      for (const unit of units) {
        const uWhere = unitWhere(scope, { id: unit.id, depth: scope.level === 1 ? 2 : 3 });
        const unitComplaints = await prisma.complaint.findMany({ where: uWhere, select: { status: true } });
        const unitRequests = await prisma.serviceRequest.count({ where: uWhere });
        const unitProjects = await prisma.project.findMany({ where: uWhere, select: { progress: true } });
        const total = unitComplaints.length;
        const resolved = unitComplaints.filter((c) => ['RESOLVED', 'CLOSED'].includes(c.status)).length;
        response.performance.push({
          id: unit.id,
          name: unit.name,
          code: unit.code,
          complaints: total,
          resolutionRate: total ? Math.round((resolved / total) * 100) : 0,
          requests: unitRequests,
          projects: unitProjects.length,
          avgProgress: unitProjects.length ? Math.round(unitProjects.reduce((s, p) => s + p.progress, 0) / unitProjects.length) : 0,
        });
      }
    }

    if (scope.level <= 3) {
      const alerts = await prisma.complaint.findMany({
        where: { ...where, priority: 'URGENT', status: { notIn: ['RESOLVED', 'CLOSED'] } },
        include: { village: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
      response.alerts = alerts;
    }

    res.json(response);
  }),
);

function visibleEventWhere(scope: any) {
  return {
    OR: [
      ...(scope.districtId ? [{ districtId: scope.districtId }] : []),
      ...(scope.sectorId ? [{ sectorId: scope.sectorId }] : []),
      ...(scope.cellId ? [{ cellId: scope.cellId }] : []),
      ...(scope.villageId ? [{ villageId: scope.villageId }] : []),
    ],
  };
}

function countChildren(tree: any, depth: number): number {
  let count = 0;
  const walk = (node: any, d: number) => {
    if (d === depth) {
      count += (node.children?.length ?? 0);
      return;
    }
    for (const child of node.children ?? []) walk(child, d + 1);
  };
  walk(tree, 0);
  return count;
}

function groupBy(items: any[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = item[key];
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function groupByCategory(items: any[], categories: { id: number; name: string }[]): Record<string, number> {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = names.get(item.categoryId) ?? `Category ${item.categoryId}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function complaintsByDay(items: any[]): { date: string; count: number }[] {
  const out: Record<string, number> = {};
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    out[d.toISOString().slice(0, 10)] = 0;
  }
  for (const item of items) {
    const key = new Date(item.createdAt).toISOString().slice(0, 10);
    if (key in out) out[key] += 1;
  }
  return Object.entries(out).map(([date, count]) => ({ date, count }));
}

export default router;

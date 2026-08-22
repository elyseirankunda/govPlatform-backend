import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/httpError';
import { validate } from '../middleware/validate';
import { authenticate, requirePermission } from '../middleware/auth';
import { audit } from '../middleware/audit';
import { getScope, scopeVillageIds, assertInScope, reportsToLevel } from '../services/scope.service';
import { notifyLevel } from '../services/notify.service';
import { parsePagination, pageResponse } from '../utils/pagination';
import { toCsv, sendCsv } from '../utils/csv';
import { sortBy } from '../utils/sort';

const router = Router();
router.use(authenticate);

const LEVEL_MAP: Record<number, 'VILLAGE' | 'CELL' | 'SECTOR' | 'DISTRICT'> = {
  2: 'DISTRICT',
  3: 'SECTOR',
  4: 'CELL',
  5: 'VILLAGE',
};

const createSchema = z.object({ title: z.string().min(3).max(200), content: z.string().min(10) });
const updateSchema = z.object({ title: z.string().min(3).max(200).optional(), content: z.string().min(10).optional() });
const reviewSchema = z.object({
  action: z.enum(['APPROVED', 'REJECTED', 'REVISION']),
  comment: z.string().optional(),
});

function includeForList() {
  return {
    author: { select: { id: true, fullName: true } },
    reviewedBy: { select: { id: true, fullName: true } },
    village: { select: { id: true, name: true } },
  };
}

router.post(
  '/',
  requirePermission('reports.create'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    if (scope.level < 2 || scope.level > 5) throw forbidden('Only administrative officers can create reports');

    const report = await prisma.report.create({
      data: {
        title: req.body.title,
        content: req.body.content,
        level: LEVEL_MAP[scope.level],
        authorId: req.user!.id,
        provinceId: scope.provinceId!,
        districtId: scope.districtId!,
        sectorId: scope.sectorId ?? 0,
        cellId: scope.cellId ?? 0,
        villageId: scope.villageId ?? 0,
        status: 'DRAFT',
      },
    });

    await audit(req, 'REPORT_CREATED', 'REPORT', report.id, null, { title: req.body.title });
    res.status(201).json({ report });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    const { page, limit, skip } = parsePagination(req.query as any);

    let where: any = {};
    if (scope.level === 6) {
      where.id = -1; // citizens have no reports
    } else {
      const villageIds = await scopeVillageIds(scope);
      where = {
        AND: [{ villageId: { in: villageIds } }, { level: { in: Object.values(LEVEL_MAP).filter((l) => LEVEL_MAP[scope.level] === l || scope.level < 5) } }],
      };
      if (scope.level >= 2 && scope.level <= 4) {
        // This level's own reports plus any below
        where.OR = [{ authorId: req.user!.id }, { level: { in: (Object.keys(LEVEL_MAP) as unknown as number[]).filter((k) => Number(k) > scope.level).map((k) => LEVEL_MAP[Number(k)]) } }];
        delete where.AND;
      }
    }
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.level) {
      const lvl = String(req.query.level).toUpperCase();
      if (Array.isArray(where.AND)) where.AND.push({ level: lvl });
      else where.level = lvl;
    }
    if (req.query.q) {
      const q = String(req.query.q);
      where.OR = [
        ...(Array.isArray(where.OR) ? where.OR : []),
        { title: { contains: q } },
        { reportNo: { contains: q } },
      ];
    }

    if (String(req.query.export).toLowerCase() === 'csv') {
      const rows = await prisma.report.findMany({
        where,
        include: { author: { select: { fullName: true } }, village: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      const csv = toCsv(
        ['Report No', 'Title', 'Level', 'Status', 'Author', 'Village', 'Created'],
        rows.map((r) => [r.reportNo, r.title, r.level, r.status, r.author.fullName, r.village?.name ?? '', r.createdAt.toISOString()]),
      );
      return sendCsv(res, 'reports.csv', csv);
    }

    const orderBy = sortBy(req.query.sort, {
      oldest: { createdAt: 'asc' },
      status: [{ status: 'asc' }, { createdAt: 'desc' }],
      title: { title: 'asc' },
    });

    const [total, items] = await Promise.all([
      prisma.report.count({ where }),
      prisma.report.findMany({
        where,
        include: includeForList(),
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
    const report = await prisma.report.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        author: { select: { id: true, fullName: true } },
        reviewedBy: { select: { id: true, fullName: true } },
        reviews: { include: { reviewer: { select: { id: true, fullName: true } } }, orderBy: { createdAt: 'desc' } },
        village: { include: { cell: { include: { sector: { include: { district: { include: { province: true } } } } } } } },
      },
    });
    if (!report) throw notFound('Report not found');
    const attachments = await prisma.attachment.findMany({
      where: { entity: 'REPORT', entityId: report.id },
      include: { uploadedBy: { select: { fullName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const reportWithAttachments = { ...report, attachments };

    if (scope.level === 6) throw notFound('Report not found');
    if (report.authorId === req.user!.id) {
      return res.json({ report: reportWithAttachments });
    }
    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, report.villageId);
    if (report.level !== LEVEL_MAP[scope.level] && scope.level > 4) {
      if (report.authorId !== req.user!.id) throw forbidden('You cannot view this report');
    }
    res.json({ report: reportWithAttachments });
  }),
);

router.put(
  '/:id',
  requirePermission('reports.create'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const report = await prisma.report.findUnique({ where: { id: Number(req.params.id) } });
    if (!report) throw notFound('Report not found');
    if (report.authorId !== req.user!.id) throw forbidden('Only the author can edit this report');
    if (!['DRAFT', 'REVISION'].includes(report.status)) throw badRequest('Only drafts and revision reports can be edited');

    const updated = await prisma.report.update({
      where: { id: report.id },
      data: { ...req.body, version: report.version + (report.status === 'REVISION' ? 0 : 0) },
    });
    await audit(req, 'REPORT_UPDATED', 'REPORT', report.id, null, req.body);
    res.json({ report: updated });
  }),
);

router.post(
  '/:id/submit',
  requirePermission('reports.create'),
  asyncHandler(async (req, res) => {
    const report = await prisma.report.findUnique({ where: { id: Number(req.params.id) } });
    if (!report) throw notFound('Report not found');
    if (report.authorId !== req.user!.id) throw forbidden('Only the author can submit this report');
    if (!['DRAFT', 'REVISION'].includes(report.status)) throw badRequest('Report cannot be submitted in this status');

    const updated = await prisma.report.update({
      where: { id: report.id },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
    });

    const authorLevel = report.level === 'DISTRICT' ? 2 : report.level === 'SECTOR' ? 3 : report.level === 'CELL' ? 4 : 5;
    await notifyLevel(authorLevel - 1, report.provinceId, report.districtId, report.sectorId, report.cellId, report.villageId,
      'Report submitted for review', `${report.title}`, 'REPORT', `/reports/${report.id}`);

    await audit(req, 'REPORT_SUBMITTED', 'REPORT', report.id, { status: report.status }, { status: 'SUBMITTED' });
    res.json({ report: updated });
  }),
);

router.post(
  '/:id/review',
  requirePermission('reports.review'),
  validate(reviewSchema),
  asyncHandler(async (req, res) => {
    const report = await prisma.report.findUnique({ where: { id: Number(req.params.id) } });
    if (!report) throw notFound('Report not found');

    const scope = await getScope(req.user!.id);
    if (report.authorId === req.user!.id) throw forbidden('You cannot review your own report');
    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, report.villageId);

    const reportLevel = report.level === 'DISTRICT' ? 2 : report.level === 'SECTOR' ? 3 : report.level === 'CELL' ? 4 : 5;
    if (scope.level >= reportLevel) throw forbidden('A higher administrative level must review this report');
    if (!['SUBMITTED', 'UNDER_REVIEW'].includes(report.status)) throw badRequest('Report is not awaiting review');

    await prisma.reportReview.create({
      data: { reportId: report.id, reviewerId: req.user!.id, action: req.body.action, comment: req.body.comment },
    });

    const nextStatus = req.body.action === 'APPROVED' ? 'APPROVED' : req.body.action === 'REVISION' ? 'REVISION' : 'REJECTED';
    const updated = await prisma.report.update({
      where: { id: report.id },
      data: { status: nextStatus, reviewedById: req.user!.id, reviewedAt: new Date(), reviewComment: req.body.comment },
    });

    await audit(req, `REPORT_${req.body.action}`, 'REPORT', report.id, { status: report.status }, { status: nextStatus });
    res.json({ report: updated });
  }),
);

router.post(
  '/:id/finalize',
  requirePermission('reports.review'),
  asyncHandler(async (req, res) => {
    const report = await prisma.report.findUnique({ where: { id: Number(req.params.id) } });
    if (!report) throw notFound('Report not found');
    if (!['APPROVED'].includes(report.status)) throw badRequest('Only approved reports can be finalized');

    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, report.villageId);

    const updated = await prisma.report.update({ where: { id: report.id }, data: { status: 'FINALIZED' } });
    await audit(req, 'REPORT_FINALIZED', 'REPORT', report.id, null, { status: 'FINALIZED' });
    res.json({ report: updated });
  }),
);

export default router;

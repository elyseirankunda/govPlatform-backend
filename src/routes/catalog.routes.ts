import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, notFound } from '../lib/httpError';
import { validate } from '../middleware/validate';
import { optionalAuthenticate, authenticate } from '../middleware/auth';
import { getScope } from '../services/scope.service';

const router = Router();

// Public read-only lookups (used by the registration page). A valid token is
// optional: when present, results are scoped to the user's administration area;
// anonymous callers see the full catalog.
router.use(optionalAuthenticate);

const unitIdSchema = z.object({ id: z.coerce.number().int().positive() });

/** List districts. Scoped to the caller's province when authenticated. */
router.get(
  '/districts',
  asyncHandler(async (req, res) => {
    const scope = req.user ? await getScope(req.user.id) : null;
    const districts = await prisma.district.findMany({
      where: scope?.provinceId ? { provinceId: scope.provinceId } : {},
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true, _count: { select: { sectors: true } } },
    });
    res.json({ items: districts });
  }),
);

router.get(
  '/districts/:id/sectors',
  validate(unitIdSchema, 'params'),
  asyncHandler(async (req, res) => {
    const scope = req.user ? await getScope(req.user.id) : null;
    const district = await prisma.district.findUnique({ where: { id: Number(req.params.id) } });
    if (!district) throw notFound('District not found');
    if (scope?.provinceId && district.provinceId !== scope.provinceId) throw notFound('District not found');
    const sectors = await prisma.sector.findMany({
      where: { districtId: district.id },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true, _count: { select: { cells: true } } },
    });
    res.json({ items: sectors });
  }),
);

router.get(
  '/sectors/:id/cells',
  validate(unitIdSchema, 'params'),
  asyncHandler(async (req, res) => {
    const scope = req.user ? await getScope(req.user.id) : null;
    const sector = await prisma.sector.findUnique({ where: { id: Number(req.params.id) } });
    if (!sector) throw notFound('Sector not found');
    if (scope?.districtId && sector.districtId !== scope.districtId) throw notFound('Sector not found');
    const cells = await prisma.cell.findMany({
      where: { sectorId: sector.id },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true, _count: { select: { villages: true } } },
    });
    res.json({ items: cells });
  }),
);

router.get(
  '/cells/:id/villages',
  validate(unitIdSchema, 'params'),
  asyncHandler(async (req, res) => {
    const scope = req.user ? await getScope(req.user.id) : null;
    const cell = await prisma.cell.findUnique({ where: { id: Number(req.params.id) } });
    if (!cell) throw notFound('Cell not found');
    if (scope?.sectorId && cell.sectorId !== scope.sectorId) throw notFound('Cell not found');
    const villages = await prisma.village.findMany({
      where: { cellId: cell.id },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true },
    });
    res.json({ items: villages });
  }),
);

/** Public registration lookup: full chain for a village. */
router.get(
  '/village/:id/chain',
  validate(unitIdSchema, 'params'),
  asyncHandler(async (req, res) => {
    const village = await prisma.village.findUnique({
      where: { id: Number(req.params.id) },
      include: { cell: { include: { sector: { include: { district: { include: { province: true } } } } } } },
    });
    if (!village) throw notFound('Village not found');
    res.json({
      province: village.cell.sector.district.province,
      district: village.cell.sector.district,
      sector: village.cell.sector,
      cell: village.cell,
      village,
    });
  }),
);

/** The full scope tree for the current user (breadcrumbs / admin management). Requires auth. */
router.get(
  '/scope-tree',
  authenticate,
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    res.json({ scope });
  }),
);

export default router;

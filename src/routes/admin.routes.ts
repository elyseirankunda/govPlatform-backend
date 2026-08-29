import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { hashPassword } from '../lib/auth';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../lib/httpError';
import { validate } from '../middleware/validate';
import { authenticate, requirePermission } from '../middleware/auth';
import { audit } from '../middleware/audit';
import { getScope, isWithinScope, scopeVillageIds } from '../services/scope.service';
import { parsePagination, pageResponse } from '../utils/pagination';
import { toCsv, sendCsv } from '../utils/csv';
import { sortBy } from '../utils/sort';

const router = Router();
router.use(authenticate);

const createUserSchema = z.object({
  fullName: z.string().min(2),
  username: z.string().min(3).max(30),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional().or(z.literal('')),
  password: z.string().min(8),
  role: z.enum(['PROVINCE_ADMIN', 'DISTRICT_ADMIN', 'SECTOR_ADMIN', 'CELL_ADMIN', 'VILLAGE_ADMIN']),
  provinceId: z.number().int().positive(),
  districtId: z.number().int().positive().optional(),
  sectorId: z.number().int().positive().optional(),
  cellId: z.number().int().positive().optional(),
  villageId: z.number().int().positive().optional(),
});

const statusSchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE', 'LOCKED', 'SUSPENDED', 'DISABLED', 'EXPIRED', 'PENDING']),
});

const unitCreateSchema = z.object({ name: z.string().min(2), code: z.string().min(2).max(20) });
const unitRenameSchema = z.object({ name: z.string().min(2) });

const householdSchema = z.object({
  villageId: z.number().int().positive(),
  headName: z.string().min(2),
  members: z.number().int().min(1).max(200),
  code: z.string().min(2).max(30),
});

const ROLE_LEVEL: Record<string, number> = {
  SUPER_ADMIN: 0,
  PROVINCE_ADMIN: 1,
  DISTRICT_ADMIN: 2,
  SECTOR_ADMIN: 3,
  CELL_ADMIN: 4,
  VILLAGE_ADMIN: 5,
  CITIZEN: 6,
};

/** Create an administrative account (only a higher-level admin may do this). */
router.post(
  '/users',
  requirePermission('users.manage'),
  validate(createUserSchema),
  asyncHandler(async (req, res) => {
    const creator = await prisma.user.findUnique({ where: { id: req.user!.id }, include: { role: true } });
    if (!creator) throw notFound();

    const targetLevel = ROLE_LEVEL[req.body.role];
    if (creator.role.level >= targetLevel) {
      throw forbidden('You can only create accounts at administrative levels below your own');
    }
    // Only the platform SUPER_ADMIN can provision PROVINCE_ADMIN accounts.
    if (req.body.role === 'PROVINCE_ADMIN' && creator.role.slug !== 'SUPER_ADMIN') {
      throw forbidden('Only the super administrator can create province administrator accounts');
    }

    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);

    // A PROVINCE_ADMIN target is a whole province, not a village.
    const isProvinceAdminTarget = req.body.role === 'PROVINCE_ADMIN';
    if (isProvinceAdminTarget) {
      if (req.body.provinceId !== scope.provinceId) {
        throw forbidden('The target province is outside your jurisdiction');
      }
    } else {
      // The target unit must be within the creator's scope.
      let targetVillageId: number | null = null;
      if (req.body.villageId) {
        targetVillageId = req.body.villageId;
      } else if (req.body.cellId) {
        const v = await prisma.village.findFirst({ where: { cellId: req.body.cellId }, orderBy: { id: 'asc' } });
        targetVillageId = v?.id ?? null;
      } else if (req.body.sectorId) {
        const v = await prisma.village.findFirst({ where: { cell: { sectorId: req.body.sectorId } }, orderBy: { id: 'asc' } });
        targetVillageId = v?.id ?? null;
      } else if (req.body.districtId) {
        const v = await prisma.village.findFirst({ where: { cell: { sector: { districtId: req.body.districtId } } }, orderBy: { id: 'asc' } });
        targetVillageId = v?.id ?? null;
      }

      if (!targetVillageId || !villageIds.includes(targetVillageId)) {
        throw forbidden('The target administrative unit is outside your jurisdiction');
      }

      // Resolve the exact unit ids for the target level.
      const village = await prisma.village.findUnique({
        where: { id: targetVillageId },
        include: { cell: { include: { sector: { include: { district: true } } } } },
      });
      if (!village) throw notFound('Village not found');

      const target: Record<string, number> = {
        provinceId: village.cell.sector.district.provinceId,
        districtId: village.cell.sector.district.id,
        sectorId: village.cell.sector.id,
        cellId: village.cell.id,
        villageId: village.id,
      };

      const existing = await prisma.user.findFirst({ where: { OR: [{ username: req.body.username }, { email: req.body.email || undefined }] } });
      if (existing) throw conflict('Username or email already taken');

      const role = await prisma.role.findUnique({ where: { slug: req.body.role } });
      if (!role) throw badRequest('Invalid role');

      const user = await prisma.user.create({
        data: {
          fullName: req.body.fullName,
          username: req.body.username,
          email: req.body.email || null,
          phone: req.body.phone || null,
          passwordHash: await hashPassword(req.body.password),
          roleId: role.id,
          provinceId: target.provinceId,
          districtId: null,
          sectorId: null,
          cellId: null,
          villageId: null,
          createdById: creator.id,
          mustChangePassword: true,
          // New accounts start PENDING: an authorized admin must activate them.
          status: 'PENDING',
        },
        include: { role: true },
      });

      await audit(req, 'ADMIN_CREATE_USER', 'USER', user.id, null, { role: user.role.slug, status: user.status });
      return res.status(201).json({
        message: 'Administrative account created. It is pending activation by an authorized administrator.',
        user: publicUser(user),
      });
    }

    // ----- PROVINCE_ADMIN creation path -----
    const existingProvinceAdmin = await prisma.user.findFirst({
      where: { OR: [{ username: req.body.username }, { email: req.body.email || undefined }] },
    });
    if (existingProvinceAdmin) throw conflict('Username or email already taken');

    const paRole = await prisma.role.findUnique({ where: { slug: 'PROVINCE_ADMIN' } });
    if (!paRole) throw badRequest('Invalid role');

    const paUser = await prisma.user.create({
      data: {
        fullName: req.body.fullName,
        username: req.body.username,
        email: req.body.email || null,
        phone: req.body.phone || null,
        passwordHash: await hashPassword(req.body.password),
        roleId: paRole.id,
        provinceId: req.body.provinceId,
        districtId: null,
        sectorId: null,
        cellId: null,
        villageId: null,
        createdById: creator.id,
        mustChangePassword: true,
        status: 'PENDING',
      },
      include: { role: true },
    });

    await audit(req, 'ADMIN_CREATE_USER', 'USER', paUser.id, null, { role: paUser.role.slug, status: paUser.status });
    res.status(201).json({
      message: 'Administrative account created. It is pending activation by an authorized administrator.',
      user: publicUser(paUser),
    });
  }),
);

/** List users within the caller's scope. */
router.get(
  '/users',
  requirePermission('users.manage'),
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    const { page, limit, skip } = parsePagination(req.query as any);

    // Subordinate administrative accounts inside the caller's jurisdiction.
    const where: any = { provinceId: scope.provinceId, role: { level: { not: 6 } } };
    if (scope.level > 0) where.role.level.gt = scope.level;
    if (scope.districtId) where.districtId = scope.districtId;
    if (scope.sectorId) where.sectorId = scope.sectorId;
    if (scope.cellId) where.cellId = scope.cellId;
    if (scope.villageId) where.villageId = scope.villageId;
    if (req.query.q) {
      const q = String(req.query.q);
      where.OR = [
        { fullName: { contains: q } },
        { username: { contains: q } },
        { email: { contains: q } },
      ];
    }

    if (String(req.query.export).toLowerCase() === 'csv') {
      const rows = await prisma.user.findMany({
        where,
        include: { role: true, village: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      const csv = toCsv(
        ['Full Name', 'Username', 'Role', 'Email', 'Phone', 'Village', 'Status'],
        rows.map((u) => [u.fullName, u.username, u.role.name, u.email ?? '', u.phone ?? '', u.village?.name ?? '', u.status]),
      );
      return sendCsv(res, 'users.csv', csv);
    }

    const [total, items] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        include: { role: true, village: { include: { cell: { include: { sector: { include: { district: { include: { province: true } } } } } } } } },
        orderBy: sortBy(req.query.sort, {
          oldest: { createdAt: 'asc' },
          name: { fullName: 'asc' },
          role: [{ role: { name: 'asc' } }, { createdAt: 'desc' }],
        }),
        skip,
        take: limit,
      }),
    ]);

    res.json(pageResponse(items.map(publicUser), total, page, limit));
  }),
);

router.put(
  '/users/:id/status',
  requirePermission('users.manage'),
  validate(statusSchema),
  asyncHandler(async (req, res) => {
    const target = await prisma.user.findUnique({ where: { id: Number(req.params.id) }, include: { role: true } });
    if (!target) throw notFound('User not found');

    const scope = await getScope(req.user!.id);
    if (scope.level >= target.role.level) throw forbidden('You cannot modify this account');
    if (!isWithinScope(scope, target)) throw forbidden('Out of jurisdiction');

    const prev = target.status;
    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { status: req.body.status, failedLoginAttempts: 0, lockedUntil: null },
    });
    await audit(req, req.body.status === 'ACTIVE' && prev === 'PENDING' ? 'ADMIN_ACTIVATE_USER' : 'ADMIN_UPDATE_STATUS', 'USER', target.id, { status: prev }, { status: updated.status });
    res.json({ message: 'Account status updated', status: updated.status });
  }),
);

const resetPasswordSchema = z.object({ password: z.string().min(8) });

/** Admin resets a subordinate's password (forces a change on their next login). */
router.put(
  '/users/:id/password',
  requirePermission('users.manage'),
  validate(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const target = await prisma.user.findUnique({ where: { id: Number(req.params.id) }, include: { role: true } });
    if (!target) throw notFound('User not found');

    const scope = await getScope(req.user!.id);
    if (scope.level >= target.role.level) throw forbidden('You cannot modify this account');
    if (!isWithinScope(scope, target)) throw forbidden('Out of jurisdiction');

    const passwordHash = await hashPassword(req.body.password);
    await prisma.user.update({
      where: { id: target.id },
      data: { passwordHash, mustChangePassword: true, failedLoginAttempts: 0, lockedUntil: null },
    });
    await prisma.session.updateMany({ where: { userId: target.id }, data: { revokedAt: new Date() } });
    await audit(req, 'ADMIN_RESET_PASSWORD', 'USER', target.id);
    res.json({ message: 'Password reset. The officer must change it on next login.' });
  }),
);

// ---------------------------------------------------------------------------
// Administrative unit management (each level manages the level below it)
// ---------------------------------------------------------------------------

/** Create a unit under the caller (level+1). */
router.post(
  '/units',
  requirePermission('units.manage'),
  validate(unitCreateSchema),
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    let created;

    if (scope.level === 1) {
      created = await prisma.district.create({ data: { provinceId: scope.provinceId!, ...req.body } });
    } else if (scope.level === 2) {
      created = await prisma.sector.create({ data: { districtId: scope.districtId!, ...req.body } });
    } else if (scope.level === 3) {
      created = await prisma.sector.findUnique({ where: { id: scope.sectorId! } });
      created = await prisma.cell.create({ data: { sectorId: scope.sectorId!, ...req.body } });
    } else if (scope.level === 4) {
      created = await prisma.village.create({ data: { cellId: scope.cellId!, ...req.body } });
    } else {
      throw forbidden('You cannot create administrative units at this level');
    }

    await audit(req, 'ADMIN_CREATE_UNIT', 'UNIT', created.id, null, req.body);
    res.status(201).json({ message: 'Unit created', unit: created });
  }),
);

router.put(
  '/units/:type/:id',
  requirePermission('units.manage'),
  validate(unitRenameSchema),
  asyncHandler(async (req, res) => {
    const type = req.params.type as 'district' | 'sector' | 'cell' | 'village';
    const id = Number(req.params.id);
    const scope = await getScope(req.user!.id);

    const allowed = {
      district: scope.level === 1,
      sector: scope.level === 2,
      cell: scope.level === 3,
      village: scope.level === 4,
    } as Record<string, boolean>;
    if (!allowed[type]) throw forbidden('You cannot modify this administrative level');

    const updated = await (prisma as any)[type].update({ where: { id }, data: { name: req.body.name } });
    await audit(req, 'ADMIN_RENAME_UNIT', type.toUpperCase(), id, null, { name: req.body.name });
    res.json({ message: 'Unit updated', unit: updated });
  }),
);

router.delete(
  '/units/:type/:id',
  requirePermission('units.manage'),
  asyncHandler(async (req, res) => {
    const type = req.params.type as 'district' | 'sector' | 'cell' | 'village';
    const id = Number(req.params.id);
    const scope = await getScope(req.user!.id);

    const allowed = {
      district: scope.level === 1,
      sector: scope.level === 2,
      cell: scope.level === 3,
      village: scope.level === 4,
    } as Record<string, boolean>;
    if (!allowed[type]) throw forbidden('You cannot delete at this administrative level');

    // Prevent deleting a unit that still has children
    if (type === 'district') {
      const hasChildren = await prisma.sector.findFirst({ where: { districtId: id } });
      if (hasChildren) throw badRequest('Cannot delete: district still has sectors');
    } else if (type === 'sector') {
      const hasChildren = await prisma.cell.findFirst({ where: { sectorId: id } });
      if (hasChildren) throw badRequest('Cannot delete: sector still has cells');
    } else if (type === 'cell') {
      const hasChildren = await prisma.village.findFirst({ where: { cellId: id } });
      if (hasChildren) throw badRequest('Cannot delete: cell still has villages');
    } else if (type === 'village') {
      const hasHouseholds = await prisma.household.findFirst({ where: { villageId: id } });
      if (hasHouseholds) throw badRequest('Cannot delete: village still has households');
    }

    await (prisma as any)[type].delete({ where: { id } });
    await audit(req, 'ADMIN_DELETE_UNIT', type.toUpperCase(), id);
    res.json({ message: 'Unit deleted' });
  }),
);

// ---------------------------------------------------------------------------
// Households
// ---------------------------------------------------------------------------

router.post(
  '/households',
  requirePermission('households.manage'),
  validate(householdSchema),
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    if (!villageIds.includes(req.body.villageId)) throw forbidden('Out of jurisdiction');
    if (scope.level > 4) throw forbidden('Only cell and village administration can register households');

    const existing = await prisma.household.findUnique({ where: { code: req.body.code } });
    if (existing) throw conflict('Household code already exists');

    const household = await prisma.household.create({
      data: {
        villageId: req.body.villageId,
        headName: req.body.headName,
        members: req.body.members,
        code: req.body.code,
        createdById: req.user!.id,
      },
    });
    await audit(req, 'CREATE_HOUSEHOLD', 'HOUSEHOLD', household.id, null, req.body);
    res.status(201).json({ message: 'Household registered', household });
  }),
);

router.get(
  '/households',
  requirePermission('households.manage'),
  asyncHandler(async (req, res) => {
    const scope = await getScope(req.user!.id);
    const villageIds = await scopeVillageIds(scope);
    const { page, limit, skip } = parsePagination(req.query as any);
    const where: any = { villageId: { in: villageIds } };
    if (req.query.q) {
      const q = String(req.query.q);
      where.OR = [
        { code: { contains: q } },
        { headName: { contains: q } },
      ];
    }

    if (String(req.query.export).toLowerCase() === 'csv') {
      const rows = await prisma.household.findMany({
        where,
        include: { village: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      const csv = toCsv(
        ['Code', 'Head Name', 'Members', 'Ubudehe', 'Village'],
        rows.map((h) => [h.code, h.headName, h.members, h.ubudehe ?? '', h.village.name]),
      );
      return sendCsv(res, 'households.csv', csv);
    }

    const [total, items] = await Promise.all([
      prisma.household.count({ where }),
      prisma.household.findMany({
        where,
        include: { village: true },
        orderBy: sortBy(req.query.sort, {
          oldest: { createdAt: 'asc' },
          name: { headName: 'asc' },
          members: { members: 'desc' },
          code: { code: 'asc' },
        }),
        skip,
        take: limit,
      }),
    ]);
    res.json(pageResponse(items, total, page, limit));
  }),
);

function publicUser(u: any) {
  return {
    id: u.id,
    fullName: u.fullName,
    username: u.username,
    email: u.email,
    phone: u.phone,
    profilePhoto: u.profilePhoto,
    role: u.role?.slug,
    roleName: u.role?.name,
    level: u.role?.level,
    status: u.status,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    unit: u.village
      ? {
          province: u.village.cell?.sector?.district?.province,
          district: u.village.cell?.sector?.district,
          sector: u.village.cell?.sector,
          cell: u.village.cell,
          village: u.village,
        }
      : null,
  };
}

export default router;

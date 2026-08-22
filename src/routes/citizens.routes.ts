import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { hashPassword } from '../lib/auth';
import { asyncHandler, notFound, badRequest, conflict } from '../lib/httpError';
import { validate } from '../middleware/validate';
import { authenticate, requirePermission } from '../middleware/auth';
import { audit } from '../middleware/audit';
import { getScope, scopeVillageIds, assertInScope } from '../services/scope.service';
import { parsePagination, pageResponse } from '../utils/pagination';
import { toCsv, sendCsv } from '../utils/csv';
import { sortBy } from '../utils/sort';

const router = Router();
router.use(authenticate);

const citizenCreateSchema = z.object({
  fullName: z.string().min(2, 'Full name is required'),
  username: z.string().min(3).max(30).regex(/^[a-z0-9_.]+$/i, 'Username: letters, numbers, _ .'),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().min(7).optional().or(z.literal('')),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  nationalId: z.string().min(5).optional().or(z.literal('')),
  dateOfBirth: z.string().optional().or(z.literal('')),
  gender: z.string().optional().or(z.literal('')),
  villageId: z.number().int().positive(),
});

const citizenUpdateSchema = z.object({
  fullName: z.string().min(2, 'Full name is required').optional(),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().min(7).optional().or(z.literal('')),
  nationalId: z.string().min(5).optional().or(z.literal('')),
  dateOfBirth: z.string().optional().or(z.literal('')),
  gender: z.string().optional().or(z.literal('')),
  villageId: z.number().int().positive().optional(),
});

const citizenPasswordSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

/** Resolve a village's full hierarchy ids for scoping a citizen account. */
async function resolveVillageChain(villageId: number) {
  const village = await prisma.village.findUnique({
    where: { id: villageId },
    include: { cell: { include: { sector: { include: { district: true } } } } },
  });
  if (!village) throw badRequest('Invalid village');
  return {
    provinceId: village.cell.sector.district.provinceId,
    districtId: village.cell.sector.district.id,
    sectorId: village.cell.sector.id,
    cellId: village.cell.id,
    villageId: village.id,
  };
}

async function findCitizenInScope(req: any) {
  const scope = await getScope(req.user!.id);
  const villageIds = await scopeVillageIds(scope);
  const citizen = await prisma.citizen.findUnique({
    where: { id: Number(req.params.id) },
    include: { user: true },
  });
  if (!citizen) throw notFound('Citizen not found');
  assertInScope(villageIds, citizen.villageId);
  return { citizen, villageIds };
}

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
        { nationalId: { contains: String(req.query.q) } },
        { user: { username: { contains: String(req.query.q) } } },
      ];
    }

    if (String(req.query.export).toLowerCase() === 'csv') {
      const rows = await prisma.citizen.findMany({
        where,
        include: {
          user: { select: { fullName: true, username: true, email: true, phone: true, status: true } },
          village: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      const csv = toCsv(
        ['Full Name', 'Username', 'National ID', 'Gender', 'Village', 'Phone', 'Email', 'Status'],
        rows.map((c) => [c.user.fullName, c.user.username, c.nationalId ?? '', c.gender ?? '', c.village.name, c.user.phone ?? '', c.user.email ?? '', c.user.status]),
      );
      return sendCsv(res, 'citizens.csv', csv);
    }

    const [total, items] = await Promise.all([
      prisma.citizen.count({ where }),
      prisma.citizen.findMany({
        where,
        include: {
          user: { select: { id: true, fullName: true, username: true, email: true, phone: true, status: true, createdAt: true } },
          village: { select: { id: true, name: true } },
          household: { select: { id: true, code: true, headName: true } },
        },
        orderBy: sortBy(req.query.sort, {
          oldest: { createdAt: 'asc' },
          name: { user: { fullName: 'asc' } },
          status: [{ user: { status: 'asc' } }, { createdAt: 'desc' }],
        }),
        skip,
        take: limit,
      }),
    ]);
    res.json(pageResponse(items, total, page, limit));
  }),
);

/** Leader creates a citizen account inside their jurisdiction. */
router.post(
  '/',
  requirePermission('citizens.view'),
  validate(citizenCreateSchema),
  asyncHandler(async (req, res) => {
    const data = req.body;
    const scope = await getScope(req.user!.id);
    if (scope.level === 6) throw notFound();

    const villageIds = await scopeVillageIds(scope);
    assertInScope(villageIds, data.villageId);

    const existing = await prisma.user.findFirst({
      where: { OR: [{ username: data.username }, { email: data.email || undefined }] },
    });
    if (existing) throw conflict('Username or email already taken');

    const citizenRole = await prisma.role.findUnique({ where: { slug: 'CITIZEN' } });
    if (!citizenRole) throw badRequest('Citizen role is not configured');

    const chain = await resolveVillageChain(data.villageId);
    const passwordHash = await hashPassword(data.password);

    const user = await prisma.user.create({
      data: {
        fullName: data.fullName,
        username: data.username,
        email: data.email || null,
        phone: data.phone || null,
        passwordHash,
        roleId: citizenRole.id,
        ...chain,
        status: 'ACTIVE',
        mustChangePassword: true,
        createdById: req.user!.id,
      },
    });

    const citizen = await prisma.citizen.create({
      data: {
        userId: user.id,
        villageId: data.villageId,
        nationalId: data.nationalId || null,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
        gender: data.gender || null,
      },
    });

    await audit(req, 'ADMIN_CREATE_CITIZEN', 'CITIZEN', citizen.id, null, { username: user.username });
    res.status(201).json({
      message: 'Citizen account created. The citizen must change their password on first login.',
      citizen,
    });
  }),
);

/** Leader updates a citizen's profile and contact credentials. */
router.put(
  '/:id',
  requirePermission('citizens.view'),
  validate(citizenUpdateSchema),
  asyncHandler(async (req, res) => {
    const { citizen } = await findCitizenInScope(req);
    const data = req.body;

    if (data.nationalId && data.nationalId !== citizen.nationalId) {
      const dup = await prisma.citizen.findFirst({
        where: { nationalId: data.nationalId, NOT: { id: citizen.id } },
      });
      if (dup) throw conflict('National ID is already registered to another citizen');
    }

    const userData: any = {};
    if (data.fullName) userData.fullName = data.fullName;
    if (data.email !== undefined) userData.email = data.email || null;
    if (data.phone !== undefined) userData.phone = data.phone || null;

    const citizenData: any = {};
    if (data.nationalId !== undefined) citizenData.nationalId = data.nationalId || null;
    if (data.dateOfBirth !== undefined) citizenData.dateOfBirth = data.dateOfBirth ? new Date(data.dateOfBirth) : null;
    if (data.gender !== undefined) citizenData.gender = data.gender || null;
    if (data.villageId) {
      const scope = await getScope(req.user!.id);
      const villageIds = await scopeVillageIds(scope);
      assertInScope(villageIds, data.villageId);
      citizenData.villageId = data.villageId;
      Object.assign(userData, await resolveVillageChain(data.villageId));
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (Object.keys(userData).length) await tx.user.update({ where: { id: citizen.userId }, data: userData });
      return tx.citizen.update({ where: { id: citizen.id }, data: citizenData });
    });

    await audit(req, 'ADMIN_UPDATE_CITIZEN', 'CITIZEN', citizen.id, null, { villageId: updated.villageId });
    res.json({ message: 'Citizen updated', citizen: updated });
  }),
);

/** Leader resets a citizen's password (forced change on next login). */
router.put(
  '/:id/password',
  requirePermission('citizens.view'),
  validate(citizenPasswordSchema),
  asyncHandler(async (req, res) => {
    const { citizen } = await findCitizenInScope(req);

    const passwordHash = await hashPassword(req.body.password);
    await prisma.user.update({
      where: { id: citizen.userId },
      data: { passwordHash, mustChangePassword: true, failedLoginAttempts: 0, lockedUntil: null },
    });
    await prisma.session.updateMany({ where: { userId: citizen.userId }, data: { revokedAt: new Date() } });

    await audit(req, 'ADMIN_RESET_CITIZEN_PASSWORD', 'CITIZEN', citizen.id);
    res.json({ message: 'Password reset. The citizen must change it on next login.' });
  }),
);

/** Leader activates or deactivates a citizen account (soft toggle to preserve records). */
router.put(
  '/:id/status',
  requirePermission('citizens.view'),
  validate(z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) })),
  asyncHandler(async (req, res) => {
    const { citizen } = await findCitizenInScope(req);
    const status = req.body.status;

    await prisma.user.update({
      where: { id: citizen.userId },
      data:
        status === 'INACTIVE'
          ? { status: 'INACTIVE', lockedUntil: new Date() }
          : { status: 'ACTIVE', lockedUntil: null, failedLoginAttempts: 0 },
    });
    if (status === 'INACTIVE') {
      await prisma.session.updateMany({ where: { userId: citizen.userId }, data: { revokedAt: new Date() } });
    }

    await audit(req, status === 'INACTIVE' ? 'ADMIN_DEACTIVATE_CITIZEN' : 'ADMIN_ACTIVATE_CITIZEN', 'CITIZEN', citizen.id, null, { status });
    res.json({ message: status === 'INACTIVE' ? 'Citizen account deactivated.' : 'Citizen account activated.', status });
  }),
);

/** Leader deactivates a citizen account (soft delete to preserve records). */
router.delete(
  '/:id',
  requirePermission('citizens.view'),
  asyncHandler(async (req, res) => {
    const { citizen } = await findCitizenInScope(req);

    await prisma.user.update({
      where: { id: citizen.userId },
      data: { status: 'INACTIVE', lockedUntil: new Date() },
    });
    await prisma.session.updateMany({ where: { userId: citizen.userId }, data: { revokedAt: new Date() } });

    await audit(req, 'ADMIN_DEACTIVATE_CITIZEN', 'CITIZEN', citizen.id);
    res.json({ message: 'Citizen account deactivated.' });
  }),
);

export default router;
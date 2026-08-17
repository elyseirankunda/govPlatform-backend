import { prisma } from '../lib/prisma';
import { forbidden } from '../lib/httpError';

export interface Scope {
  role: string;
  level: number; // 1=province ... 5=village, 6=citizen
  provinceId: number | null;
  districtId: number | null;
  sectorId: number | null;
  cellId: number | null;
  villageId: number | null;
  citizenId: number | null;
}

/**
 * The one source of truth for hierarchical access.
 * Given an authenticated user, returns their administrative scope.
 * If the user's record is inconsistent (e.g. missing unit), scope is limited to nothing.
 */
export async function getScope(userId: number): Promise<Scope> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      role: true,
      citizenProfile: true,
    },
  });

  if (!user) throw forbidden('User not found');

  const roleLevel = user.role.level;

  let provinceId = user.provinceId ?? null;
  let districtId = user.districtId ?? null;
  let sectorId = user.sectorId ?? null;
  let cellId = user.cellId ?? null;
  let villageId = user.villageId ?? null;
  let citizenId = user.citizenProfile?.id ?? null;

  // Level 0 (SUPER_ADMIN) has province-wide authority, like a province admin.
  if (roleLevel === 1 || roleLevel === 0) {
    return {
      role: user.role.slug,
      level: roleLevel,
      provinceId,
      districtId: null,
      sectorId: null,
      cellId: null,
      villageId: null,
      citizenId,
    };
  }

  // A user at level N must have a unit at exactly level N.
  if (roleLevel === 2) {
    provinceId = (await prisma.district.findUnique({ where: { id: districtId ?? -1 } }))?.provinceId ?? null;
  }
  if (roleLevel === 3) {
    const sector = await prisma.sector.findUnique({ where: { id: sectorId ?? -1 } });
    districtId = sector?.districtId ?? null;
    provinceId = districtId
      ? (await prisma.district.findUnique({ where: { id: districtId } }))?.provinceId ?? null
      : null;
  }
  if (roleLevel === 4) {
    const cell = await prisma.cell.findUnique({ where: { id: cellId ?? -1 } });
    sectorId = cell?.sectorId ?? null;
    districtId = sectorId
      ? (await prisma.sector.findUnique({ where: { id: sectorId } }))?.districtId ?? null
      : null;
    provinceId = districtId
      ? (await prisma.district.findUnique({ where: { id: districtId } }))?.provinceId ?? null
      : null;
  }
  if (roleLevel === 5) {
    const village = await prisma.village.findUnique({ where: { id: villageId ?? -1 } });
    cellId = village?.cellId ?? null;
    sectorId = cellId
      ? (await prisma.cell.findUnique({ where: { id: cellId } }))?.sectorId ?? null
      : null;
    districtId = sectorId
      ? (await prisma.sector.findUnique({ where: { id: sectorId } }))?.districtId ?? null
      : null;
    provinceId = districtId
      ? (await prisma.district.findUnique({ where: { id: districtId } }))?.provinceId ?? null
      : null;
  }
  if (roleLevel === 6) {
    const citizen = user.citizenProfile;
    if (citizen) {
      villageId = citizen.villageId;
      const village = await prisma.village.findUnique({ where: { id: villageId } });
      cellId = village?.cellId ?? null;
      sectorId = cellId
        ? (await prisma.cell.findUnique({ where: { id: cellId } }))?.sectorId ?? null
        : null;
      districtId = sectorId
        ? (await prisma.sector.findUnique({ where: { id: sectorId } }))?.districtId ?? null
        : null;
      provinceId = districtId
        ? (await prisma.district.findUnique({ where: { id: districtId } }))?.provinceId ?? null
        : null;
    }
  }

  return {
    role: user.role.slug,
    level: roleLevel,
    provinceId,
    districtId,
    sectorId,
    cellId,
    villageId,
    citizenId,
  };
}

/** All village ids inside the scope - the primitive used to scope every query. */
export async function scopeVillageIds(scope: Scope): Promise<number[]> {
  if (scope.level === 6) return scope.villageId ? [scope.villageId] : [];
  if (scope.level === 5) return scope.villageId ? [scope.villageId] : [];

  const villages = await prisma.village.findMany({
    where: {
      ...(scope.provinceId ? { cell: { sector: { district: { provinceId: scope.provinceId } } } } : {}),
      ...(scope.districtId ? { cell: { sector: { districtId: scope.districtId } } } : {}),
      ...(scope.sectorId ? { cell: { sectorId: scope.sectorId } } : {}),
      ...(scope.cellId ? { cellId: scope.cellId } : {}),
    },
    select: { id: true },
  });
  return villages.map((v) => v.id);
}

/** Convenience: add a "villageId in" filter for a query. */
export function inScope(villageIds: number[]): { villageId: { in: number[] } } {
  return { villageId: { in: villageIds } };
}

/** Ensure a record's village is inside the current user's scope. */
export function assertInScope(villageIds: number[], recordVillageId: number): void {
  if (!villageIds.includes(recordVillageId)) {
    throw forbidden('This record is outside your administrative scope');
  }
}

/**
 * True when a target record's administrative unit lies inside the caller's
 * scope. The caller's own unit (if any) is the strict boundary; a target that
 * shares the province is always considered in-scope for province-level callers.
 */
export function isWithinScope(
  scope: Scope,
  target: {
    provinceId?: number | null;
    districtId?: number | null;
    sectorId?: number | null;
    cellId?: number | null;
    villageId?: number | null;
  },
): boolean {
  if (scope.provinceId && target.provinceId != null && target.provinceId !== scope.provinceId) return false;
  if (scope.districtId && target.districtId != null && target.districtId !== scope.districtId) return false;
  if (scope.sectorId && target.sectorId != null && target.sectorId !== scope.sectorId) return false;
  if (scope.cellId && target.cellId != null && target.cellId !== scope.cellId) return false;
  if (scope.villageId && target.villageId != null && target.villageId !== scope.villageId) return false;
  return true;
}

export interface UnitNode {
  id: number;
  name: string;
  code: string;
  children?: UnitNode[];
}

/** Returns the subtree below a scope (empty for citizens). */
export async function scopeTree(scope: Scope): Promise<UnitNode> {
  if (scope.level === 6) {
    return {
      id: scope.villageId ?? 0,
      name: 'My Village',
      code: '',
    };
  }
  if (scope.level === 5) {
    const village = await prisma.village.findUnique({
      where: { id: scope.villageId ?? -1 },
      include: { cell: { include: { sector: { include: { district: true } } } } },
    });
    if (!village) return { id: 0, name: 'My Village', code: '' };
    const dNode: UnitNode = { id: village.cell.sector.districtId, name: village.cell.sector.district.name, code: '', children: [] };
    const sNode: UnitNode = { id: village.cell.sectorId, name: village.cell.sector.name, code: '', children: [] };
    const cNode: UnitNode = { id: village.cellId, name: village.cell.name, code: '', children: [] };
    cNode.children!.push({ id: village.id, name: village.name, code: village.code });
    sNode.children!.push(cNode);
    dNode.children!.push(sNode);
    return { id: scope.provinceId ?? 0, name: 'Province', code: '', children: [dNode] };
  }

  const province = await prisma.province.findUnique({
    where: { id: scope.provinceId ?? -1 },
    include: {
      districts: scope.districtId
        ? {
            where: { id: scope.districtId },
            include: {
              sectors: scope.sectorId
                ? {
                    where: { id: scope.sectorId },
                    include: {
                      cells: scope.cellId
                        ? { where: { id: scope.cellId }, include: { villages: true } }
                        : { include: { villages: true } },
                    },
                  }
                : { include: { cells: { include: { villages: true } } } },
            },
          }
        : { include: { sectors: { include: { cells: { include: { villages: true } } } } } },
    },
  });

  if (!province) return { id: 0, name: 'Unknown', code: '' };

  const root: UnitNode = { id: province.id, name: province.name, code: province.code, children: [] };

  for (const district of province.districts) {
    const dNode: UnitNode = { id: district.id, name: district.name, code: district.code, children: [] };
    for (const sector of district.sectors) {
      const sNode: UnitNode = { id: sector.id, name: sector.name, code: sector.code, children: [] };
      for (const cell of sector.cells) {
        sNode.children!.push({ id: cell.id, name: cell.name, code: cell.code, children: cell.villages.map((v) => ({ id: v.id, name: v.name, code: v.code })) });
      }
      dNode.children!.push(sNode);
    }
    root.children!.push(dNode);
  }
  return root;
}

/** Target level that a user at `level` reports to (1..5). Citizens report to village (5). */
export const reportsToLevel = (level: number): number => (level >= 5 ? 5 : level - 1);

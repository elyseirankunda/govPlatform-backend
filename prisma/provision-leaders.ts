import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

/**
 * Bulk-provisions leader accounts for the whole administrative hierarchy:
 * one account per DISTRICT/SECTOR/CELL/VILLAGE, bound to its exact unit.
 *
 * Username convention: <unit-name-slug>.<level>  (e.g. musanze.admin, muhoza.sector)
 * Temp password for every account: Admin@123  (must be changed on first login)
 *
 * Idempotent: accounts whose username already exists are skipped.
 */

const prisma = new PrismaClient();

const TEMP_PASSWORD = process.env.PROVISION_PASSWORD || 'Admin@123';

function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 28);
}

async function main() {
  console.log('Provisioning leader accounts for the full hierarchy...');

  const roles = await prisma.role.findMany({ where: { level: { gte: 2, lte: 5 } } });
  const roleByLevel: Record<number, { id: number }> = {};
  for (const r of roles) roleByLevel[r.level] = r;

  if (!roleByLevel[2] || !roleByLevel[3] || !roleByLevel[4] || !roleByLevel[5]) {
    throw new Error('Required roles (DISTRICT/SECTOR/CELL/VILLAGE_ADMIN) are not seeded');
  }

  // Same temp password for everyone -> hash once and reuse.
  const passwordHash = await bcrypt.hash(TEMP_PASSWORD, 10);

  const existing = new Set(
    (await prisma.user.findMany({ where: { role: { level: { gte: 2, lte: 5 } } }, select: { username: true } })).map((u) => u.username),
  );

  const districts = await prisma.district.findMany({ include: { province: true } });
  const sectors = await prisma.sector.findMany({ include: { district: true } });
  const cells = await prisma.cell.findMany({ include: { sector: { include: { district: true } } } });
  const villages = await prisma.village.findMany({ include: { cell: { include: { sector: { include: { district: true } } } } } });

  const taken = new Set(existing);
  const uniqueUser = (base: string): string => {
    let name = base;
    let i = 2;
    while (taken.has(name)) name = `${base}-${i++}`;
    taken.add(name);
    return name;
  };

  let created = 0;
  let skipped = 0;

  async function provision(
    level: number,
    baseUsername: string,
    fullName: string,
    provinceId: number,
    districtId: number | null,
    sectorId: number | null,
    cellId: number | null,
    villageId: number | null,
    unitLabel: string,
  ) {
    if (existing.has(baseUsername)) {
      skipped++;
      return;
    }
    const username = uniqueUser(baseUsername);
    await prisma.user.create({
      data: {
        fullName,
        username,
        email: `${username}@northern.gov.rw`,
        phone: `07${String(88000000 + (created % 1000000)).slice(0, 8)}`,
        passwordHash,
        roleId: roleByLevel[level].id,
        provinceId,
        districtId,
        sectorId,
        cellId,
        villageId,
        createdById: null,
        status: 'ACTIVE',
        mustChangePassword: true,
      },
    });
    created++;
    return { username, fullName, role: roleByLevel[level], unitLabel };
  }

  const credentials: { username: string; password: string; role: string; level: number; unit: string }[] = [];

  // DISTRICT_ADMIN (level 2)
  for (const d of districts) {
    const user = await provision(
      2,
      `${slugify(d.name)}.admin`,
      `${d.name} District Administrator`,
      d.provinceId,
      d.id,
      null,
      null,
      null,
      `Province / ${d.name}`,
    );
    if (user) credentials.push({ username: user.username, password: TEMP_PASSWORD, role: 'DISTRICT_ADMIN', level: 2, unit: user.unitLabel });
  }

  // SECTOR_ADMIN (level 3)
  for (const s of sectors) {
    const user = await provision(
      3,
      `${slugify(s.name)}.sector`,
      `${s.name} Sector Administrator`,
      s.district.provinceId,
      s.districtId,
      s.id,
      null,
      null,
      `${s.district.name} / ${s.name}`,
    );
    if (user) credentials.push({ username: user.username, password: TEMP_PASSWORD, role: 'SECTOR_ADMIN', level: 3, unit: user.unitLabel });
  }

  // CELL_ADMIN (level 4)
  for (const c of cells) {
    const user = await provision(
      4,
      `${slugify(c.name)}.cell`,
      `${c.name} Cell Administrator`,
      c.sector.district.provinceId,
      c.sector.districtId,
      c.sectorId,
      c.id,
      null,
      `${c.sector.district.name} / ${c.sector.name} / ${c.name}`,
    );
    if (user) credentials.push({ username: user.username, password: TEMP_PASSWORD, role: 'CELL_ADMIN', level: 4, unit: user.unitLabel });
  }

  // VILLAGE_ADMIN (level 5)
  for (const v of villages) {
    const user = await provision(
      5,
      `${slugify(v.name)}.village`,
      `${v.name} Village Administrator`,
      v.cell.sector.district.provinceId,
      v.cell.sector.districtId,
      v.cell.sectorId,
      v.cellId,
      v.id,
      `${v.cell.sector.district.name} / ${v.cell.sector.name} / ${v.cell.name} / ${v.name}`,
    );
    if (user) credentials.push({ username: user.username, password: TEMP_PASSWORD, role: 'VILLAGE_ADMIN', level: 5, unit: user.unitLabel });
  }

  const outPath = path.join(__dirname, 'leader-credentials.txt');
  const lines = [
    'Northern Province Governance - Leader Accounts',
    `Temporary password for all accounts: ${TEMP_PASSWORD}`,
    'Each account must change its password on first login.',
    '',
    `DISTRICT_ADMIN: ${districts.length}  SECTOR_ADMIN: ${sectors.length}  CELL_ADMIN: ${cells.length}  VILLAGE_ADMIN: ${villages.length}`,
    `Created: ${created}   Skipped (already existed): ${skipped}`,
    '',
    ...credentials.map((c) => `[${c.role}] ${c.username} / ${TEMP_PASSWORD}  ->  ${c.unit}`),
  ];
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');

  console.log(`Done. Created ${created} accounts, skipped ${skipped} existing.`);
  console.log(`Credentials written to: ${outPath}`);
  console.log('Sample accounts:');
  for (const c of credentials.slice(0, 5)) console.log(`  ${c.username} / ${TEMP_PASSWORD}  (${c.unit})`);
  if (credentials.length > 5) console.log(`  ... and ${credentials.length - 5} more (see the file)`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
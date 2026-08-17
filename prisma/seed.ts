import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

interface VillageRef { name: string; code: string }
interface CellRef { name: string; code: string; villages: VillageRef[] }
interface SectorRef { name: string; code: string; cells: CellRef[] }
interface DistrictRef { name: string; code: string; sectors: SectorRef[] }
interface ProvinceRef { name: string; code: string; districts: DistrictRef[] }

const northernData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'northern-data.json'), 'utf-8'),
) as ProvinceRef;

async function main() {
  console.log('Seeding database...');

  // ------------------------------------------------------- full reset
  // Wipe dependent tables first (FK-safe order) so re-seeding always
  // produces exactly the real Northern Province hierarchy + demo accounts.
  const resetOrder = [
    'auditLog', 'attachment', 'notification', 'session', 'passwordReset', 'loginHistory',
    'escalation', 'complaintComment', 'reportReview', 'projectUpdate', 'eventParticipant',
    'announcement', 'report', 'project', 'event', 'complaint', 'serviceRequest',
    'citizen', 'household', 'user',
    'village', 'cell', 'sector', 'district', 'province',
  ] as const;
  for (const model of resetOrder) {
    await (prisma as any)[model].deleteMany({});
  }
  console.log('Database reset complete.');

  // ------------------------------------------------------------------ roles
  const rolesData = [
    { slug: 'SUPER_ADMIN', name: 'Super Administrator', level: 0, description: 'Platform-level administrator with full authority' },
    { slug: 'PROVINCE_ADMIN', name: 'Province Administrator', level: 1, description: 'Supervises all districts in Northern Province' },
    { slug: 'DISTRICT_ADMIN', name: 'District Administrator', level: 2, description: 'Manages a district and its sectors' },
    { slug: 'SECTOR_ADMIN', name: 'Sector Administrator', level: 3, description: 'Coordinates activities inside a sector' },
    { slug: 'CELL_ADMIN', name: 'Cell Administrator', level: 4, description: 'Coordinates between sectors and villages' },
    { slug: 'VILLAGE_ADMIN', name: 'Village Administrator', level: 5, description: 'Closest level to citizens and households' },
    { slug: 'CITIZEN', name: 'Citizen', level: 6, description: 'Registered citizen of the province' },
  ];

  const roles: Record<string, { id: number }> = {};
  for (const r of rolesData) {
    roles[r.slug] = await prisma.role.upsert({
      where: { slug: r.slug },
      update: { name: r.name, level: r.level, description: r.description },
      create: r,
    });
  }

  // -------------------------------------------------------------- permissions
  const permissionSlugs = [
    'dashboard.view', 'complaints.manage', 'complaints.escalate', 'requests.manage',
    'reports.create', 'reports.review', 'announcements.create', 'projects.manage',
    'events.manage', 'citizens.view', 'households.manage', 'users.manage',
    'units.manage', 'audit.view',
  ];
  const permissions: Record<string, { id: number }> = {};
  for (const slug of permissionSlugs) {
    permissions[slug] = await prisma.permission.upsert({
      where: { slug },
      update: { name: slug },
      create: { slug, name: slug },
    });
  }

  // Role -> permission matrix. A higher level implicitly inherits the permission
  // set of every level below it.
  const rolePermissions: Record<string, string[]> = {
    SUPER_ADMIN: permissionSlugs,
    PROVINCE_ADMIN: permissionSlugs,
    DISTRICT_ADMIN: [
      'dashboard.view', 'complaints.manage', 'complaints.escalate', 'requests.manage',
      'reports.create', 'reports.review', 'announcements.create', 'projects.manage',
      'events.manage', 'citizens.view', 'households.manage', 'users.manage',
    ],
    SECTOR_ADMIN: [
      'dashboard.view', 'complaints.manage', 'complaints.escalate', 'requests.manage',
      'reports.create', 'reports.review', 'announcements.create', 'projects.manage',
      'events.manage', 'citizens.view', 'households.manage',
    ],
    CELL_ADMIN: [
      'dashboard.view', 'complaints.manage', 'requests.manage',
      'reports.create', 'announcements.create', 'events.manage',
      'citizens.view', 'households.manage',
    ],
    VILLAGE_ADMIN: [
      'dashboard.view', 'complaints.manage', 'requests.manage',
      'reports.create', 'announcements.create', 'events.manage',
      'citizens.view', 'households.manage',
    ],
    CITIZEN: ['dashboard.view'],
  };
  for (const [roleSlug, slugs] of Object.entries(rolePermissions)) {
    await prisma.role.update({
      where: { id: roles[roleSlug].id },
      data: { permissions: { set: slugs.map((s) => ({ id: permissions[s].id })) } },
    });
  }

  // --------------------------------------------------------------- categories
  const categories = [
    { name: 'Roads and Infrastructure', slug: 'roads' },
    { name: 'Water and Sanitation', slug: 'water' },
    { name: 'Education', slug: 'education' },
    { name: 'Health', slug: 'health' },
    { name: 'Security', slug: 'security' },
    { name: 'Agriculture and Livestock', slug: 'agriculture' },
    { name: 'Land and Housing', slug: 'land' },
    { name: 'Environment', slug: 'environment' },
    { name: 'Social Protection', slug: 'social' },
    { name: 'Other', slug: 'other' },
  ];
  for (const c of categories) {
    await prisma.complaintCategory.upsert({ where: { slug: c.slug }, update: { name: c.name }, create: c });
  }

  const serviceTypes = [
    { name: 'Administrative information', slug: 'admin-info' },
    { name: 'Local documentation', slug: 'documents' },
    { name: 'Community request', slug: 'community' },
    { name: 'Development-related request', slug: 'development' },
    { name: 'Other public service', slug: 'other' },
  ];
  for (const s of serviceTypes) {
    await prisma.serviceType.upsert({ where: { slug: s.slug }, update: { name: s.name }, create: s });
  }

  // -------------------------------------------------------------- hierarchy
  // Real Northern Province data (NISR "List of Villages"): 5 districts,
  // 89 sectors, 414 cells, 2,744 villages. Uses batched createMany so the
  // seed stays fast even with ~3,200 rows.
  const province = await prisma.province.upsert({
    where: { code: northernData.code },
    update: { name: northernData.name },
    create: { name: northernData.name, code: northernData.code },
  });

  interface UnitRef { id: number; name: string; code: string }
  const districts: UnitRef[] = [];
  const sectorIndex: Record<string, UnitRef> = {};
  const cellIndex: Record<string, UnitRef> = {};
  const villageIndex: Record<string, UnitRef> = {};

  const existingSectorCodes = new Set((await prisma.sector.findMany({ select: { code: true } })).map((r) => r.code));
  const existingCellCodes = new Set((await prisma.cell.findMany({ select: { code: true } })).map((r) => r.code));
  const existingVillageCodes = new Set((await prisma.village.findMany({ select: { code: true } })).map((r) => r.code));

  for (const dd of northernData.districts) {
    const district = await prisma.district.upsert({
      where: { code: dd.code },
      update: { name: dd.name },
      create: { name: dd.name, code: dd.code, provinceId: province.id },
    });
    districts.push({ id: district.id, name: dd.name, code: dd.code });

    const missingSectors = dd.sectors.filter((s) => !existingSectorCodes.has(s.code));
    if (missingSectors.length) {
      await prisma.sector.createMany({
        data: missingSectors.map((s) => ({ name: s.name, code: s.code, districtId: district.id })),
      });
    }

    const sectorRows = await prisma.sector.findMany({ where: { districtId: district.id }, select: { id: true, name: true, code: true } });
    const sectorIdByCode: Record<string, number> = {};
    for (const s of sectorRows) {
      sectorIndex[s.code] = s;
      sectorIdByCode[s.code] = s.id;
    }

    const missingCells = dd.sectors.flatMap((s) =>
      s.cells.filter((c) => !existingCellCodes.has(c.code)).map((c) => ({ name: c.name, code: c.code, sectorId: sectorIdByCode[s.code] })),
    );
    if (missingCells.length) {
      await prisma.cell.createMany({ data: missingCells });
    }

    const cellRows = await prisma.cell.findMany({
      where: { sectorId: { in: sectorRows.map((s) => s.id) } },
      select: { id: true, name: true, code: true },
    });
    const cellIdByCode: Record<string, number> = {};
    for (const c of cellRows) {
      cellIndex[c.code] = c;
      cellIdByCode[c.code] = c.id;
    }

    const missingVillages = dd.sectors.flatMap((s) =>
      s.cells.flatMap((c) =>
        c.villages.filter((v) => !existingVillageCodes.has(v.code)).map((v) => ({ name: v.name, code: v.code, cellId: cellIdByCode[c.code] })),
      ),
    );
    if (missingVillages.length) {
      await prisma.village.createMany({ data: missingVillages });
    }

    const villageRows = await prisma.village.findMany({
      where: { cellId: { in: cellRows.map((c) => c.id) } },
      select: { id: true, name: true, code: true },
    });
    for (const v of villageRows) {
      villageIndex[v.code] = v;
    }
  }

  // -------------------------------------------------------------- demo users
  const pw = (s: string) => bcrypt.hash(s, 10);

  async function findUnit(districtCode: string, sectorIdx: number, cellIdx: number, villageIdx: number) {
    const village = villageIndex[`${districtCode}-S${sectorIdx}C${cellIdx}V${villageIdx}`]!;
    const cell = cellIndex[`${districtCode}-S${sectorIdx}C${cellIdx}`]!;
    const sector = sectorIndex[`${districtCode}-S${sectorIdx}`]!;
    const district = districts.find((d) => d.code === districtCode)!;
    return { village, cell, sector, district };
  }

  async function createAdmin(params: {
    fullName: string; username: string; email: string; phone: string;
    role: string; provinceId: number; districtId: number; sectorId: number; cellId: number; villageId: number;
  }) {
    const role = await prisma.role.findUnique({ where: { slug: params.role as any } });
    if (!role) throw new Error(`Role ${params.role} not found`);
    const exists = await prisma.user.findUnique({ where: { username: params.username } });
    if (exists) {
      console.log(`  user ${params.username} already exists, skipping`);
      return exists;
    }
    return prisma.user.create({
      data: {
        fullName: params.fullName,
        username: params.username,
        email: params.email,
        phone: params.phone,
        passwordHash: await pw('Admin@123'),
        roleId: role.id,
        provinceId: params.provinceId || null,
        districtId: params.districtId || null,
        sectorId: params.sectorId || null,
        cellId: params.cellId || null,
        villageId: params.villageId || null,
        status: 'ACTIVE',
      },
    });
  }

  // Super admin (bootstrap role, provisioned via seed only)
  await createAdmin({
    fullName: 'Super Administrator', username: 'super', email: 'super@northern.gov.rw',
    phone: '0788000000', role: 'SUPER_ADMIN',
    provinceId: province.id, districtId: 0, sectorId: 0, cellId: 0, villageId: 0,
  });

  // Province admin
  await createAdmin({
    fullName: 'Province Administrator', username: 'province', email: 'province@northern.gov.rw',
    phone: '0788000001', role: 'PROVINCE_ADMIN',
    provinceId: province.id, districtId: 0, sectorId: 0, cellId: 0, villageId: 0,
  });

  const musanze = await findUnit('NORTH-MUS', 8, 1, 1);

  // District admin (Musanze)
  await createAdmin({
    fullName: 'Musanze District Administrator', username: 'district', email: 'district@musanze.gov.rw',
    phone: '0788000002', role: 'DISTRICT_ADMIN',
    provinceId: province.id, districtId: musanze.district.id, sectorId: 0, cellId: 0, villageId: 0,
  });

  // Sector admin
  await createAdmin({
    fullName: 'Sector Administrator', username: 'sector', email: 'sector@muhoza.gov.rw',
    phone: '0788000003', role: 'SECTOR_ADMIN',
    provinceId: province.id, districtId: musanze.district.id, sectorId: musanze.sector.id, cellId: 0, villageId: 0,
  });

  // Cell admin
  await createAdmin({
    fullName: 'Cell Administrator', username: 'cell', email: 'cell@muhoza.gov.rw',
    phone: '0788000004', role: 'CELL_ADMIN',
    provinceId: province.id, districtId: musanze.district.id, sectorId: musanze.sector.id, cellId: musanze.cell.id, villageId: 0,
  });

  // Village admin
  await createAdmin({
    fullName: 'Village Administrator', username: 'village', email: 'village@umudugudu.gov.rw',
    phone: '0788000005', role: 'VILLAGE_ADMIN',
    provinceId: province.id, districtId: musanze.district.id, sectorId: musanze.sector.id, cellId: musanze.cell.id, villageId: musanze.village.id,
  });

  // Citizen
  const citizenRole = await prisma.role.findUnique({ where: { slug: 'CITIZEN' } });
  if (citizenRole) {
    const existingCitizen = await prisma.user.findUnique({ where: { username: 'citizen' } });
    let citizenUser;
    if (existingCitizen) {
      citizenUser = existingCitizen;
    } else {
      citizenUser = await prisma.user.create({
        data: {
          fullName: 'Jean Citizen', username: 'citizen', email: 'citizen@example.com',
          phone: '0788000006', passwordHash: await pw('Citizen@123'),
          roleId: citizenRole.id,
          provinceId: province.id, districtId: musanze.district.id, sectorId: musanze.sector.id,
          cellId: musanze.cell.id, villageId: musanze.village.id,
          status: 'ACTIVE',
        },
      });
    }
    const profile = await prisma.citizen.findUnique({ where: { userId: citizenUser.id } });
    if (!profile) {
      await prisma.citizen.create({
        data: { userId: citizenUser.id, villageId: musanze.village.id, nationalId: '1198765432109876', gender: 'Male' },
      });
    }
  }

  // A couple of households + sample data in Musanze village 1
  const h1 = await prisma.household.upsert({
    where: { code: 'MUS-S1C1V1-H1' },
    update: {},
    create: { villageId: musanze.village.id, code: 'MUS-S1C1V1-H1', headName: 'Jean Citizen', members: 5 },
  });

  const complaintCat = await prisma.complaintCategory.findUnique({ where: { slug: 'roads' } });
  const serviceType = await prisma.serviceType.findUnique({ where: { slug: 'documents' } });
  const citizenProfile = await prisma.citizen.findFirst({ where: { villageId: musanze.village.id } });

  if (citizenProfile && complaintCat) {
    const count = await prisma.complaint.count();
    if (count === 0) {
      await prisma.complaint.create({
        data: {
          citizenId: citizenProfile.id,
          categoryId: complaintCat.id,
          title: 'Pothole on the main road',
          description: 'There is a large pothole near the market that is dangerous for moto riders.',
          location: 'Near the main market',
          villageId: musanze.village.id,
          cellId: musanze.cell.id,
          sectorId: musanze.sector.id,
          districtId: musanze.district.id,
          provinceId: province.id,
          priority: 'HIGH',
          status: 'SUBMITTED',
          currentLevel: 5,
        },
      });
    }
  }

  if (citizenProfile && serviceType) {
    const count = await prisma.serviceRequest.count();
    if (count === 0) {
      await prisma.serviceRequest.create({
        data: {
          citizenId: citizenProfile.id,
          serviceTypeId: serviceType.id,
          title: 'Request for family document',
          description: 'Requesting an official copy of the family document for my household.',
          location: 'Umudugudu Y',
          villageId: musanze.village.id,
          cellId: musanze.cell.id,
          sectorId: musanze.sector.id,
          districtId: musanze.district.id,
          provinceId: province.id,
          status: 'SUBMITTED',
          currentLevel: 5,
        },
      });
    }
  }

  const projectCount = await prisma.project.count();
  if (projectCount === 0) {
    await prisma.project.create({
      data: {
        title: 'Village water access point',
        description: 'Construction of a clean water access point serving the whole village.',
        location: 'Central point of village',
        villageId: musanze.village.id,
        cellId: musanze.cell.id,
        sectorId: musanze.sector.id,
        districtId: musanze.district.id,
        provinceId: province.id,
        level: 5,
        startDate: new Date('2026-02-01'),
        expectedEndDate: new Date('2026-12-31'),
        budget: 50000000,
        fundingSource: 'District development fund',
        progress: 40,
        status: 'IN_PROGRESS',
        beneficiaries: 320,
      },
    });
  }

  console.log('Seeding complete.');
  console.log('Demo accounts (password Admin@123 for admins, Citizen@123 for citizen):');
  console.log('  super / super@northern.gov.rw');
  console.log('  province / province@northern.gov.rw');
  console.log('  district / district@musanze.gov.rw');
  console.log('  sector / sector@muhoza.gov.rw');
  console.log('  cell / cell@muhoza.gov.rw');
  console.log('  village / village@umudugudu.gov.rw');
  console.log('  citizen / citizen@example.com');
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

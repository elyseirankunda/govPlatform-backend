import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { totp } from '../src/lib/totp';

// Environment must be configured before any app/prisma module is imported.
process.env.DATABASE_URL = 'file:./test.db';
process.env.JWT_SECRET = 'test-secret';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.RATE_LIMIT_MAX = '1000000';
process.env.BCRYPT_ROUNDS = '4';
process.env.NODE_ENV = 'test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;

const pw = (s: string) => bcrypt.hash(s, 4);

async function seedTestData() {
  const permissions = [
    'dashboard.view', 'complaints.manage', 'complaints.escalate', 'requests.manage',
    'reports.create', 'reports.review', 'announcements.create', 'projects.manage',
    'events.manage', 'citizens.view', 'households.manage', 'users.manage',
    'units.manage', 'audit.view',
  ];
  const perms: Record<string, { id: number }> = {};
  for (const slug of permissions) {
    perms[slug] = await prisma.permission.upsert({ where: { slug }, update: {}, create: { slug, name: slug } });
  }

  const roleData: Array<{ slug: string; name: string; level: number; perms: string[] }> = [
    { slug: 'SUPER_ADMIN', name: 'Super Administrator', level: 0, perms: permissions },
    { slug: 'PROVINCE_ADMIN', name: 'Province Administrator', level: 1, perms: permissions },
    { slug: 'DISTRICT_ADMIN', name: 'District Administrator', level: 2, perms: permissions },
    { slug: 'SECTOR_ADMIN', name: 'Sector Administrator', level: 3, perms: ['dashboard.view', 'complaints.manage', 'requests.manage', 'reports.create', 'announcements.create', 'events.manage', 'citizens.view', 'households.manage'] },
    { slug: 'CELL_ADMIN', name: 'Cell Administrator', level: 4, perms: ['dashboard.view', 'complaints.manage', 'requests.manage', 'reports.create', 'announcements.create', 'events.manage', 'citizens.view', 'households.manage'] },
    { slug: 'VILLAGE_ADMIN', name: 'Village Administrator', level: 5, perms: ['dashboard.view', 'complaints.manage', 'requests.manage', 'reports.create', 'announcements.create', 'events.manage', 'citizens.view', 'households.manage'] },
    { slug: 'CITIZEN', name: 'Citizen', level: 6, perms: ['dashboard.view'] },
  ];
  const roles: Record<string, { id: number }> = {};
  for (const r of roleData) {
    roles[r.slug] = await prisma.role.upsert({
      where: { slug: r.slug },
      update: { level: r.level },
      create: { slug: r.slug, name: r.name, level: r.level },
    });
    await prisma.role.update({
      where: { id: roles[r.slug].id },
      data: { permissions: { set: r.perms.map((s) => ({ id: perms[s].id })) } },
    });
  }

  const province = await prisma.province.create({ data: { name: 'Test Province', code: 'TEST-P' } });
  const district = await prisma.district.create({ data: { name: 'Test District', code: 'TEST-D', provinceId: province.id } });
  const sector = await prisma.sector.create({ data: { name: 'Test Sector', code: 'TEST-S', districtId: district.id } });
  const cell = await prisma.cell.create({ data: { name: 'Test Cell', code: 'TEST-C', sectorId: sector.id } });
  const village = await prisma.village.create({ data: { name: 'Test Village', code: 'TEST-V', cellId: cell.id } });

  async function makeUser(params: {
    username: string; password: string; role: string; fullName: string;
    provinceId?: number; districtId?: number; sectorId?: number; cellId?: number; villageId?: number;
    status?: string;
  }) {
    return prisma.user.create({
      data: {
        fullName: params.fullName,
        username: params.username,
        email: `${params.username}@test.local`,
        passwordHash: await pw(params.password),
        roleId: roles[params.role].id,
        provinceId: params.provinceId,
        districtId: params.districtId,
        sectorId: params.sectorId,
        cellId: params.cellId,
        villageId: params.villageId,
        status: params.status ?? 'ACTIVE',
      },
    });
  }

  await makeUser({ username: 'super', password: 'Admin@123', role: 'SUPER_ADMIN', fullName: 'Super Admin', provinceId: province.id });
  await makeUser({ username: 'province', password: 'Admin@123', role: 'PROVINCE_ADMIN', fullName: 'Province Admin', provinceId: province.id });
  await makeUser({ username: 'district', password: 'Admin@123', role: 'DISTRICT_ADMIN', fullName: 'District Admin', provinceId: province.id, districtId: district.id });
  await makeUser({ username: 'village', password: 'Admin@123', role: 'VILLAGE_ADMIN', fullName: 'Village Admin', provinceId: province.id, districtId: district.id, sectorId: sector.id, cellId: cell.id, villageId: village.id });

  const citizenUser = await makeUser({
    username: 'citizen', password: 'Citizen@123', role: 'CITIZEN', fullName: 'Test Citizen',
    provinceId: province.id, districtId: district.id, sectorId: sector.id, cellId: cell.id, villageId: village.id,
  });
  const citizenProfile = await prisma.citizen.create({
    data: { userId: citizenUser.id, villageId: village.id, nationalId: '1234567890123456', gender: 'Male' },
  });

  const complaintCat = await prisma.complaintCategory.create({ data: { name: 'Roads', slug: 'roads' } });
  const complaint = await prisma.complaint.create({
    data: {
      citizenId: citizenProfile.id,
      categoryId: complaintCat.id,
      title: 'Test complaint',
      description: 'This is a test complaint body with sufficient length.',
      provinceId: province.id, districtId: district.id, sectorId: sector.id, cellId: cell.id, villageId: village.id,
      status: 'SUBMITTED', currentLevel: 5,
    },
  });

  return { province, village, complaint, citizenProfile };
}

async function login(username: string, password: string) {
  const res = await request(app).post('/api/v1/auth/login').send({ username, password });
  return res.body;
}

beforeAll(async () => {
  const dbPath = path.join(__dirname, '..', 'prisma', 'test.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  execSync('node node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss', {
    stdio: 'pipe',
    cwd: path.join(__dirname, '..'),
  });

  const { createApp } = await import('../src/app');
  app = createApp();
  ({ prisma } = await import('../src/lib/prisma'));
}, 300000);

let testData: any;
beforeAll(async () => {
  testData = await seedTestData();
}, 30000);

afterAll(async () => {
  await prisma?.$disconnect();
});

describe('authentication', () => {
  it('rejects unknown credentials', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ username: 'nobody', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('locks an account after repeated failures', async () => {
    const role = await prisma.role.findUnique({ where: { slug: 'CITIZEN' } });
    const user = await prisma.user.create({
      data: {
        fullName: 'Lock Test',
        username: `lock${Date.now()}`,
        email: `lock${Date.now()}@test.local`,
        passwordHash: await pw('Correct@123'),
        roleId: role.id,
        status: 'ACTIVE',
      },
    });
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/v1/auth/login').send({ username: user.username, password: 'wrong' });
    }
    const locked = await request(app).post('/api/v1/auth/login').send({ username: user.username, password: 'Correct@123' });
    expect(locked.status).toBe(403);
    expect(locked.body.error).toMatch(/locked/i);
  });
});

describe('role-based access control', () => {
  it('denies a cell-level user from user management', async () => {
    const village = await login('village', 'Admin@123');
    const res = await request(app).get('/api/v1/admin/users').set('Authorization', `Bearer ${village.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('allows a province admin to list subordinate accounts', async () => {
    const province = await login('province', 'Admin@123');
    const res = await request(app).get('/api/v1/admin/users').set('Authorization', `Bearer ${province.accessToken}`);
    expect(res.status).toBe(200);
    const roles = res.body.items.map((u: any) => u.role);
    expect(roles).not.toContain('PROVINCE_ADMIN');
    expect(roles).toContain('DISTRICT_ADMIN');
  });

  it('prevents a citizen from changing complaint status', async () => {
    const citizen = await login('citizen', 'Citizen@123');
    const res = await request(app)
      .put(`/api/v1/complaints/${testData.complaint.id}/status`)
      .set('Authorization', `Bearer ${citizen.accessToken}`)
      .send({ status: 'RESOLVED' });
    expect(res.status).toBe(403);
  });

  it('allows a village admin to update complaint status', async () => {
    const village = await login('village', 'Admin@123');
    const res = await request(app)
      .put(`/api/v1/complaints/${testData.complaint.id}/status`)
      .set('Authorization', `Bearer ${village.accessToken}`)
      .send({ status: 'RECEIVED' });
    expect(res.status).toBe(200);
  });

  it('allows only the super admin to provision PROVINCE_ADMIN accounts', async () => {
    const superTok = (await login('super', 'Admin@123')).accessToken;
    const provinceTok = (await login('province', 'Admin@123')).accessToken;

    const denied = await request(app)
      .post('/api/v1/admin/users')
      .set('Authorization', `Bearer ${provinceTok}`)
      .send({ fullName: 'New PA', username: `xpa${Date.now()}`, email: `xpa${Date.now()}@test.local`, password: 'Admin@123', role: 'PROVINCE_ADMIN', provinceId: testData.province.id });
    expect(denied.status).toBe(403);

    const created = await request(app)
      .post('/api/v1/admin/users')
      .set('Authorization', `Bearer ${superTok}`)
      .send({ fullName: 'New PA', username: `npa${Date.now()}`, email: `npa${Date.now()}@test.local`, password: 'Admin@123', role: 'PROVINCE_ADMIN', provinceId: testData.province.id });
    expect(created.status).toBe(201);
    expect(created.body.user.status).toBe('PENDING');
  });
});

describe('account lifecycle', () => {
  it('creates citizen registrations as PENDING and blocks login', async () => {
    const username = `pend${Date.now()}`;
    const reg = await request(app).post('/api/v1/auth/register').send({
      fullName: 'Pending Citizen',
      username,
      email: `${username}@test.local`,
      password: 'Password123!',
      villageId: testData.village.id,
    });
    expect(reg.status).toBe(201);

    const loginAttempt = await request(app).post('/api/v1/auth/login').send({ username, password: 'Password123!' });
    expect(loginAttempt.status).toBe(403);
    expect(loginAttempt.body.error).toMatch(/pending approval/i);
  });

  it('activates a pending account through the status endpoint', async () => {
    const username = `pend${Date.now()}`;
    await request(app).post('/api/v1/auth/register').send({
      fullName: 'Pending Two', username, email: `${username}@test.local`,
      password: 'Password123!', villageId: testData.village.id,
    });
    const pending = await prisma.user.findUnique({ where: { username } });
    expect(pending.status).toBe('PENDING');

    const district = await login('district', 'Admin@123');
    const res = await request(app)
      .put(`/api/v1/admin/users/${pending.id}/status`)
      .set('Authorization', `Bearer ${district.accessToken}`)
      .send({ status: 'ACTIVE' });
    expect(res.status).toBe(200);

    const after = await prisma.user.findUnique({ where: { id: pending.id } });
    expect(after.status).toBe('ACTIVE');

    const loginOk = await request(app).post('/api/v1/auth/login').send({ username, password: 'Password123!' });
    expect(loginOk.status).toBe(200);
  });

  it('records FAILED_LOGIN audit entries', async () => {
    await request(app).post('/api/v1/auth/login').send({ username: 'super', password: 'definitely-wrong' });
    const entry = await prisma.auditLog.findFirst({ where: { action: 'FAILED_LOGIN' }, orderBy: { createdAt: 'desc' } });
    expect(entry).not.toBeNull();
  });
});

describe('two-factor authentication', () => {
  it('runs the full enable -> challenge -> login -> disable lifecycle', async () => {
    const villageTok = (await login('village', 'Admin@123')).accessToken;

    const setup = await request(app).post('/api/v1/auth/2fa/setup').set('Authorization', `Bearer ${villageTok}`);
    expect(setup.status).toBe(200);
    const secret = setup.body.secret;

    const badVerify = await request(app).post('/api/v1/auth/2fa/verify').set('Authorization', `Bearer ${villageTok}`).send({ code: '000000' });
    expect(badVerify.status).toBe(400);

    const verify = await request(app).post('/api/v1/auth/2fa/verify').set('Authorization', `Bearer ${villageTok}`).send({ code: totp(secret) });
    expect(verify.status).toBe(200);

    const fresh = await request(app).post('/api/v1/auth/login').send({ username: 'village', password: 'Admin@123' });
    expect(fresh.status).toBe(200);
    expect(fresh.body.requiresTwoFactor).toBe(true);
    expect(fresh.body.accessToken).toBeUndefined();

    const badLogin = await request(app).post('/api/v1/auth/2fa/login').send({ mfaToken: fresh.body.mfaToken, code: '111111' });
    expect(badLogin.status).toBe(401);

    const goodLogin = await request(app).post('/api/v1/auth/2fa/login').send({ mfaToken: fresh.body.mfaToken, code: totp(secret) });
    expect(goodLogin.status).toBe(200);
    expect(goodLogin.body.accessToken).toBeDefined();

    const noProof = await request(app).post('/api/v1/auth/2fa/disable').set('Authorization', `Bearer ${goodLogin.body.accessToken}`).send({});
    expect(noProof.status).toBe(400);

    const disable = await request(app).post('/api/v1/auth/2fa/disable').set('Authorization', `Bearer ${goodLogin.body.accessToken}`).send({ code: totp(secret) });
    expect(disable.status).toBe(200);
  });

  it('does not leak the password hash or 2FA secret via profile update', async () => {
    const provinceTok = (await login('province', 'Admin@123')).accessToken;
    const res = await request(app).put('/api/v1/auth/profile').set('Authorization', `Bearer ${provinceTok}`).send({ phone: '0788000000' });
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('twoFactorSecret');
  });
});

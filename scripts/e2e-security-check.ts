import { totp } from '../src/lib/totp';

const BASE = 'http://localhost:4000/api/v1';

async function req(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  const cell = await req('POST', '/auth/login', { username: 'cell', password: 'Admin@123' });
  assert(cell.status === 200, 'cell admin logs in');
  const denyUsers = await req('GET', '/admin/users', undefined, cell.json.accessToken);
  assert(denyUsers.status === 403, `cell admin denied from /admin/users (got ${denyUsers.status})`);

  const citizen = await req('POST', '/auth/login', { username: 'citizen', password: 'Citizen@123' });
  assert(citizen.status === 200, 'citizen logs in');
  const citizenList = await req('GET', '/complaints', undefined, citizen.json.accessToken);
  const complaint = citizenList.json.items[0];
  assert(complaint, 'citizen has a complaint to test');
  const denyStatus = await req('PUT', `/complaints/${complaint.id}/status`, { status: 'RESOLVED' }, citizen.json.accessToken);
  assert(denyStatus.status === 403, `citizen denied from changing complaint status (got ${denyStatus.status})`);

  const village = await req('POST', '/auth/login', { username: 'village', password: 'Admin@123' });
  const okStatus = await req('PUT', `/complaints/${complaint.id}/status`, { status: 'RECEIVED' }, village.json.accessToken);
  assert(okStatus.status === 200, `village admin can update complaint status (got ${okStatus.status})`);

  const newUser = `pend_${Date.now()}`;
  const reg = await req('POST', '/auth/register', {
    fullName: 'Pending Person', username: newUser, email: `${newUser}@x.com`,
    password: 'Password123!', villageId: complaint.villageId,
  });
  assert(reg.status === 201, 'register new citizen returns 201');
  const pendingLogin = await req('POST', '/auth/login', { username: newUser, password: 'Password123!' });
  assert(pendingLogin.status === 403 && pendingLogin.json.error.includes('pending approval'), 'PENDING citizen cannot log in');

  const superLogin = await req('POST', '/auth/login', { username: 'super', password: 'Admin@123' });
  assert(superLogin.status === 200, 'super admin logs in');
  const pa = await req('POST', '/admin/users', {
    fullName: 'New Province Admin', username: `npa_${Date.now()}`, password: 'Admin@123',
    role: 'PROVINCE_ADMIN', provinceId: complaint.provinceId,
  }, superLogin.json.accessToken);
  assert(pa.status === 201, `super admin creates PROVINCE_ADMIN (got ${pa.status})`);
  assert(pa.json.user?.status === 'PENDING', 'new PROVINCE_ADMIN starts PENDING');

  const provinceLogin = await req('POST', '/auth/login', { username: 'province', password: 'Admin@123' });
  const paDenied = await req('POST', '/admin/users', {
    fullName: 'Another Province Admin', username: `xpa_${Date.now()}`, password: 'Admin@123',
    role: 'PROVINCE_ADMIN', provinceId: complaint.provinceId,
  }, provinceLogin.json.accessToken);
  assert(paDenied.status === 403, `province admin cannot create PROVINCE_ADMIN (got ${paDenied.status})`);

  const setup = await req('POST', '/auth/2fa/setup', {}, cell.json.accessToken);
  assert(setup.status === 200 && setup.json.secret, '2FA setup returns secret');
  const secret = setup.json.secret;

  const badVerify = await req('POST', '/auth/2fa/verify', { code: '000000' }, cell.json.accessToken);
  assert(badVerify.status === 400, 'wrong code rejected at verify');
  const okVerify = await req('POST', '/auth/2fa/verify', { code: totp(secret) }, cell.json.accessToken);
  assert(okVerify.status === 200, '2FA enabled with valid code');

  const freshLogin = await req('POST', '/auth/login', { username: 'cell', password: 'Admin@123' });
  assert(freshLogin.status === 200 && freshLogin.json.requiresTwoFactor === true, 'login now requires 2FA');
  assert(!freshLogin.json.accessToken, 'no session issued before 2FA');
  const badMfa = await req('POST', '/auth/2fa/login', { mfaToken: freshLogin.json.mfaToken, code: '111111' });
  assert(badMfa.status === 401, 'wrong 2FA code rejected at login');
  const goodMfa = await req('POST', '/auth/2fa/login', { mfaToken: freshLogin.json.mfaToken, code: totp(secret) });
  assert(goodMfa.status === 200 && goodMfa.json.accessToken, 'correct 2FA code completes login');

  const noProof = await req('POST', '/auth/2fa/disable', {}, goodMfa.json.accessToken);
  assert(noProof.status === 400, '2FA cannot be disabled without proof');
  const disable = await req('POST', '/auth/2fa/disable', { code: totp(secret) }, goodMfa.json.accessToken);
  assert(disable.status === 200, '2FA disabled with valid code');

  console.log('\nALL E2E SECURITY CHECKS PASSED');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

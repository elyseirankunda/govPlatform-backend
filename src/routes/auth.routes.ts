import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import {
  hashPassword,
  randomToken,
  sha256,
  signAccessToken,
  signMfaToken,
  signRefreshToken,
  verifyPassword,
  verifyToken,
} from '../lib/auth';
import { generateTotpSecret, totpProvisioningUri, verifyTotp } from '../lib/totp';
import { asyncHandler, badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/httpError';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { audit } from '../middleware/audit';
import { notify } from '../services/notify.service';
import { env } from '../config/env';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const registerSchema = z.object({
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

const refreshSchema = z.object({ refreshToken: z.string().min(10) });

const forgotSchema = z.object({ username: z.string().min(1) });

const resetSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(8),
});

const profileSchema = z.object({
  fullName: z.string().min(2).optional(),
  phone: z.string().optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).optional(),
  newPassword: z.string().min(8),
});

const mfaLoginSchema = z.object({
  mfaToken: z.string().min(10),
  code: z.string().regex(/^\d{6}$/, 'Verification code must be 6 digits'),
});

const mfaSetupSchema = z.object({
  appName: z.string().min(1).max(60).optional(),
});

const mfaVerifySchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Verification code must be 6 digits') });

const mfaDisableSchema = z.object({
  code: z.string().regex(/^\d{6}$/).optional().or(z.literal('')),
  password: z.string().min(1).optional(),
});

const loginLimiter = rateLimit({
  windowMs: env.authRateLimitWindowMin * 60 * 1000,
  max: env.authRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

async function issueSession(
  userId: number,
  ip: string | undefined,
  userAgent: string | undefined,
) {
  const role = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
  if (!role) throw unauthorized();
  const accessToken = signAccessToken(userId, role.role.slug);
  const refreshToken = signRefreshToken(userId, role.role.slug);

  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(refreshToken),
      ip,
      userAgent,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  return { accessToken, refreshToken };
}

function sessionUserPayload(user: {
  id: number;
  fullName: string;
  username: string;
  email: string | null;
  phone: string | null;
  profilePhoto: string | null;
  role: { slug: string; name: string; level: number };
  mustChangePassword: boolean;
  citizenProfile: { id: number } | null;
}) {
  return {
    id: user.id,
    fullName: user.fullName,
    username: user.username,
    email: user.email,
    phone: user.phone,
    role: user.role.slug,
    roleName: user.role.name,
    level: user.role.level,
    profilePhoto: user.profilePhoto,
    citizenId: user.citizenProfile?.id ?? null,
    mustChangePassword: user.mustChangePassword,
  };
}

router.post(
  '/login',
  loginLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const user = await prisma.user.findFirst({
      where: { OR: [{ username }, { email: username }] },
      include: { role: true, citizenProfile: true },
    });

    const ip = req.ip;
    const ua = req.headers['user-agent'];

    if (!user) {
      await prisma.loginHistory.create({
        data: { email: username, ip, userAgent: ua, success: false, reason: 'UNKNOWN_USER' },
      });
      await audit(req, 'FAILED_LOGIN', 'USER', null, null, { reason: 'UNKNOWN_USER' });
      throw unauthorized('Invalid credentials');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await prisma.loginHistory.create({
        data: { userId: user.id, email: username, ip, userAgent: ua, success: false, reason: 'LOCKED' },
      });
      await audit(req, 'FAILED_LOGIN', 'USER', user.id, null, { reason: 'LOCKED' });
      throw forbidden('Account is temporarily locked. Try again later.');
    }

    if (user.status !== 'ACTIVE') {
      await prisma.loginHistory.create({
        data: { userId: user.id, email: username, ip, userAgent: ua, success: false, reason: user.status },
      });
      await audit(req, 'FAILED_LOGIN', 'USER', user.id, null, { reason: user.status });
      throw forbidden(
        user.status === 'PENDING'
          ? 'Your account is pending approval. An administrator must activate it before you can log in.'
          : 'Account is not active. Contact your administrator.',
      );
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      const attempts = user.failedLoginAttempts + 1;
      const lock = attempts >= 5;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil: lock ? new Date(Date.now() + 15 * 60 * 1000) : user.lockedUntil,
        },
      });
      const reason = lock ? 'LOCKED' : 'WRONG_PASSWORD';
      await prisma.loginHistory.create({
        data: { userId: user.id, email: username, ip, userAgent: ua, success: false, reason },
      });
      await audit(req, 'FAILED_LOGIN', 'USER', user.id, null, { reason });
      if (lock) throw forbidden('Too many failed attempts. Account locked for 15 minutes.');
      throw unauthorized('Invalid credentials');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });

    // Two-factor challenge: do not issue a session until the code is verified.
    if (user.twoFactorEnabled) {
      await audit(req, 'MFA_CHALLENGE_ISSUED', 'USER', user.id);
      return res.json({ requiresTwoFactor: true, mfaToken: signMfaToken(user.id) });
    }

    const { accessToken, refreshToken } = await issueSession(user.id, ip, ua);

    await prisma.loginHistory.create({
      data: { userId: user.id, email: username, ip, userAgent: ua, success: true },
    });
    await audit(req, 'LOGIN', 'USER', user.id, null, { role: user.role.slug });

    const citizenId = user.citizenProfile?.id ?? null;
    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        fullName: user.fullName,
        username: user.username,
        email: user.email,
        phone: user.phone,
        role: user.role.slug,
        roleName: user.role.name,
        level: user.role.level,
        profilePhoto: user.profilePhoto,
        citizenId,
        mustChangePassword: user.mustChangePassword,
      },
    });
  }),
);

/**
 * Completes a login that is protected by two-factor authentication. The caller
 * first posts valid credentials to /login (which returns a short-lived mfaToken)
 * and then submits the TOTP code here.
 */
router.post(
  '/2fa/login',
  loginLimiter,
  validate(mfaLoginSchema),
  asyncHandler(async (req, res) => {
    const { mfaToken, code } = req.body;
    let payload;
    try {
      payload = verifyToken(mfaToken);
    } catch {
      throw unauthorized('MFA session expired. Please log in again.');
    }
    if (payload.type !== 'mfa') throw unauthorized('Invalid MFA token');

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { role: true, citizenProfile: true },
    });
    if (!user) throw unauthorized('Account no longer exists');
    if (user.status !== 'ACTIVE') throw forbidden('Account is not active');
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      throw badRequest('Two-factor authentication is not enabled for this account');
    }

    if (!verifyTotp(user.twoFactorSecret, code)) {
      await prisma.loginHistory.create({
        data: { userId: user.id, email: user.username, ip: req.ip, userAgent: req.headers['user-agent'], success: false, reason: 'MFA_FAILED' },
      });
      await audit(req, 'FAILED_LOGIN', 'USER', user.id, null, { reason: 'MFA_FAILED' });
      throw unauthorized('Invalid verification code');
    }

    const { accessToken, refreshToken } = await issueSession(user.id, req.ip, req.headers['user-agent']);
    await prisma.loginHistory.create({
      data: { userId: user.id, email: user.username, ip: req.ip, userAgent: req.headers['user-agent'], success: true },
    });
    await audit(req, 'LOGIN', 'USER', user.id, null, { role: user.role.slug, mfa: true });

    res.json({ accessToken, refreshToken, user: sessionUserPayload(user) });
  }),
);

/** Starts 2FA enrollment for the authenticated user: generates a TOTP secret. */
router.post(
  '/2fa/setup',
  authenticate,
  validate(mfaSetupSchema),
  asyncHandler(async (req, res) => {
    const me = await prisma.user.findUnique({ where: { id: req.user!.id }, include: { role: true } });
    if (!me) throw notFound();
    if (me.twoFactorEnabled) throw conflict('Two-factor authentication is already enabled');

    const secret = generateTotpSecret();
    await prisma.user.update({ where: { id: me.id }, data: { twoFactorSecret: secret } });
    const appName = req.body.appName || 'Northern Province Gov';
    const otpauthUrl = totpProvisioningUri(secret, me.username, appName);
    await audit(req, 'MFA_SETUP_STARTED', 'USER', me.id);
    res.json({ secret, otpauthUrl, message: 'Scan the code with your authenticator app, then confirm with the 6-digit code.' });
  }),
);

/** Confirms 2FA enrollment by verifying the TOTP code. */
router.post(
  '/2fa/verify',
  authenticate,
  validate(mfaVerifySchema),
  asyncHandler(async (req, res) => {
    const me = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!me) throw notFound();
    if (me.twoFactorEnabled) throw conflict('Two-factor authentication is already enabled');
    if (!me.twoFactorSecret) throw badRequest('No pending 2FA setup. Start the setup first.');

    if (!verifyTotp(me.twoFactorSecret, req.body.code)) {
      throw badRequest('Invalid verification code');
    }

    await prisma.user.update({ where: { id: me.id }, data: { twoFactorEnabled: true } });
    await audit(req, 'MFA_ENABLED', 'USER', me.id);
    res.json({ message: 'Two-factor authentication is now enabled.' });
  }),
);

/** Disables 2FA after verifying the TOTP code OR the current password. */
router.post(
  '/2fa/disable',
  authenticate,
  validate(mfaDisableSchema),
  asyncHandler(async (req, res) => {
    const me = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!me) throw notFound();
    if (!me.twoFactorEnabled) throw badRequest('Two-factor authentication is not enabled');

    const { code, password } = req.body;
    let verified = false;
    if (me.twoFactorSecret && code && verifyTotp(me.twoFactorSecret, code)) {
      verified = true;
    } else if (password && (await verifyPassword(password, me.passwordHash))) {
      verified = true;
    }
    if (!verified) throw badRequest('Provide a valid verification code or your current password');

    await prisma.user.update({
      where: { id: me.id },
      data: { twoFactorEnabled: false, twoFactorSecret: null },
    });
    await audit(req, 'MFA_DISABLED', 'USER', me.id);
    res.json({ message: 'Two-factor authentication has been disabled.' });
  }),
);

router.post(
  '/register',
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const data = req.body;

    const village = await prisma.village.findUnique({
      where: { id: data.villageId },
      include: { cell: { include: { sector: { include: { district: true } } } } },
    });
    if (!village) throw badRequest('Invalid village');

    const existing = await prisma.user.findFirst({
      where: { OR: [{ username: data.username }, { email: data.email || undefined }] },
    });
    if (existing) throw conflict('Username or email already taken');

    const citizenRole = await prisma.role.findUnique({ where: { slug: 'CITIZEN' } });
    if (!citizenRole) throw new Error('Citizen role not seeded');

    const passwordHash = await hashPassword(data.password);

    const user = await prisma.user.create({
      data: {
        fullName: data.fullName,
        username: data.username,
        email: data.email || null,
        phone: data.phone || null,
        passwordHash,
        roleId: citizenRole.id,
        provinceId: village.cell?.sector?.district?.provinceId ?? undefined,
        status: 'PENDING',
      },
    });

    // Resolve full hierarchy
    const cell = await prisma.cell.findUnique({ where: { id: village.cellId } });
    const sector = await prisma.sector.findUnique({ where: { id: cell!.sectorId } });
    const district = await prisma.district.findUnique({ where: { id: sector!.districtId } });

    const citizen = await prisma.citizen.create({
      data: {
        userId: user.id,
        villageId: village.id,
        nationalId: data.nationalId || null,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
        gender: data.gender || null,
      },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: {
        provinceId: district!.provinceId,
        districtId: district!.id,
        sectorId: sector!.id,
        cellId: cell!.id,
        villageId: village.id,
      },
    });

    await audit(req, 'CITIZEN_REGISTER', 'CITIZEN', citizen.id);
    res.status(201).json({
      message: 'Account created. Your registration is pending approval and will be activated by an administrator.',
    });
  }),
);

router.post(
  '/refresh',
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;
    const tokenHash = sha256(refreshToken);
    const session = await prisma.session.findUnique({
      where: { tokenHash },
      include: { user: { include: { role: true } } },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw unauthorized('Invalid or expired session');
    }
    let payload;
    try {
      payload = verifyToken(refreshToken);
    } catch {
      throw unauthorized('Invalid or expired session');
    }
    if (payload.type !== 'refresh' || payload.sub !== session.userId) {
      throw unauthorized('Invalid session');
    }
    const accessToken = signAccessToken(session.userId, session.user.role.slug);
    res.json({ accessToken });
  }),
);

router.post(
  '/logout',
  authenticate,
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;
    await prisma.session.updateMany({
      where: { tokenHash: sha256(refreshToken), userId: req.user!.id },
      data: { revokedAt: new Date() },
    });
    await audit(req, 'LOGOUT', 'USER', req.user!.id);
    res.json({ message: 'Logged out' });
  }),
);

router.post(
  '/forgot-password',
  validate(forgotSchema),
  asyncHandler(async (req, res) => {
    const { username } = req.body;
    const user = await prisma.user.findFirst({ where: { OR: [{ username }, { email: username }] } });
    // Always succeed to avoid account enumeration
    if (user) {
      const token = randomToken();
      await prisma.passwordReset.create({
        data: {
          userId: user.id,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      await audit(req, 'PASSWORD_RESET_REQUESTED', 'USER', user.id);
      // In production an email/SMS would be sent. For the prototype we expose the link.
      if (env.nodeEnv !== 'production') {
        return res.json({ message: 'If the account exists, a reset link was sent.', resetUrl: `${env.appUrl}/reset-password?token=${token}` });
      }
    }
    res.json({ message: 'If the account exists, a reset link was sent.' });
  }),
);

router.post(
  '/reset-password',
  validate(resetSchema),
  asyncHandler(async (req, res) => {
    const { token, password } = req.body;
    const record = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(token) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw badRequest('Invalid or expired reset token');
    }
    const passwordHash = await hashPassword(password);
    await prisma.user.update({ where: { id: record.userId }, data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null } });
    await prisma.passwordReset.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    await prisma.session.updateMany({ where: { userId: record.userId }, data: { revokedAt: new Date() } });
    await audit(req, 'PASSWORD_RESET', 'USER', record.userId);
    res.json({ message: 'Password updated successfully. You can now log in.' });
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        role: true,
        citizenProfile: { include: { village: { include: { cell: { include: { sector: { include: { district: { include: { province: true } } } } } } } } } },
        province: true,
        district: { include: { province: true } },
        sector: { include: { district: { include: { province: true } } } },
        cell: { include: { sector: { include: { district: { include: { province: true } } } } } },
        village: { include: { cell: { include: { sector: { include: { district: { include: { province: true } } } } } } } },
      },
    });
    if (!user) throw notFound('User not found');

    res.json({
      id: user.id,
      fullName: user.fullName,
      username: user.username,
      email: user.email,
      phone: user.phone,
      profilePhoto: user.profilePhoto,
      role: user.role.slug,
      roleName: user.role.name,
      level: user.role.level,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
      twoFactorEnabled: user.twoFactorEnabled,
      mustChangePassword: user.mustChangePassword,
      scope: {
        province: user.province ?? user.district?.province ?? user.sector?.district?.province ?? user.cell?.sector?.district?.province ?? user.village?.cell?.sector?.district?.province ?? user.citizenProfile?.village?.cell?.sector?.district?.province ?? null,
        district: user.district ?? user.sector?.district ?? user.cell?.sector?.district ?? user.village?.cell?.sector?.district ?? user.citizenProfile?.village?.cell?.sector?.district ?? null,
        sector: user.sector ?? user.cell?.sector ?? user.village?.cell?.sector ?? user.citizenProfile?.village?.cell?.sector ?? null,
        cell: user.cell ?? user.village?.cell ?? user.citizenProfile?.village?.cell ?? null,
        village: user.village ?? user.citizenProfile?.village ?? null,
      },
    });
  }),
);

router.put(
  '/profile',
  authenticate,
  validate(profileSchema),
  asyncHandler(async (req, res) => {
    const data = req.body;
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        fullName: data.fullName ?? undefined,
        phone: data.phone ?? undefined,
        email: data.email ?? undefined,
      },
      include: { role: true },
    });
    await audit(req, 'PROFILE_UPDATE', 'USER', user.id);
    res.json({
      message: 'Profile updated',
      user: {
        id: user.id,
        fullName: user.fullName,
        username: user.username,
        email: user.email,
        phone: user.phone,
        profilePhoto: user.profilePhoto,
        role: user.role.slug,
        roleName: user.role.name,
      },
    });
  }),
);

router.put(
  '/password',
  authenticate,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw notFound();
    // When a first-login password change is required, the current (temporary)
    // password does not need to be verified again - the user already proved it
    // by logging in. Otherwise the current password must match.
    if (!user.mustChangePassword) {
      if (!currentPassword) throw badRequest('Current password is required');
      const ok = await verifyPassword(currentPassword, user.passwordHash);
      if (!ok) throw badRequest('Current password is incorrect');
    }
    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false },
    });
    await audit(req, user.mustChangePassword ? 'PASSWORD_SET_FIRST_LOGIN' : 'PASSWORD_CHANGED', 'USER', user.id);
    res.json({ message: 'Password changed successfully' });
  }),
);

router.get(
  '/login-history',
  authenticate,
  asyncHandler(async (req, res) => {
    const items = await prisma.loginHistory.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ items });
  }),
);

export default router;

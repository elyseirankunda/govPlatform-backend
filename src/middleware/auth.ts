import { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { verifyToken } from '../lib/auth';
import { forbidden, unauthorized } from '../lib/httpError';

export interface AuthUser {
  id: number;
  fullName: string;
  role: string;
  roleLevel: number;
  status: string;
  permissions: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

async function loadUser(userId: number) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: { role: { include: { permissions: { select: { slug: true } } } } },
  });
}

function toAuthUser(user: NonNullable<Awaited<ReturnType<typeof loadUser>>>): AuthUser {
  return {
    id: user.id,
    fullName: user.fullName,
    role: user.role.slug,
    roleLevel: user.role.level,
    status: user.status,
    permissions: user.role.permissions.map((p) => p.slug),
  };
}

/** Verifies the bearer access token and attaches req.user. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw unauthorized('Authentication required');
    }
    const token = header.slice(7);
    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    if (payload.type !== 'access') throw unauthorized('Invalid token type');

    const user = await loadUser(payload.sub);
    if (!user) throw unauthorized('Account no longer exists');
    if (user.status !== 'ACTIVE') throw forbidden('Account is not active');

    req.user = toAuthUser(user);
    next();
  } catch (err) {
    next(err);
  }
}

/** Like authenticate, but does not reject anonymous requests. Attaches req.user only if a valid token is present. */
export async function optionalAuthenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      try {
        const token = header.slice(7);
        const payload = verifyToken(token);
        if (payload.type === 'access') {
          const user = await loadUser(payload.sub);
          if (user && user.status === 'ACTIVE') {
            req.user = toAuthUser(user);
          }
        }
      } catch {
        // invalid token -> treat as anonymous
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Role-based guard. Pass the roles allowed (e.g. authorize('PROVINCE_ADMIN')). */
export const authorize =
  (...roles: string[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };

/** Permission-based guard. Pass one or more permissions, any of which grants access. */
export const requirePermission =
  (...permissions: string[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    const has = req.user.permissions.some((p) => permissions.includes(p));
    if (!has) return next(forbidden());
    next();
  };

/** Explicit account-state guard: only ACTIVE accounts pass. */
export const requireActiveAccount =
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (req.user.status !== 'ACTIVE') return next(forbidden('Account is not active'));
    next();
  };

/** Level-based guard: user's role level must be <= maxLevel (higher authority). */
export const atMostLevel =
  (maxLevel: number) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (req.user.roleLevel > maxLevel) return next(forbidden());
    next();
  };

import { Request } from 'express';
import { prisma } from '../lib/prisma';

/**
 * Central audit helper. Logs an action against the audit trail.
 * userId = actor, 0 means system.
 */
export async function audit(
  req: Request,
  action: string,
  entity?: string,
  entityId?: number | null,
  previous?: unknown,
  next?: unknown,
) {
  const userId = req.user?.id ?? null;
  const ip = req.ip ?? null;

  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action,
        entity,
        entityId: entityId ?? null,
        previousValue: previous === undefined ? undefined : typeof previous === 'string' ? previous : JSON.stringify(previous),
        newValue: next === undefined ? undefined : typeof next === 'string' ? next : JSON.stringify(next),
        ip,
      },
    });
  } catch (e) {
    console.error('[audit] failed to write audit log', e);
  }
}

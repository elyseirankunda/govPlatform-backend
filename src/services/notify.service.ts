import { prisma } from '../lib/prisma';

/** Creates an in-app notification for a user. */
export async function notify(
  userId: number,
  title: string,
  content: string,
  type: string,
  link?: string,
) {
  try {
    await prisma.notification.create({
      data: { userId, title, content, type, link },
    });
  } catch (e) {
    console.error('[notify] failed', e);
  }
}

/** Notifies the administrative user who should handle a record at `level` within a village scope. */
export async function notifyLevel(
  level: number,
  provinceId: number,
  districtId: number,
  sectorId: number,
  cellId: number,
  villageId: number,
  title: string,
  content: string,
  type: string,
  link?: string,
): Promise<void> {
  const where =
    level === 1
      ? { role: { level: 1 }, provinceId }
      : level === 2
      ? { role: { level: 2 }, districtId }
      : level === 3
      ? { role: { level: 3 }, sectorId }
      : level === 4
      ? { role: { level: 4 }, cellId }
      : { role: { level: 5 }, villageId };

  const officers = await prisma.user.findMany({
    where: { ...where, status: 'ACTIVE' },
    select: { id: true },
  });

  for (const officer of officers) {
    await notify(officer.id, title, content, type, link);
  }
}

/** Resolve a `?sort=` query value into a Prisma orderBy clause. Falls back to newest-first. */
export function sortBy(key?: unknown, map: Record<string, any> = {}, fallback: any = { createdAt: 'desc' }): any {
  const k = key == null ? '' : String(key);
  if (k && map[k]) return map[k];
  return fallback;
}
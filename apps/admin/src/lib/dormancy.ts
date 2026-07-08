/**
 * Single source of truth for the dormancy rule, shared by the users API
 * (Date values from SQL) and the users UI (ISO strings from JSON).
 */

export const DORMANT_DAYS = 30;

/** Never-active users count as dormant. */
export function isDormant(lastActiveAt: Date | string | null, now = Date.now()): boolean {
  if (!lastActiveAt) return true;
  const t = lastActiveAt instanceof Date ? lastActiveAt.getTime() : new Date(lastActiveAt).getTime();
  return now - t > DORMANT_DAYS * 24 * 60 * 60 * 1000;
}

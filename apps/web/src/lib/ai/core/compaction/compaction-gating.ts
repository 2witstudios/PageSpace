/**
 * Exposure gating for context compaction.
 *
 * Compaction is enabled for all authenticated users. Returning false for null/undefined
 * still excludes unauthenticated callers.
 */
export function canUseCompaction(
  user: { role?: string | null } | null | undefined
): boolean {
  return user != null;
}

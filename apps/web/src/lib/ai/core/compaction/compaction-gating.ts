/**
 * Exposure gating for context compaction.
 *
 * Compaction is admin-only at launch — same `role === 'admin'` check used by
 * Universal Commands. Widening the gate later is a change to this predicate only.
 */
export function canUseCompaction(
  user: { role?: string | null } | null | undefined
): boolean {
  return user?.role === 'admin';
}

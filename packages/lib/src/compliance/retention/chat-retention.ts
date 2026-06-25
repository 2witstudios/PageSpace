/**
 * AI chat retention — pure core (#974).
 *
 * GDPR Art 5(1)(c) (minimisation) / Art 5(1)(e) (storage limitation): AI chat
 * messages and conversations that the user (or an undo) has soft-deleted carry
 * no operational need, yet today they are retained indefinitely (the
 * `purgeInactive*` repository helpers exist but were never scheduled). This
 * module computes the retention cutoff and eligibility so the retention sweep
 * can hard-delete expired soft-deleted chat records.
 *
 * Pure: no I/O, deterministic. The retention-engine edge consumes the cutoff.
 */

/** Default window to keep soft-deleted chat records before hard deletion. */
export const DEFAULT_CHAT_SOFT_DELETE_RETENTION_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolve the configured retention window (days) from an env value, falling
 * back to the default for missing/invalid/non-positive input. Never throws.
 */
export function resolveChatRetentionDays(
  envValue?: string,
  fallback: number = DEFAULT_CHAT_SOFT_DELETE_RETENTION_DAYS,
): number {
  if (envValue === undefined) return fallback;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * The cutoff timestamp: records created strictly before this are expired.
 * `retentionDays` days before `now`.
 */
export function computeChatRetentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * MS_PER_DAY);
}

/**
 * Whether a record created at `recordCreatedAt` is past the retention cutoff.
 * Boundary is exclusive (a record exactly at the cutoff is retained).
 */
export function isChatRecordExpired(recordCreatedAt: Date, cutoff: Date): boolean {
  return recordCreatedAt.getTime() < cutoff.getTime();
}

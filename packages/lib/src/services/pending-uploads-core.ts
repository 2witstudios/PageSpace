/**
 * Pure core for TTL'd pending-upload rows (#2154).
 *
 * The per-user concurrent-upload limit used to be a `users.activeUploads`
 * counter incremented at presign and decremented at complete/cancel — which
 * leaked +1 forever whenever the process died between the two (the sweep that
 * repaired abandoned slots was per-process, in-memory). The limit is now
 * DERIVED: one `pending_uploads` row per presign, and "in flight" means a row
 * whose expiresAt is still in the future. A crashed process leaves rows that
 * expire on their own, so no restart can permanently consume a slot.
 */

/**
 * How long a pending-upload row stays live without being completed/cancelled.
 * Matches the upload semaphore's in-memory slot timeout so the DB row and the
 * slot that issued it expire together.
 */
export const PENDING_UPLOAD_TTL_MS = 10 * 60 * 1000;

/**
 * Expiry timestamp for a row created at `nowMs`. A non-finite or non-positive
 * TTL falls back to the default rather than minting an already-expired (or
 * immortal) row.
 */
export function pendingUploadExpiresAt(nowMs: number, ttlMs: number = PENDING_UPLOAD_TTL_MS): Date {
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : PENDING_UPLOAD_TTL_MS;
  return new Date(nowMs + ttl);
}

/** A row is live strictly BEFORE its expiry instant (expiresAt > now). */
export function isPendingUploadLive(row: { expiresAt: Date }, nowMs: number): boolean {
  return row.expiresAt.getTime() > nowMs;
}

/** Count the rows that still hold a slot at `nowMs`. */
export function countLivePendingUploads(
  rows: ReadonlyArray<{ expiresAt: Date }>,
  nowMs: number,
): number {
  let count = 0;
  for (const row of rows) if (isPendingUploadLive(row, nowMs)) count++;
  return count;
}

/**
 * Whether a new upload may start given the user's live in-flight count and
 * their tier's concurrency limit. Garbage inputs deny (fail closed).
 */
export function canStartUpload(liveCount: number, maxConcurrentUploads: number): boolean {
  if (!Number.isFinite(liveCount) || !Number.isFinite(maxConcurrentUploads)) return false;
  if (maxConcurrentUploads <= 0) return false;
  return liveCount < maxConcurrentUploads;
}

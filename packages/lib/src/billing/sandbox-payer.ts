/**
 * resolveSessionPayerId — the ONE seam that names who pays for a sandbox's
 * active runtime, and (via the storage reconcile) its persistent storage.
 *
 * A session is a drive-level workspace (contract.ts invariant 1): its bill
 * lands on the drive's owner when it has one, or on the session's own
 * `ownerId` for a user-scoped global-assistant session (`driveId` null) — the
 * SAME attribution rule `storageBillingTarget`
 * (`services/sandbox/sandbox-storage-attribution.ts`) decides for storage.
 * This is the charge-time twin of that rule: where the storage reconcile
 * SKIPS a row whose drive owner can't be resolved (a stale read mid-delete,
 * self-corrects next run), a live runtime charge has already happened and
 * needs a payer NOW, so it falls back to the session's own `ownerId` instead.
 *
 * Deliberately keyed on the session's OWN `driveId`/`ownerId`, never on the
 * caller's surface drive or the conversation's agent page — a session hosts
 * MANY conversations (possibly with agents from a different drive than the
 * one the caller happens to be chatting from), and the payer must not depend
 * on which conversation the request came through.
 *
 * `lookupDriveOwnerId` is injected (not a direct DB import) so this stays a
 * pure, independently-testable seam.
 */
export interface ResolveSessionPayerInput {
  /** The session's own drive; null for a user-scoped global-assistant session. */
  driveId: string | null;
  /** The session's own owner — the fallback payer, and the ONLY payer when `driveId` is null. */
  ownerId: string;
  /** Resolves a drive's `ownerId`; null when it can't be resolved (e.g. a stale read of a drive mid-delete). */
  lookupDriveOwnerId: (driveId: string) => Promise<string | null>;
}

export async function resolveSessionPayerId(input: ResolveSessionPayerInput): Promise<string> {
  if (!input.driveId) return input.ownerId;
  const ownerId = await input.lookupDriveOwnerId(input.driveId);
  return ownerId ?? input.ownerId;
}

/**
 * Real DB-backed drive→owner lookup — the ONE place this read is written for
 * billing. A session is a drive-level workspace, so its runtime/storage bills
 * the drive's owner; null when the drive cannot be found (a stale read mid-delete
 * — callers fall back to the session's own owner, or skip, per their own policy).
 */
export async function lookupDriveOwnerId(driveId: string): Promise<string | null> {
  const { db } = await import('@pagespace/db/db');
  const { eq } = await import('@pagespace/db/operators');
  const { drives } = await import('@pagespace/db/schema/core');

  const [row] = await db
    .select({ ownerId: drives.ownerId })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  return row?.ownerId ?? null;
}

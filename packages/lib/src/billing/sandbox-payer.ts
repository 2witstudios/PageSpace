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

/**
 * resolveEnvPayerId — who pays for a drive ENVIRONMENT.
 *
 * **The environment is the billed unit.** An env is the persistence unit the
 * platform sells: a machine a drive returns to, which outlives every session
 * run inside it. Its bill is keyed to THAT — the env's persistence, plus
 * whatever size/class attribute a future tier adds — and deliberately NOT to
 * the substrate underneath it. Envs will grow bigger guests, GPU/local-AI
 * machines and non-Fly substrates; every one of those is a provisioning
 * change, and none of them may change what this function answers or what the
 * storage meter charges for. Billing language stays substrate-agnostic so the
 * two can move independently.
 *
 * **Deliberate divergence from `resolveSessionPayerId` (commit 3abaf6bb3's
 * session-unified payer): there is NO `ownerId` fallback here, and there is no
 * `ownerId` to fall back TO.** A session has an owner — it is a user's working
 * context, so a failed drive lookup can still land the bill on the person who
 * opened it. An env has none: `drive_envs.createdBy` is AUDIT ONLY (nullable,
 * `set null` on user delete) and resolves neither payment nor lifecycle, because
 * an env is DRIVE-owned and drive-shared — the creator leaving must not strand
 * or re-bill a machine the drive still uses. So the drive owner is the only
 * honest payer, and an unresolvable drive (a stale read of one mid-delete) means
 * this cycle is SKIPPED rather than misattributed: exactly the rule the storage
 * reconcile already applies to its drive-scoped rows, where a money movement to
 * the wrong payer cannot be taken back but one skipped accrual cycle
 * self-corrects on the next tick.
 */
export interface ResolveEnvPayerInput {
  /** The env's owning drive. NOT NULL on `drive_envs` — an env has no user-scoped form. */
  driveId: string;
  /** Resolves a drive's `ownerId`; null when it can't be resolved (e.g. a stale read of a drive mid-delete). */
  lookupDriveOwnerId: (driveId: string) => Promise<string | null>;
}

/** The drive's owner, or null when the drive can't be resolved — callers SKIP, never substitute another payer. */
export async function resolveEnvPayerId(input: ResolveEnvPayerInput): Promise<string | null> {
  return input.lookupDriveOwnerId(input.driveId);
}

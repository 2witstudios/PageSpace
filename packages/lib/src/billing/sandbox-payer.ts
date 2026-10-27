import { driveAccrualChargeFor, type ComputeCharge } from './compute-charge';

/**
 * Who a bill lands on (Spec WAL-9): a person, or an organization. An org drive's storage,
 * sandbox runtime, environments and published apps bill the org; everything else bills a
 * person. The payer is a value, never a bare id, so no caller can mistake an org for a user.
 */
export type BillingPayer = { kind: 'user'; userId: string } | { kind: 'org'; orgId: string };

/** The two drive columns that decide a drive's payer. */
export interface DriveBillingFacts {
  ownerId: string;
  orgId: string | null;
}

/** WAL-9: the org if drives.orgId is set, else the drive's owner. */
export function payerForDrive(drive: DriveBillingFacts): BillingPayer {
  return drive.orgId !== null ? { kind: 'org', orgId: drive.orgId } : { kind: 'user', userId: drive.ownerId };
}

/** Resolves a drive's billing facts; null when it can't be resolved (e.g. a stale read mid-delete). */
export type LookupDriveBillingFacts = (driveId: string) => Promise<DriveBillingFacts | null>;

/**
 * resolveSessionPayer — the ONE seam that names who pays for a sandbox's active runtime, and
 * (via the storage reconcile) its persistent storage.
 *
 * A session is a drive-level workspace (contract.ts invariant 1): its bill lands on the drive's
 * payer (WAL-9: the org for an org drive, else the drive's owner), or on the session's own
 * `ownerId` for a user-scoped global-assistant session (`driveId` null) — the SAME attribution
 * rule `storageBillingTarget` (`services/sandbox/sandbox-storage-attribution.ts`) decides for
 * storage.
 *
 * A DRIVE session whose drive cannot be resolved (a stale read mid-delete) has NO payer: null.
 * It never falls back to the session's owner — the drive may be an org's, and a person is never
 * billed for an org drive's session (WAL-9). Callers refuse the run (nothing starts, nothing is
 * charged) or skip the accrual, exactly as an environment's unresolvable drive is skipped.
 *
 * Deliberately keyed on the session's OWN `driveId`/`ownerId`, never on the caller's surface
 * drive or the conversation's agent page — a session hosts MANY conversations (possibly with
 * agents from a different drive than the one the caller happens to be chatting from), and the
 * payer must not depend on which conversation the request came through.
 *
 * `lookupDriveBillingFacts` is injected (not a direct DB import) so this stays a pure,
 * independently-testable seam.
 */
export interface ResolveSessionPayerInput {
  /** The session's own drive; null for a user-scoped global-assistant session. */
  driveId: string | null;
  /** The session's own owner — the payer ONLY when `driveId` is null. */
  ownerId: string;
  lookupDriveBillingFacts: LookupDriveBillingFacts;
}

/** The session's payer, or null when its drive cannot be resolved — callers refuse or skip, never substitute a person. */
export async function resolveSessionPayer(input: ResolveSessionPayerInput): Promise<BillingPayer | null> {
  if (!input.driveId) return { kind: 'user', userId: input.ownerId };
  const facts = await input.lookupDriveBillingFacts(input.driveId);
  return facts ? payerForDrive(facts) : null;
}

/**
 * Real DB-backed drive → billing facts lookup — the ONE place this read is written for billing.
 * Null when the drive cannot be found (a stale read mid-delete — callers refuse or skip; none
 * substitutes another payer).
 */
export async function lookupDriveBillingFacts(driveId: string): Promise<DriveBillingFacts | null> {
  const { db } = await import('@pagespace/db/db');
  const { eq } = await import('@pagespace/db/operators');
  const { drives } = await import('@pagespace/db/schema/core');

  const [row] = await db
    .select({ ownerId: drives.ownerId, orgId: drives.orgId })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  return row ? { ownerId: row.ownerId, orgId: row.orgId ?? null } : null;
}

/**
 * resolveEnvPayer — who pays for a drive ENVIRONMENT.
 *
 * **The environment is the billed unit.** An env is the persistence unit the platform sells: a
 * machine a drive returns to, which outlives every session run inside it. Its bill is keyed to
 * THAT — the env's persistence, plus whatever size/class attribute a future tier adds — and
 * deliberately NOT to the substrate underneath it. Billing language stays substrate-agnostic so
 * the two can move independently.
 *
 * **There is NO `ownerId` fallback here, as there is none for a drive session, and there is no
 * `ownerId` to fall back TO.** An env has none: `drive_envs.createdBy` is AUDIT ONLY (nullable, `set null` on user delete) and
 * resolves neither payment nor lifecycle, because an env is DRIVE-owned and drive-shared. So the
 * drive's payer (WAL-9: the org for an org drive, else the owner) is the only honest payer, and
 * an unresolvable drive means this cycle is SKIPPED rather than misattributed: a money movement
 * to the wrong payer cannot be taken back, but one skipped accrual cycle self-corrects on the
 * next tick.
 */
export interface ResolveEnvPayerInput {
  /** The env's owning drive. NOT NULL on `drive_envs` — an env has no user-scoped form. */
  driveId: string;
  lookupDriveBillingFacts: LookupDriveBillingFacts;
}

/** The drive's payer, or null when the drive can't be resolved — callers SKIP, never substitute another payer. */
export async function resolveEnvPayer(input: ResolveEnvPayerInput): Promise<BillingPayer | null> {
  const facts = await input.lookupDriveBillingFacts(input.driveId);
  return facts ? payerForDrive(facts) : null;
}

/**
 * resolveEnvCharge — the compute charge for an ENVIRONMENT or a published app (which hangs off
 * one): the drive's payer via {@link resolveEnvPayer}, with the same no-fallback rule. An org
 * drive charges the org POOL — never anyone's own wallet — recorded under, and capped against,
 * the resource's COST OWNER ([D-OW-28]: `drive_envs.costOwnerId` / `published_apps.costOwnerId`,
 * the member who created it). With none (created before D-OW-28, or its creator left the org) it
 * is the drive's LEAD, who is accountable for the drive. Null = unresolvable: callers skip.
 */
export async function resolveEnvCharge(input: ResolveEnvPayerInput & {
  /** The env's or app's `costOwnerId`; null attributes to the drive lead. Required, so no caller forgets it. */
  costOwnerId: string | null;
}): Promise<ComputeCharge | null> {
  const facts = await input.lookupDriveBillingFacts(input.driveId);
  return facts ? driveAccrualChargeFor(payerForDrive(facts), input.costOwnerId ?? facts.ownerId) : null;
}


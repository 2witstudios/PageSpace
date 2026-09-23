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

/**
 * The interim refusal for an org payer at a compute charge site (WAL-9).
 *
 * An org drive's sandbox runtime, environments, published apps and machine storage bill the
 * org's pool wallet. Today every compute charge path (`canConsumeAI` holds, the ledger accrual
 * behind `AIMonitoring.trackUsage`, Stripe for dedicated hosting) can only debit a PERSON'S
 * wallet, so a charge site handed an org payer REFUSES by this name — it never bills the drive
 * lead instead, not even temporarily (point-guard ruling on C7, 2026-09-23). Orgs are dark
 * (ORGS_ENABLED false), so no live drive reaches it.
 *
 * REPLACED BY: the C3 lane (board leaf ir4t1nhxws049e3ay4qeuqig, "credit gate takes actor,
 * drive, chosen wallet; holds per wallet"), whose wallet-keyed holds and settlement let these
 * sites charge the org pool directly. The orchestrator filed the wiring follow-up; when it
 * lands, every caller of `requireUserPayer` is a site to convert, and this refusal goes away.
 */
export const ORG_BILLING_PENDING = 'org_billing_pending' as const;

export interface OrgBillingPendingRefusal {
  code: typeof ORG_BILLING_PENDING;
  orgId: string;
  message: string;
}

export const ORG_BILLING_PENDING_MESSAGE =
  "This drive belongs to an organization, and organization billing for compute isn't available yet.";

export type UserPayerResult = { ok: true; userId: string } | { ok: false; refusal: OrgBillingPendingRefusal };

/** A person to charge, or the named interim refusal for an org payer. Never a substitute. */
export function requireUserPayer(payer: BillingPayer): UserPayerResult {
  if (payer.kind === 'user') return { ok: true, userId: payer.userId };
  return { ok: false, refusal: { code: ORG_BILLING_PENDING, orgId: payer.orgId, message: ORG_BILLING_PENDING_MESSAGE } };
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
 * storage. This is the charge-time twin of that rule: where the storage reconcile SKIPS a row
 * whose drive can't be resolved (a stale read mid-delete, self-corrects next run), a live
 * runtime charge has already happened and needs a payer NOW, so it falls back to the session's
 * own `ownerId` instead.
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
  /** The session's own owner — the fallback payer, and the ONLY payer when `driveId` is null. */
  ownerId: string;
  lookupDriveBillingFacts: LookupDriveBillingFacts;
}

export async function resolveSessionPayer(input: ResolveSessionPayerInput): Promise<BillingPayer> {
  if (!input.driveId) return { kind: 'user', userId: input.ownerId };
  const facts = await input.lookupDriveBillingFacts(input.driveId);
  return facts ? payerForDrive(facts) : { kind: 'user', userId: input.ownerId };
}

/**
 * Real DB-backed drive → billing facts lookup — the ONE place this read is written for billing.
 * Null when the drive cannot be found (a stale read mid-delete — callers fall back to the
 * session's own owner, or skip, per their own policy).
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
 * **Deliberate divergence from `resolveSessionPayer`: there is NO `ownerId` fallback here, and
 * there is no `ownerId` to fall back TO.** A session has an owner — it is a user's working
 * context, so a failed drive lookup can still land the bill on the person who opened it. An env
 * has none: `drive_envs.createdBy` is AUDIT ONLY (nullable, `set null` on user delete) and
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

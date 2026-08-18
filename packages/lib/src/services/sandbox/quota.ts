/**
 * Code execution quota: per-tier concurrency.
 *
 * Fly Sprites exposes no platform spend cap, so the app owns the cost ceiling.
 * The control here is concurrency: an in-process per-user semaphore whose ceiling
 * scales by subscription tier (mirrors `upload-semaphore.ts`, expressed
 * functionally). Combined with sandbox hibernation (idle sandboxes hibernate, so
 * cost tracks active time, not provisioned count) this bounds active compute.
 *
 * There is intentionally NO per-run daily budget: a run-count window meters tool
 * calls, not compute, and punishes long agentic sessions for being productive.
 * Real usage metering (sandbox-hours / active runtime) is tracked as a follow-up.
 *
 * `checkCodeExecutionQuota` is an ADVISORY preflight: it reports whether a run
 * would be allowed (i.e. whether a concurrency slot is free) without consuming
 * one. The single real reservation (`acquireCodeExecutionSlot`) happens at
 * execution time; that caller must treat a passing preflight as advisory and
 * handle `acquire === false`.
 */

import type { SubscriptionTier } from '../subscription-utils';
import { isSandboxAvailable } from '../../billing/sandbox-eligibility';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  return Number.parseInt(raw, 10);
}

// Concurrent runs permitted per user, by subscription tier. Per-process: each
// replica enforces this independently, matching the upload-semaphore model.
// Free's value is a pure concurrency ceiling, not an eligibility switch — the
// REAL free-tier block is `isSandboxAvailable` below, checked as a defense-in-
// depth backstop ahead of both concurrency checks in this file, in addition to
// (not instead of) `can-run-code.ts`'s own tier-eligibility gate.
const CONCURRENCY_LIMITS: Record<SubscriptionTier, number> = {
  free: envInt('CODE_EXEC_CONCURRENCY_FREE', 1),
  pro: envInt('CODE_EXEC_CONCURRENCY_PRO', 10),
  founder: envInt('CODE_EXEC_CONCURRENCY_FOUNDER', 20),
  business: envInt('CODE_EXEC_CONCURRENCY_BUSINESS', 50),
};

const activeByUser = new Map<string, number>();

export function getCodeExecutionConcurrencyLimit(tier: SubscriptionTier): number {
  return CONCURRENCY_LIMITS[tier];
}

export function canAcquireCodeExecutionSlot({
  userId,
  tier,
}: {
  userId: string;
  tier: SubscriptionTier;
}): boolean {
  if (!isSandboxAvailable(tier)) return false;
  return (activeByUser.get(userId) ?? 0) < CONCURRENCY_LIMITS[tier];
}

export function acquireCodeExecutionSlot({
  userId,
  tier,
}: {
  userId: string;
  tier: SubscriptionTier;
}): boolean {
  if (!canAcquireCodeExecutionSlot({ userId, tier })) return false;
  activeByUser.set(userId, (activeByUser.get(userId) ?? 0) + 1);
  return true;
}

export function releaseCodeExecutionSlot({ userId }: { userId: string }): void {
  const next = (activeByUser.get(userId) ?? 0) - 1;
  if (next <= 0) {
    activeByUser.delete(userId);
  } else {
    activeByUser.set(userId, next);
  }
}

/** Clear all concurrency state. Test-only seam. */
export function resetCodeExecutionConcurrency(): void {
  activeByUser.clear();
}

export type QuotaDenialReason = 'concurrency_limit' | 'tier_ineligible';

export type CodeExecutionQuotaDecision =
  | { allowed: true }
  | { allowed: false; reason: QuotaDenialReason };

export interface CodeExecutionQuotaDeps {
  canAcquireSlot: (args: { userId: string; tier: SubscriptionTier }) => boolean;
}

const defaultDeps: CodeExecutionQuotaDeps = {
  canAcquireSlot: canAcquireCodeExecutionSlot,
};

export interface CheckCodeExecutionQuotaInput {
  userId: string;
  /** Carried for call-site symmetry; concurrency is per-user, so scope is unused. */
  driveId?: string;
  tenantId?: string;
  tier: SubscriptionTier;
  deps?: CodeExecutionQuotaDeps;
}

export async function checkCodeExecutionQuota({
  userId,
  tier,
  deps = defaultDeps,
}: CheckCodeExecutionQuotaInput): Promise<CodeExecutionQuotaDecision> {
  // Defense in depth, ahead of (not instead of) can-run-code.ts's own
  // tier-eligibility gate — checked explicitly, and BEFORE the concurrency
  // slot check, so a free-tier denial is never mislabeled `concurrency_limit`.
  if (!isSandboxAvailable(tier)) {
    return { allowed: false, reason: 'tier_ineligible' };
  }
  if (!deps.canAcquireSlot({ userId, tier })) {
    return { allowed: false, reason: 'concurrency_limit' };
  }
  return { allowed: true };
}

/**
 * checkAgentSessionConcurrency — the agent-sessions twin of
 * `checkCodeExecutionQuota` above (Phase 7). Where that check is an in-process,
 * per-user semaphore over ACTIVE RUNS (acquired at run start, released at run
 * end), this is a DB-backed count of an owner's LIVE `agent_workspaces` rows
 * (`sandboxId` set, `spriteTornDownAt` still null) — a distinct axis: a
 * hibernating sandbox holds no active run yet still counts here, exactly as a
 * live Sprite still bills storage while idle. Per-tier ceilings are the SAME
 * `CONCURRENCY_LIMITS` the run semaphore uses — one set of tier numbers, two
 * independent things they cap.
 *
 * `countLiveAgentSessions` is injected (the real implementation is
 * `AgentSessionStore.countLive`, wired by the app) so this stays testable
 * with no database.
 */
export interface CheckAgentSessionConcurrencyInput {
  ownerId: string;
  tier: SubscriptionTier;
  countLiveAgentSessions: (ownerId: string) => Promise<number>;
  /**
   * Whether this session ALREADY holds a live sandbox (its row carries a
   * `sandboxId`). Such a session is already counted by `countLive`, so gating it
   * would refuse an owner sitting at the ceiling access to a Sprite they are
   * already paying for — a resume is not a new allocation. The caller passes the
   * fact; the decision to skip lives here, not at the call site, so the ceiling
   * has exactly ONE place it can be wrong.
   */
  alreadyProvisioned?: boolean;
}

export async function checkAgentSessionConcurrency({
  ownerId,
  tier,
  countLiveAgentSessions,
  alreadyProvisioned = false,
}: CheckAgentSessionConcurrencyInput): Promise<CodeExecutionQuotaDecision> {
  // Defense in depth, ahead of (not instead of) can-run-code.ts's own
  // tier-eligibility gate — checked FIRST, even ahead of `alreadyProvisioned`:
  // a downgraded owner's already-live sandbox must not keep resuming just
  // because it was allocated before the downgrade.
  if (!isSandboxAvailable(tier)) {
    return { allowed: false, reason: 'tier_ineligible' };
  }
  if (alreadyProvisioned) return { allowed: true };
  const liveCount = await countLiveAgentSessions(ownerId);
  if (liveCount >= CONCURRENCY_LIMITS[tier]) {
    return { allowed: false, reason: 'concurrency_limit' };
  }
  return { allowed: true };
}

/**
 * Per-session active-runtime guardrail (Terminal Epic 1 T1.5).
 *
 * A pulled-forward, minimal cost backstop ahead of Epic 3's full usage
 * metering: an agent that keeps a persistent session's sandbox continuously
 * busy (back-to-back tool calls, no idle gaps) is capped at a configurable
 * wall-clock duration instead of running unbounded. This tracks CONTINUOUS
 * activity per session, not lifetime usage — a gap longer than the grace
 * window resets the clock, so a session that goes idle (naturally, or via
 * Sprite hibernation) recovers full budget rather than being capped forever.
 *
 * Deliberately separate from the per-user concurrency semaphore above: that
 * bounds how many runs a USER has in flight; this bounds how long a single
 * SESSION's sandbox has been kept continuously active, regardless of which
 * user/agent is driving it.
 */

const SESSION_MAX_ACTIVE_SECONDS_ENV = 'TERMINAL_SESSION_MAX_ACTIVE_SECONDS';
const DEFAULT_SESSION_MAX_ACTIVE_SECONDS = 4 * 60 * 60; // 4 hours
/** A gap longer than this between calls resets the continuous-activity clock. */
export const SESSION_ACTIVITY_GRACE_MS = 5 * 60 * 1000;

export function getSessionMaxActiveSeconds(): number {
  const raw = process.env[SESSION_MAX_ACTIVE_SECONDS_ENV];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_MAX_ACTIVE_SECONDS;
}

interface SessionActivityState {
  firstActiveAt: number;
  lastActiveAt: number;
}

const sessionActivityByKey = new Map<string, SessionActivityState>();

export type SessionRuntimeGuardrailReason = 'session_runtime_exceeded';

export type SessionRuntimeGuardrailDecision =
  | { allowed: true }
  | { allowed: false; reason: SessionRuntimeGuardrailReason };

/**
 * Drop entries whose gap has already exceeded the grace window: once that's
 * true, `checkSessionRuntimeGuardrail` treats the key as if it had no state
 * anyway, so the entry is pure dead weight. Without this, every distinct
 * session ever acquired would occupy an entry for the life of the process —
 * unlike the per-user semaphore above, this map has no symmetric
 * acquire/release to hook a delete into, so eviction has to be opportunistic.
 */
function evictStaleSessionActivity(now: number): void {
  for (const [key, state] of sessionActivityByKey) {
    if (now - state.lastActiveAt > SESSION_ACTIVITY_GRACE_MS) {
      sessionActivityByKey.delete(key);
    }
  }
}

/**
 * Advisory check: has this session's sandbox been continuously active (no gap
 * longer than `SESSION_ACTIVITY_GRACE_MS`) for at least `maxActiveSeconds`?
 * Pure read — does not itself record activity; callers must also call
 * `recordSessionActivity` on every acquisition (allowed or not) so a stalled
 * caller who never records still reflects real elapsed time.
 */
export function checkSessionRuntimeGuardrail({
  workspaceId,
  now,
  maxActiveSeconds = getSessionMaxActiveSeconds(),
}: {
  workspaceId: string;
  now: number;
  maxActiveSeconds?: number;
}): SessionRuntimeGuardrailDecision {
  const state = sessionActivityByKey.get(workspaceId);
  if (state && now - state.lastActiveAt <= SESSION_ACTIVITY_GRACE_MS) {
    const activeMs = now - state.firstActiveAt;
    if (activeMs >= maxActiveSeconds * 1000) {
      return { allowed: false, reason: 'session_runtime_exceeded' };
    }
  }
  return { allowed: true };
}

/**
 * Record that this session's sandbox was just active. Starts (or continues)
 * the continuous-activity window; a gap longer than the grace period starts
 * a fresh window instead of extending the old one.
 */
export function recordSessionActivity({ workspaceId, now }: { workspaceId: string; now: number }): void {
  // Opportunistic sweep: every acquisition is a natural checkpoint to reclaim
  // any OTHER session's entry that has gone idle, keeping the map bounded by
  // currently (or recently) active sessions rather than every session ever seen.
  evictStaleSessionActivity(now);
  const state = sessionActivityByKey.get(workspaceId);
  if (!state || now - state.lastActiveAt > SESSION_ACTIVITY_GRACE_MS) {
    sessionActivityByKey.set(workspaceId, { firstActiveAt: now, lastActiveAt: now });
  } else {
    state.lastActiveAt = now;
  }
}

/** Clear all session-runtime guardrail state. Test-only seam. */
export function resetSessionRuntimeGuardrail(): void {
  sessionActivityByKey.clear();
}

/** Current guardrail map size — test-only seam for verifying eviction bounds memory. */
export function sessionActivityMapSize(): number {
  return sessionActivityByKey.size;
}

/**
 * checkDriveEnvAllowance — the per-payer ceiling on PERSISTENT environments
 * (`drive_envs`), the third axis this module caps and the only one that meters a
 * ROW rather than a running thing.
 *
 * The other two ceilings above bound compute in flight: `checkCodeExecutionQuota`
 * caps concurrent RUNS, `checkAgentSessionConcurrency` caps LIVE SANDBOXES. An
 * environment is neither. It is the billed PERSISTENCE unit: its row exists (and
 * its filesystem keeps accruing storage cost) whether or not anyone is running
 * anything inside it, and its whole purpose is to outlive every session that
 * touches it. So the count that matters is how many envs the payer OWNS, not how
 * many are awake — an env hibernating for a month still holds a disk someone is
 * paying for.
 *
 * That is also why this gate belongs at `createDriveEnv` rather than at
 * provisioning time, where the two ceilings above sit: creating the row is the
 * moment the persistence is committed to, and an env that has never been
 * provisioned is still an env the payer holds.
 *
 * **Ceilings, and the fact that they are placeholders.** The numbers below are a
 * deliberate first cut pending the economics sign-off — free 0 (an env is a
 * paid-tier feature; `isSandboxAvailable` already says so, and this table
 * agrees rather than contradicting it), pro 2, founder 5, business 10. Each is
 * overridable by env var (`DRIVE_ENV_LIMIT_FREE` and friends) precisely because
 * they will move: an operator can retune a tier without a deploy, and the
 * pricing work can land its real numbers as a one-line change.
 *
 * `payerId` is the DRIVE OWNER — envs are drive-owned and drive-billed, so a
 * free-tier member creating an env in a Pro-owned drive is entitled and metered
 * against the drive's owner, exactly as sandbox eligibility already resolves
 * (`resolveSandboxPayerTier`). `countEnvsOwnedBy` is injected (the real
 * implementation is `DriveEnvStore.countEnvsOwnedBy`, wired by the app) so this
 * stays testable with no database.
 */
const DRIVE_ENV_LIMITS: Record<SubscriptionTier, number> = {
  free: envInt('DRIVE_ENV_LIMIT_FREE', 0),
  pro: envInt('DRIVE_ENV_LIMIT_PRO', 2),
  founder: envInt('DRIVE_ENV_LIMIT_FOUNDER', 5),
  business: envInt('DRIVE_ENV_LIMIT_BUSINESS', 10),
};

/** The env ceiling for a tier — exported so a caller (or a test) can say WHAT the limit was, not just that it was hit. */
export function getDriveEnvLimit(tier: SubscriptionTier): number {
  return DRIVE_ENV_LIMITS[tier];
}

/**
 * Deliberately its own denial word rather than reusing `concurrency_limit`:
 * these are different ceilings with different remedies (end a session vs. delete
 * an environment), the API maps them to different messages, and the security
 * audit files them as different events. Conflating them would tell a user to
 * close sessions when what they have run out of is environments.
 */
export type DriveEnvAllowanceDenialReason = 'tier_ineligible' | 'env_limit_reached';

export type DriveEnvAllowanceDecision =
  | { allowed: true }
  | { allowed: false; reason: DriveEnvAllowanceDenialReason; limit: number };

export interface CheckDriveEnvAllowanceInput {
  /** The DRIVE OWNER — envs are drive-owned and drive-billed. */
  payerId: string;
  /** The payer's tier, resolved by the caller (drive owner's subscription). */
  tier: SubscriptionTier;
  countEnvsOwnedBy: (payerId: string) => Promise<number>;
}

export async function checkDriveEnvAllowance({
  payerId,
  tier,
  countEnvsOwnedBy,
}: CheckDriveEnvAllowanceInput): Promise<DriveEnvAllowanceDecision> {
  const limit = DRIVE_ENV_LIMITS[tier];
  // Eligibility FIRST, and ahead of any count: a free-tier payer is refused for
  // being on a tier without cloud machines at all, which is a different thing to
  // tell them than "you are at your limit" — and it costs no database round-trip
  // to say. Checked here as defense in depth, in addition to (not instead of)
  // `can-run-code.ts`'s own tier gate, matching both checks above.
  if (!isSandboxAvailable(tier)) {
    return { allowed: false, reason: 'tier_ineligible', limit };
  }
  const owned = await countEnvsOwnedBy(payerId);
  if (owned >= limit) {
    return { allowed: false, reason: 'env_limit_reached', limit };
  }
  return { allowed: true };
}

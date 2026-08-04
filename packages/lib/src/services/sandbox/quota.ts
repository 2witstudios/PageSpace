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
 * end), this is a DB-backed count of an owner's LIVE `agent_sessions` rows
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
  sessionId,
  now,
  maxActiveSeconds = getSessionMaxActiveSeconds(),
}: {
  sessionId: string;
  now: number;
  maxActiveSeconds?: number;
}): SessionRuntimeGuardrailDecision {
  const state = sessionActivityByKey.get(sessionId);
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
export function recordSessionActivity({ sessionId, now }: { sessionId: string; now: number }): void {
  // Opportunistic sweep: every acquisition is a natural checkpoint to reclaim
  // any OTHER session's entry that has gone idle, keeping the map bounded by
  // currently (or recently) active sessions rather than every session ever seen.
  evictStaleSessionActivity(now);
  const state = sessionActivityByKey.get(sessionId);
  if (!state || now - state.lastActiveAt > SESSION_ACTIVITY_GRACE_MS) {
    sessionActivityByKey.set(sessionId, { firstActiveAt: now, lastActiveAt: now });
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

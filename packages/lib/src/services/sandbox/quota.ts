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

// Concurrent runs permitted per user, by subscription tier. Per-process: each
// replica enforces this independently, matching the upload-semaphore model.
const CONCURRENCY_LIMITS: Record<SubscriptionTier, number> = {
  free: 1,
  pro: 2,
  founder: 3,
  business: 5,
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

export type QuotaDenialReason = 'concurrency_limit';

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
  if (!deps.canAcquireSlot({ userId, tier })) {
    return { allowed: false, reason: 'concurrency_limit' };
  }
  return { allowed: true };
}

/**
 * Per-machine active-runtime guardrail (Terminal Epic 1 T1.5).
 *
 * A pulled-forward, minimal cost backstop ahead of Epic 3's full usage
 * metering: an agent that keeps a persistent machine continuously busy
 * (back-to-back tool calls, no idle gaps) is capped at a configurable
 * wall-clock duration instead of running unbounded. This tracks CONTINUOUS
 * activity per machine, not lifetime usage — a gap longer than the grace
 * window resets the clock, so a machine that goes idle (naturally, or via
 * Sprite hibernation) recovers full budget rather than being capped forever.
 *
 * Deliberately separate from the per-user concurrency semaphore above: that
 * bounds how many runs a USER has in flight; this bounds how long a single
 * MACHINE has been kept continuously active, regardless of which user/agent
 * is driving it.
 */

const MACHINE_MAX_ACTIVE_SECONDS_ENV = 'TERMINAL_MACHINE_MAX_ACTIVE_SECONDS';
const DEFAULT_MACHINE_MAX_ACTIVE_SECONDS = 4 * 60 * 60; // 4 hours
/** A gap longer than this between calls resets the continuous-activity clock. */
export const MACHINE_ACTIVITY_GRACE_MS = 5 * 60 * 1000;

export function getMachineMaxActiveSeconds(): number {
  const raw = process.env[MACHINE_MAX_ACTIVE_SECONDS_ENV];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MACHINE_MAX_ACTIVE_SECONDS;
}

interface MachineActivityState {
  firstActiveAt: number;
  lastActiveAt: number;
}

const machineActivityByKey = new Map<string, MachineActivityState>();

export type MachineRuntimeGuardrailReason = 'machine_runtime_exceeded';

export type MachineRuntimeGuardrailDecision =
  | { allowed: true }
  | { allowed: false; reason: MachineRuntimeGuardrailReason };

/**
 * Drop entries whose gap has already exceeded the grace window: once that's
 * true, `checkMachineRuntimeGuardrail` treats the key as if it had no state
 * anyway, so the entry is pure dead weight. Without this, every distinct
 * machine ever acquired would occupy an entry for the life of the process —
 * unlike the per-user semaphore above, this map has no symmetric
 * acquire/release to hook a delete into, so eviction has to be opportunistic.
 */
function evictStaleMachineActivity(now: number): void {
  for (const [key, state] of machineActivityByKey) {
    if (now - state.lastActiveAt > MACHINE_ACTIVITY_GRACE_MS) {
      machineActivityByKey.delete(key);
    }
  }
}

/**
 * Advisory check: has this machine been continuously active (no gap longer
 * than `MACHINE_ACTIVITY_GRACE_MS`) for at least `maxActiveSeconds`? Pure
 * read — does not itself record activity; callers must also call
 * `recordMachineActivity` on every acquisition (allowed or not) so a stalled
 * caller who never records still reflects real elapsed time.
 */
export function checkMachineRuntimeGuardrail({
  machineKey,
  now,
  maxActiveSeconds = getMachineMaxActiveSeconds(),
}: {
  machineKey: string;
  now: number;
  maxActiveSeconds?: number;
}): MachineRuntimeGuardrailDecision {
  const state = machineActivityByKey.get(machineKey);
  if (state && now - state.lastActiveAt <= MACHINE_ACTIVITY_GRACE_MS) {
    const activeMs = now - state.firstActiveAt;
    if (activeMs >= maxActiveSeconds * 1000) {
      return { allowed: false, reason: 'machine_runtime_exceeded' };
    }
  }
  return { allowed: true };
}

/**
 * Record that this machine was just active. Starts (or continues) the
 * continuous-activity window; a gap longer than the grace period starts a
 * fresh window instead of extending the old one.
 */
export function recordMachineActivity({ machineKey, now }: { machineKey: string; now: number }): void {
  // Opportunistic sweep: every acquisition is a natural checkpoint to reclaim
  // any OTHER machine's entry that has gone idle, keeping the map bounded by
  // currently (or recently) active machines rather than every machine ever seen.
  evictStaleMachineActivity(now);
  const state = machineActivityByKey.get(machineKey);
  if (!state || now - state.lastActiveAt > MACHINE_ACTIVITY_GRACE_MS) {
    machineActivityByKey.set(machineKey, { firstActiveAt: now, lastActiveAt: now });
  } else {
    state.lastActiveAt = now;
  }
}

/** Clear all machine-runtime guardrail state. Test-only seam. */
export function resetMachineRuntimeGuardrail(): void {
  machineActivityByKey.clear();
}

/** Current guardrail map size — test-only seam for verifying eviction bounds memory. */
export function machineActivityMapSize(): number {
  return machineActivityByKey.size;
}

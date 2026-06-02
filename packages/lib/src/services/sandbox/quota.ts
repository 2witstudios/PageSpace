/**
 * Code execution quota: per-tier concurrency + per-scope daily run budget.
 *
 * Vercel's concurrency and spend limits are account-wide — without our own
 * sub-limits one tenant's runaway agent starves and bills everyone. This module
 * provides two app-level controls:
 *
 *  - Concurrency: an in-process per-user semaphore whose ceiling scales by
 *    subscription tier (mirrors `upload-semaphore.ts`, expressed functionally).
 *  - Daily budget: a NON-incrementing read of the `CODE_EXECUTION` sliding
 *    window (`getDistributedRateLimitStatus`) for the user, drive, and tenant
 *    identifiers independently, so checking one scope never charges another.
 *
 * `checkCodeExecutionQuota` is an ADVISORY preflight: it reports whether a run
 * would be allowed without consuming anything. It must not increment the
 * budget, because checking multiple scopes in sequence would otherwise charge
 * the earlier scopes even when a later one denies — letting an exhausted drive
 * drain a user's allowance in unrelated drives. The single real charge per run
 * (one increment per scope via `checkDistributedRateLimit`) and the matching
 * `acquireCodeExecutionSlot()` are wired at execution time in PR3; that caller
 * must treat a passing preflight as advisory and handle `acquire === false`.
 *
 * Concurrency is checked first (free, in-process) so a saturated system rejects
 * without even reading the budget.
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

export type QuotaDenialReason = 'concurrency_limit' | 'rate_limited';

export type CodeExecutionQuotaDecision =
  | { allowed: true }
  | { allowed: false; reason: QuotaDenialReason; retryAfter?: number };

export interface CodeExecutionQuotaDeps {
  /** Read (do NOT increment) the daily budget for one scoped identifier. Config
   *  binding (the CODE_EXECUTION window) is the dependency's concern. */
  checkRateLimitStatus: (id: string) => Promise<{ blocked: boolean; retryAfter?: number }>;
  canAcquireSlot: (args: { userId: string; tier: SubscriptionTier }) => boolean;
}

// getDistributedRateLimitStatus pulls in the database; import it (and the
// CODE_EXECUTION config) lazily so the unit tests, which inject a fake, never
// load the DB module graph. Status is the read-only sibling of
// checkDistributedRateLimit — it does not consume the window.
const defaultDeps: CodeExecutionQuotaDeps = {
  checkRateLimitStatus: (id) =>
    import('../../security/distributed-rate-limit').then((m) =>
      m.getDistributedRateLimitStatus(id, m.DISTRIBUTED_RATE_LIMITS.CODE_EXECUTION),
    ),
  canAcquireSlot: canAcquireCodeExecutionSlot,
};

export interface CheckCodeExecutionQuotaInput {
  userId: string;
  driveId: string;
  tenantId?: string;
  tier: SubscriptionTier;
  deps?: CodeExecutionQuotaDeps;
}

// The scope identifiers a single run is metered against. Shared by the
// non-incrementing preflight and the real charge so the two never diverge.
function budgetScopeIds({
  userId,
  driveId,
  tenantId,
}: {
  userId: string;
  driveId: string;
  tenantId?: string;
}): string[] {
  return [
    `code-exec:user:${userId}`,
    `code-exec:drive:${driveId}`,
    ...(tenantId ? [`code-exec:tenant:${tenantId}`] : []),
  ];
}

export async function checkCodeExecutionQuota({
  userId,
  driveId,
  tenantId,
  tier,
  deps = defaultDeps,
}: CheckCodeExecutionQuotaInput): Promise<CodeExecutionQuotaDecision> {
  if (!deps.canAcquireSlot({ userId, tier })) {
    return { allowed: false, reason: 'concurrency_limit' };
  }

  for (const id of budgetScopeIds({ userId, driveId, tenantId })) {
    const status = await deps.checkRateLimitStatus(id);
    if (status.blocked) {
      return { allowed: false, reason: 'rate_limited', retryAfter: status.retryAfter };
    }
  }

  return { allowed: true };
}

export interface ChargeBudgetDeps {
  /** Increment the daily budget for one scoped identifier (consumes the window). */
  charge: (id: string) => Promise<void>;
  /** Compensating refund of one scope, to roll back a partially applied charge. */
  refund: (id: string) => Promise<void>;
}

// The real charge increments the CODE_EXECUTION sliding window, with a matching
// compensating refund (decrement) for rollback. Lazily imported so unit tests
// that inject a fake never load the DB module graph.
const defaultChargeDeps: ChargeBudgetDeps = {
  charge: (id) =>
    import('../../security/distributed-rate-limit').then((m) =>
      m.checkDistributedRateLimit(id, m.DISTRIBUTED_RATE_LIMITS.CODE_EXECUTION).then(() => undefined),
    ),
  refund: (id) =>
    import('../../security/distributed-rate-limit').then((m) =>
      m.decrementDistributedRateLimit(id, m.DISTRIBUTED_RATE_LIMITS.CODE_EXECUTION),
    ),
};

/**
 * The single real per-run budget charge: increment every scope (user, drive,
 * and — when known — tenant) exactly once. Call this only after a passing
 * preflight and a successful concurrency reservation, so a denied run never
 * charges.
 *
 * The multi-scope charge is made ATOMIC by compensation: scopes are charged
 * sequentially, and if any scope fails the already-charged scopes are refunded
 * before the error is surfaced. This preserves the module invariant that a run
 * which does not execute (a partial-charge failure aborts the run) never leaves
 * a scope's budget consumed — without it, `Promise.all` could charge the user
 * scope while the tenant scope rejected, permanently skewing quotas.
 */
export async function chargeCodeExecutionBudget({
  userId,
  driveId,
  tenantId,
  deps = defaultChargeDeps,
}: {
  userId: string;
  driveId: string;
  tenantId?: string;
  deps?: ChargeBudgetDeps;
}): Promise<void> {
  const ids = budgetScopeIds({ userId, driveId, tenantId });
  const charged: string[] = [];
  try {
    for (const id of ids) {
      await deps.charge(id);
      charged.push(id);
    }
  } catch (error) {
    // Roll back every scope already charged so a failed multi-scope charge leaves
    // no partial consumption. Refunds are best-effort; the original error wins.
    await Promise.allSettled(charged.map((id) => deps.refund(id)));
    throw error;
  }
}

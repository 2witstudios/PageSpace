/**
 * Code execution quota: per-tier concurrency + per-scope daily run budget.
 *
 * Vercel's concurrency and spend limits are account-wide — without our own
 * sub-limits one tenant's runaway agent starves and bills everyone. This module
 * provides two app-level controls:
 *
 *  - Concurrency: an in-process per-user semaphore whose ceiling scales by
 *    subscription tier (mirrors `upload-semaphore.ts`, expressed functionally).
 *  - Daily budget: `checkDistributedRateLimit` against the `CODE_EXECUTION`
 *    config, applied independently to the user, drive, and tenant identifiers
 *    so exhausting one scope never drains another's allowance.
 *
 * `checkCodeExecutionQuota` checks concurrency first (free, in-process) so a
 * saturated system rejects without spending any of the daily budget.
 */

import type { RateLimitResult } from '../../security/distributed-rate-limit';
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
  /** Check the daily budget for one scoped identifier. Config binding (the
   *  CODE_EXECUTION window) is the dependency's concern, not the caller's. */
  checkRateLimit: (id: string) => Promise<RateLimitResult>;
  canAcquireSlot: (args: { userId: string; tier: SubscriptionTier }) => boolean;
}

// checkDistributedRateLimit pulls in the database; import it (and the
// CODE_EXECUTION config) lazily so the unit tests, which inject a fake, never
// load the DB module graph.
const defaultDeps: CodeExecutionQuotaDeps = {
  checkRateLimit: (id) =>
    import('../../security/distributed-rate-limit').then((m) =>
      m.checkDistributedRateLimit(id, m.DISTRIBUTED_RATE_LIMITS.CODE_EXECUTION),
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

  const scopeIds = [
    `code-exec:user:${userId}`,
    `code-exec:drive:${driveId}`,
    ...(tenantId ? [`code-exec:tenant:${tenantId}`] : []),
  ];

  for (const id of scopeIds) {
    const result = await deps.checkRateLimit(id);
    if (!result.allowed) {
      return { allowed: false, reason: 'rate_limited', retryAfter: result.retryAfter };
    }
  }

  return { allowed: true };
}

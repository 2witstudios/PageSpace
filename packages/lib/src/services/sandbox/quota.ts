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
 * calls, not compute, and punished long agentic sessions for being productive.
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

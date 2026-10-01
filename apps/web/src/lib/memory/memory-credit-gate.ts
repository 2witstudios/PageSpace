import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { CREDIT_HOLD_ESTIMATE_CENTS } from '@pagespace/lib/billing/credit-pricing';
import { isMemoryAvailable } from '@pagespace/lib/billing/automation-preferences';
import type { GateReason } from '@pagespace/lib/billing/credit-core';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Why a memory step ran no model:
 *   - a credit gate reason (out of credits, in debt, needs_init, …)
 *   - `tier_not_eligible`: the user's tier does not get Memory at all. The cron
 *     already selects only MEMORY_PAYING_TIERS; this is the second lock, so the
 *     credit balance is never the only thing between a free user and a model.
 *   - `gate_error`: the gate itself could not be evaluated (DB outage, lock
 *     timeout). A nightly pass is optional work, so an unanswerable gate is a
 *     refusal, never a pass.
 */
export type MemoryGateRefusal = GateReason | 'tier_not_eligible' | 'gate_error';

export type MemoryGated<T> =
  | { ran: true; value: T }
  | { ran: false; reason: MemoryGateRefusal };

/**
 * Run one memory step's model calls under a credit hold, taken BEFORE any model
 * is built. The calls debit their real usage themselves (AIMonitoring.trackUsage
 * → consumeCredits, once per call, keyed on its aiUsageLogId), so the hold only
 * reserves headroom — sized for `modelCalls` calls — while they run. `run` must
 * await its trackUsage calls: the hold is released exactly once, after `run`
 * settles, so the reservation covers each call until its debit has landed and
 * the next step's gate reads the real balance.
 *
 * Scheduled work, like the pulse cron: the interactive per-user/day cap does not
 * apply, and there is no concurrency to bound (one pass per user per night).
 */
export async function withMemoryCreditHold<T>(
  userId: string,
  modelCalls: number,
  run: () => Promise<T>,
): Promise<MemoryGated<T>> {
  let holdId: string | undefined;
  try {
    const [user] = await db
      .select({ subscriptionTier: users.subscriptionTier })
      .from(users)
      .where(eq(users.id, userId));
    const tier = (user?.subscriptionTier ?? 'free') as SubscriptionTier;
    if (!isMemoryAvailable(tier)) return { ran: false, reason: 'tier_not_eligible' };

    const gate = await canConsumeAI(userId, tier, {
      estCostCents: CREDIT_HOLD_ESTIMATE_CENTS * modelCalls,
      skipDailyCap: true,
    });
    if (!gate.allowed) return { ran: false, reason: gate.reason };
    holdId = gate.holdId;
  } catch (error) {
    loggers.api.warn('Memory: credit gate could not be evaluated, step skipped', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ran: false, reason: 'gate_error' };
  }

  try {
    return { ran: true, value: await run() };
  } finally {
    // An unreleased hold is reclaimed by its TTL; never let that fail the step.
    if (holdId) await releaseHold(holdId).catch(() => {});
  }
}

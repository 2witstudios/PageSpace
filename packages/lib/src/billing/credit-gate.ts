/**
 * credit-gate — the fast, pre-request prepaid check. Reads the denormalized
 * credit_balances row and asks the pure evaluateGate whether the user may spend.
 * Never calls Stripe; the hot path stays a single indexed read.
 *
 * A missing balance row is lazy-initialized from the tier's monthly allowance
 * (this is how a brand-new free user gets their trial allowance without a Stripe
 * subscription) and then re-evaluated.
 */

import { db } from '@pagespace/db/db';
import { creditBalances } from '@pagespace/db/schema/credits';
import { eq } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import { evaluateGate, type GateResult } from './credit-core';
import { RESERVE_FLOOR_CENTS, TIER_MONTHLY_ALLOWANCE_CENTS } from './credit-pricing';
import type { SubscriptionTier } from '../services/subscription-utils';

export async function canConsumeAI(
  userId: string,
  tier: SubscriptionTier = 'free',
): Promise<GateResult> {
  if (!isBillingEnabled()) return { allowed: true, reason: 'unlimited' };

  const readBalance = async () => {
    const rows = await db
      .select({
        monthlyRemainingCents: creditBalances.monthlyRemainingCents,
        topupRemainingCents: creditBalances.topupRemainingCents,
      })
      .from(creditBalances)
      .where(eq(creditBalances.userId, userId))
      .limit(1);
    const r = rows[0];
    return r ? { monthlyCents: r.monthlyRemainingCents, topupCents: r.topupRemainingCents } : null;
  };

  const result = evaluateGate({
    billingEnabled: true,
    balance: await readBalance(),
    reserveFloorCents: RESERVE_FLOOR_CENTS,
  });

  if (result.reason !== 'needs_init') return result;

  // Lazy-init from tier defaults, then re-evaluate against the PERSISTED row.
  // onConflictDoNothing means a concurrent request may have already created the
  // row (possibly already drawn down); we must judge the real stored balance,
  // not our assumed full allowance, or we could allow when credits are exhausted.
  const monthly = TIER_MONTHLY_ALLOWANCE_CENTS[tier] ?? TIER_MONTHLY_ALLOWANCE_CENTS.free;
  await db
    .insert(creditBalances)
    .values({
      userId,
      monthlyRemainingCents: monthly,
      monthlyAllowanceCents: monthly,
      topupRemainingCents: 0,
    })
    .onConflictDoNothing({ target: creditBalances.userId });

  return evaluateGate({
    billingEnabled: true,
    balance: await readBalance(),
    reserveFloorCents: RESERVE_FLOOR_CENTS,
  });
}

/**
 * credit-gate — the fast, pre-request prepaid check. Reads the denormalized
 * credit_balances row and asks the pure evaluateGate whether the user may spend.
 * Never calls Stripe; the hot path stays a single indexed read.
 *
 * A missing balance row is lazy-initialized from the tier's monthly allowance
 * (this is how a brand-new free user gets their trial allowance without a Stripe
 * subscription) and then re-evaluated.
 *
 * Free / no-subscription users also get their monthly reset HERE: there's no
 * invoice.paid to drive a refill, so when the period has expired the gate resets
 * the monthly bucket to the tier allowance and rolls the window forward. This is
 * the imperative shell, so it owns the real clock; the period math stays trivial
 * and the bucket reset itself comes from the pure computeMonthlyRefill.
 */

import { db } from '@pagespace/db/db';
import { creditBalances } from '@pagespace/db/schema/credits';
import { and, eq, lt, or, isNull } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import { evaluateGate, computeMonthlyRefill, type GateResult } from './credit-core';
import { RESERVE_FLOOR_CENTS, TIER_MONTHLY_ALLOWANCE_CENTS } from './credit-pricing';
import type { SubscriptionTier } from '../services/subscription-utils';

/** One month after `from`, as a new Date (calendar month, UTC-safe). */
function addOneMonth(from: Date): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

interface BalanceRow {
  monthlyRemainingCents: number;
  topupRemainingCents: number;
  monthlyPeriodEnd: Date | null;
}

export async function canConsumeAI(
  userId: string,
  tier: SubscriptionTier = 'free',
): Promise<GateResult> {
  if (!isBillingEnabled()) return { allowed: true, reason: 'unlimited' };

  const now = new Date();

  const readBalance = async (): Promise<BalanceRow | null> => {
    const rows = await db
      .select({
        monthlyRemainingCents: creditBalances.monthlyRemainingCents,
        topupRemainingCents: creditBalances.topupRemainingCents,
        monthlyPeriodEnd: creditBalances.monthlyPeriodEnd,
      })
      .from(creditBalances)
      .where(eq(creditBalances.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  };

  let row = await readBalance();

  // Gate-driven monthly reset, restricted to FREE / non-subscription users. Free
  // users have no invoice.paid to drive a refill, so the gate rolls their window
  // when it has expired (monthlyPeriodEnd < now) or was never stamped
  // (monthlyPeriodEnd IS NULL — e.g. a top-up funding row created bare before the
  // user's first AI request). Paid tiers are deliberately excluded: their refill is
  // authoritative via invoice.paid (keyed to the invoice stripeRef). Resetting a
  // subscription-backed balance here would over-grant if a renewal invoice is late
  // or retried after the period end — the gate would refill, the user could spend,
  // then the webhook would refill again. A paid user with an expired window is
  // therefore (correctly) blocked until their renewal lands. The UPDATE re-checks
  // the same predicate in its WHERE, so a concurrent reset/refill that rolled the
  // window forward between our read and write matches zero rows and we re-read.
  if (tier === 'free' && row && (row.monthlyPeriodEnd === null || row.monthlyPeriodEnd < now)) {
    const refill = computeMonthlyRefill(tier, TIER_MONTHLY_ALLOWANCE_CENTS);
    const newEnd = addOneMonth(now);
    await db
      .update(creditBalances)
      .set({
        monthlyRemainingCents: refill.monthlyRemainingCents,
        monthlyAllowanceCents: refill.monthlyAllowanceCents,
        monthlyPeriodStart: now,
        monthlyPeriodEnd: newEnd,
      })
      .where(and(
        eq(creditBalances.userId, userId),
        or(isNull(creditBalances.monthlyPeriodEnd), lt(creditBalances.monthlyPeriodEnd, now)),
      ));
    row = await readBalance();
  }

  const result = evaluateGate({
    billingEnabled: true,
    balance: row
      ? { monthlyCents: row.monthlyRemainingCents, topupCents: row.topupRemainingCents }
      : null,
    reserveFloorCents: RESERVE_FLOOR_CENTS,
  });

  if (result.reason !== 'needs_init') return result;

  // Lazy-init from tier defaults, then re-evaluate against the PERSISTED row.
  // onConflictDoNothing means a concurrent request may have already created the
  // row (possibly already drawn down); we must judge the real stored balance,
  // not our assumed full allowance, or we could allow when credits are exhausted.
  // Stamp the period boundary so the reset path above has a window to roll — a
  // free user with no Stripe invoice would otherwise never get a monthly reset.
  const monthly = TIER_MONTHLY_ALLOWANCE_CENTS[tier] ?? TIER_MONTHLY_ALLOWANCE_CENTS.free;
  await db
    .insert(creditBalances)
    .values({
      userId,
      monthlyRemainingCents: monthly,
      monthlyAllowanceCents: monthly,
      topupRemainingCents: 0,
      monthlyPeriodStart: now,
      monthlyPeriodEnd: addOneMonth(now),
    })
    .onConflictDoNothing({ target: creditBalances.userId });

  const initialized = await readBalance();
  return evaluateGate({
    billingEnabled: true,
    balance: initialized
      ? { monthlyCents: initialized.monthlyRemainingCents, topupCents: initialized.topupRemainingCents }
      : null,
    reserveFloorCents: RESERVE_FLOOR_CENTS,
  });
}

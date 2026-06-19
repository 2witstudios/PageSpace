/**
 * credit-balance — read-only view of a user's prepaid AI-credit balance for the
 * dashboard widget and the `GET /api/credits` endpoint.
 *
 * This is the DISPLAY layer; it never mutates. The authoritative spend decision and
 * the free-tier periodic rollover live in `./credit-gate` (the imperative shell that
 * owns the clock and the row lock). Here we only mirror the gate's semantics for presentation:
 *   - free tier whose monthly window has lapsed is shown its stored remaining PLUS the
 *     tier allowance (the gate will add it on the next call — rollover semantics);
 *   - paid tier whose window has lapsed is shown its stored remaining (credits carry
 *     forward — the renewal invoice will add the new allowance via invoice.paid);
 *   - spendable is the FUNDED balance (monthly + top-up remaining) MINUS outstanding
 *     debt, and is deliberately GROSS of in-flight holds. We surface the sum of
 *     still-active holds separately as `reserved` (for an optional "call running"
 *     indicator) but do NOT subtract it from the headline: a per-call reservation that
 *     places, then settles to a fraction of its estimate, would otherwise make the
 *     displayed number dip-then-pop on every call. Overspend is bounded by the gate's
 *     own locked check (see ./credit-gate), not by this display; hiding holds here
 *     cannot over-grant. It is clamped at 0 ONLY when there is no debt — outstanding
 *     overage pulls it negative, and that negative is surfaced so the widget shows red.
 *
 * Money is always whole cents of customer-facing credit value, matching credit-core.
 *
 * Lives in @pagespace/lib so the billing primitives (credit-consume, credit-gate,
 * credit-backfill) can recompute and broadcast a fresh balance at every mutation
 * without reaching back into apps/web. See ./credit-emit.
 */

import { db } from '@pagespace/db/db';
import { creditBalances, creditHolds } from '@pagespace/db/schema/credits';
import { users } from '@pagespace/db/schema/auth';
import { and, eq, gt, sql } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import { TIER_MONTHLY_ALLOWANCE_CENTS } from './credit-pricing';
import { addOneMonth } from './credit-gate';
import type { SubscriptionTier } from '../services/subscription-utils';

export interface CreditBalanceSummary {
  /** false on billing-disabled deployments (tenant/onprem); the widget then hides. */
  billingEnabled: boolean;
  monthly: {
    remaining: number;
    allowance: number;
    /** ISO string of the current period end, or null if never stamped. */
    periodEnd: string | null;
  };
  topup: {
    remaining: number;
  };
  /**
   * Outstanding overage owed (a non-negative magnitude). Accrues when a call's cost
   * exceeds the buckets; paid down by a purchase; netted against carry at the next renewal. When
   * > 0 the net `spendable` is dragged down (and can be negative).
   */
  debt: number;
  /**
   * Funded balance for display: monthly + topup remaining MINUS debt. GROSS of in-flight
   * holds (see file header) — `reserved` is reported separately, not netted out here, so
   * the headline doesn't dip-then-pop across a call's reserve/settle cycle. Clamped to
   * >= 0 only when debt is 0; outstanding overage makes it negative (shown in red).
   */
  spendable: number;
  /**
   * Sum of this user's non-expired holds (estimated spend on in-flight calls). Surfaced
   * for an optional in-flight indicator; NOT subtracted from `spendable`.
   */
  reserved: number;
}

function allowanceFor(tier: SubscriptionTier): number {
  return TIER_MONTHLY_ALLOWANCE_CENTS[tier] ?? TIER_MONTHLY_ALLOWANCE_CENTS.free;
}

/** The unlimited/hidden summary used when prepaid billing is disabled. */
function disabledSummary(): CreditBalanceSummary {
  return {
    billingEnabled: false,
    monthly: { remaining: 0, allowance: 0, periodEnd: null },
    topup: { remaining: 0 },
    debt: 0,
    spendable: 0,
    reserved: 0,
  };
}

/**
 * Read a user's current prepaid credit balance for display. Pure read: no lazy-init,
 * no reset — those are owned by the gate. A user with no balance row yet is shown the
 * tier's monthly allowance (what the gate will lazy-init on their first call).
 */
export async function getCreditBalance(
  userId: string,
  tier: SubscriptionTier = 'free',
): Promise<CreditBalanceSummary> {
  if (!isBillingEnabled()) return disabledSummary();

  const now = new Date();

  const [rows, holdAgg] = await Promise.all([
    db
      .select({
        monthlyRemainingCents: creditBalances.monthlyRemainingCents,
        monthlyAllowanceCents: creditBalances.monthlyAllowanceCents,
        topupRemainingCents: creditBalances.topupRemainingCents,
        debtCents: creditBalances.debtCents,
        monthlyPeriodEnd: creditBalances.monthlyPeriodEnd,
      })
      .from(creditBalances)
      .where(eq(creditBalances.userId, userId))
      .limit(1),
    db
      .select({ reserved: sql<number>`coalesce(sum(${creditHolds.estCents}), 0)` })
      .from(creditHolds)
      .where(and(eq(creditHolds.userId, userId), gt(creditHolds.expiresAt, now))),
  ]);

  const reserved = Number(holdAgg[0]?.reserved ?? 0);
  const row = rows[0] ?? null;

  // No row yet: the gate will lazy-init from the tier allowance on the first call,
  // so present that as the spendable monthly balance.
  if (!row) {
    const allowance = allowanceFor(tier);
    const spendable = Math.max(0, allowance);
    return {
      billingEnabled: true,
      monthly: { remaining: allowance, allowance, periodEnd: null },
      topup: { remaining: 0 },
      debt: 0,
      spendable,
      reserved,
    };
  }

  const allowance = row.monthlyAllowanceCents || allowanceFor(tier);
  const periodEnd = row.monthlyPeriodEnd;
  const expired = periodEnd === null || periodEnd < now;
  // For display: never show a past renewal date. Free users will get addOneMonth(now)
  // stamped by the gate on their next AI call; project that for display. Paid users
  // wait for invoice.paid — we don't know the date, so show nothing.
  const displayPeriodEnd: Date | null = expired
    ? (tier === 'free' ? addOneMonth(now) : null)
    : periodEnd;

  // Rollover: credits never expire. The carry balance is always spendable (both
  // in the gate and here) — the renewal adds the allowance and nets outstanding debt.
  // Free tiers without a Stripe subscription get their reset via the gate's addOneMonth
  // path, so for a free user with a lapsed period we surface stored + upcoming allowance
  // (what the gate will apply on next call). Debt is shown as-is — the gate will net it
  // against the carry at reset. For paid tiers the period window doesn't affect display.
  let monthlyRemaining: number;
  if (tier === 'free' && expired) {
    // Gate will net debt against carry and add the allowance on next call; surface the total.
    monthlyRemaining = row.monthlyRemainingCents + allowance;
  } else {
    monthlyRemaining = row.monthlyRemainingCents;
  }

  const topupRemaining = row.topupRemainingCents;
  const debt = row.debtCents ?? 0;
  // GROSS of in-flight holds (master semantics: `reserved` is surfaced separately, not
  // netted out, so the headline doesn't dip-then-pop across a call). Clamped at 0 ONLY
  // when there's no debt — outstanding overage pulls spendable negative so the widget
  // shows the red. Debt accrues only after both buckets are exhausted, so the negative
  // branch is effectively −debt.
  const spendable =
    debt > 0
      ? monthlyRemaining + topupRemaining - debt
      : Math.max(0, monthlyRemaining + topupRemaining);

  return {
    billingEnabled: true,
    monthly: {
      remaining: monthlyRemaining,
      allowance,
      periodEnd: displayPeriodEnd ? displayPeriodEnd.toISOString() : null,
    },
    topup: { remaining: topupRemaining },
    debt,
    spendable,
    reserved,
  };
}

/** The user's stored subscription tier, defaulting to free if unknown. */
export async function resolveTier(userId: string): Promise<SubscriptionTier> {
  const rows = await db
    .select({ subscriptionTier: users.subscriptionTier })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return (rows[0]?.subscriptionTier as SubscriptionTier) ?? 'free';
}

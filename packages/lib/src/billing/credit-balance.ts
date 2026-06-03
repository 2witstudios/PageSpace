/**
 * credit-balance — read-only view of a user's prepaid AI-credit balance for the
 * dashboard widget and the `GET /api/credits` endpoint.
 *
 * This is the DISPLAY layer; it never mutates. The authoritative spend decision and
 * the monthly reset live in `./credit-gate` (the imperative shell that owns the clock
 * and the row lock). Here we only mirror the gate's semantics for presentation:
 *   - free tier whose monthly window has lapsed is shown its full allowance (the gate
 *     will reset it on the next call) rather than a stale, pessimistic remainder;
 *   - paid tier whose window has lapsed is shown 0 monthly (use-it-or-lose-it — the
 *     gate excludes the expired allowance until the renewal invoice refills it);
 *   - spendable nets out the user's outstanding debt and still-active holds
 *     (reservations on in-flight calls). It is NOT clamped: outstanding overage can
 *     pull it negative, and that negative is surfaced so the widget shows the red.
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
   * exceeds the buckets; paid down by a purchase; forgiven at the next renewal. When
   * > 0 the net `spendable` is dragged down (and can be negative).
   */
  debt: number;
  /** monthly + topup remaining − debt, minus active holds. MAY be negative (debt). */
  spendable: number;
  /** Sum of this user's non-expired holds (estimated spend on in-flight calls). */
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
    const spendable = Math.max(0, allowance - reserved);
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

  // Mirror the gate's window semantics for display (see file header).
  let monthlyRemaining: number;
  if (tier === 'free' && expired) {
    monthlyRemaining = allowance; // gate resets free tiers on next call
  } else if (tier !== 'free' && expired && periodEnd !== null) {
    monthlyRemaining = 0; // paid use-it-or-lose-it: expired allowance is forfeit
  } else {
    monthlyRemaining = row.monthlyRemainingCents;
  }

  const topupRemaining = row.topupRemainingCents;
  const debt = row.debtCents ?? 0;
  // Debt is allowed to pull spendable negative (surface the red); in-flight holds are
  // not — a transient reservation shouldn't read as "you owe". So: when in debt, show
  // the true net (negative); otherwise keep the old hold-aware clamp at 0. Debt only
  // ever accrues after both buckets are exhausted, so in the debt branch
  // monthly+topup is 0 and this is effectively −debt (minus any lingering hold).
  const spendable =
    debt > 0
      ? monthlyRemaining + topupRemaining - debt - reserved
      : Math.max(0, monthlyRemaining + topupRemaining - reserved);

  return {
    billingEnabled: true,
    monthly: {
      remaining: monthlyRemaining,
      allowance,
      periodEnd: periodEnd ? periodEnd.toISOString() : null,
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

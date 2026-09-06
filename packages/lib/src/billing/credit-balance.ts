/**
 * credit-balance — read-only view of a user's prepaid AI-credit balance for the
 * dashboard widget and the `GET /api/credits` endpoint.
 *
 * This is the DISPLAY layer; it never mutates. The authoritative spend decision and
 * the gate-driven periodic rollover live in `./credit-gate` (the imperative shell that
 * owns the clock and the row lock). Here we only mirror the gate's semantics for presentation:
 *   - free tier (a ONE-TIME starter grant, TIER_ALLOWANCE_REFILLS.free === false) is
 *     shown its stored remaining only, and no renewal date — nothing will ever be
 *     added to the monthly bucket again;
 *   - paid tier whose window has lapsed is shown its stored remaining (credits carry
 *     forward — the renewal invoice will add the new allowance via invoice.paid, or
 *     the gate will roll it for a no-subscription account);
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
import { TIER_MONTHLY_ALLOWANCE_CENTS, TIER_ALLOWANCE_REFILLS } from './credit-pricing';
import type { SubscriptionTier } from '../services/subscription-utils';

// Mirror of addOneMonth in credit-gate (same logic, kept local to avoid pulling
// credit-gate's DB imports into this display-only module and its unit-test mocks).
function addOneMonth(from: Date): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

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

/** The funded-balance columns both the display read and the routing gate need. */
interface FundedBalanceRow {
  monthlyRemainingCents: number;
  monthlyAllowanceCents: number;
  topupRemainingCents: number;
  debtCents: number | null;
  monthlyPeriodEnd: Date | null;
}

/**
 * The spendable figure, from a balance row alone.
 *
 * Extracted so the display read and the published-app routing gate cannot drift
 * apart about what "spendable" means — they used to share it only by both
 * calling {@link getCreditBalance}, which made the gate pay for the display's
 * in-flight-holds aggregate on a per-request path.
 *
 * GROSS of in-flight holds, deliberately: `reserved` is reported separately and
 * never netted out (see the file header). Clamped at 0 only when there is no
 * debt — outstanding overage pulls the figure negative.
 */
function spendableCentsFor(row: FundedBalanceRow | null, tier: SubscriptionTier): number {
  // No row yet: the gate lazy-inits from the tier allowance on the first call.
  if (!row) return Math.max(0, allowanceFor(tier));

  // Free is a one-time grant: no upcoming allowance is ever pre-credited, so the
  // stored remaining is the whole story. (Historically the display pre-credited a
  // lapsed free window with the next allowance the gate was about to add; the gate
  // no longer rolls non-refilling tiers, so that projection would over-state.)
  const monthlyRemaining = row.monthlyRemainingCents;
  const topupRemaining = row.topupRemainingCents;
  const debt = row.debtCents ?? 0;
  return debt > 0
    ? monthlyRemaining + topupRemaining - debt
    : Math.max(0, monthlyRemaining + topupRemaining);
}

/**
 * Spendable cents from ONE indexed read — no in-flight-holds aggregate.
 *
 * For the published-app routing edge, which asks "can this payer spend?" once per
 * HTTP REQUEST (the metered tier has no replay cache, by design). Going through
 * {@link getCreditBalance} there meant every image and stylesheet also paid for a
 * `SUM` over `credit_holds` whose result the caller then discarded.
 *
 * Same arithmetic as the display read, via {@link spendableCentsFor}. Never
 * lazy-inits and never rolls the period: both are writes, and they belong to the
 * gate that owns the row lock.
 */
export async function readSpendableCents(
  userId: string,
  tier: SubscriptionTier = 'free',
): Promise<number> {
  const [row] = await db
    .select({
      monthlyRemainingCents: creditBalances.monthlyRemainingCents,
      monthlyAllowanceCents: creditBalances.monthlyAllowanceCents,
      topupRemainingCents: creditBalances.topupRemainingCents,
      debtCents: creditBalances.debtCents,
      monthlyPeriodEnd: creditBalances.monthlyPeriodEnd,
    })
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .limit(1);

  return spendableCentsFor(row ?? null, tier);
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
    const spendable = spendableCentsFor(null, tier);
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
  // For display: never show a past renewal date. Project addOneMonth from the last known
  // period end (or now if none recorded); paid users get the Stripe cycle date (same day
  // next month). A NON-refilling tier (free) has no renewal at all — its allowance was a
  // one-time grant — so surface null and let the UI omit "Renews …" entirely, rather
  // than advancing a phantom date forever.
  const displayPeriodEnd: Date | null = (() => {
    if (!TIER_ALLOWANCE_REFILLS[tier]) return null;
    if (!expired) return periodEnd;
    let projected = addOneMonth(periodEnd ?? now);
    while (projected <= now) {
      projected = addOneMonth(projected);
    }
    return projected;
  })();

  // Rollover: credits never expire. The carry balance is always spendable (both
  // in the gate and here) — a renewal adds the allowance and nets outstanding debt.
  // The period window never affects the displayed remaining: paid tiers carry forward
  // until invoice.paid / the gate roll lands, and free is a one-time grant with nothing
  // upcoming to pre-credit. Debt is shown as-is.
  const monthlyRemaining = row.monthlyRemainingCents;

  const topupRemaining = row.topupRemainingCents;
  const debt = row.debtCents ?? 0;
  // GROSS of in-flight holds (master semantics: `reserved` is surfaced separately, not
  // netted out, so the headline doesn't dip-then-pop across a call). Clamped at 0 ONLY
  // when there's no debt — outstanding overage pulls spendable negative so the widget
  // shows the red. Debt accrues only after both buckets are exhausted, so the negative
  // branch is effectively −debt.
  // Shared with the routing gate's lean read, so the two can never disagree.
  const spendable = spendableCentsFor(row, tier);

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

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
import { creditBalances, creditHolds } from '@pagespace/db/schema/credits';
import { and, eq, gt, lt, or, isNull, sql } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import {
  evaluateGate,
  computeMonthlyRefill,
  reservationCents,
  holdExpiresAt,
  type GateResult,
} from './credit-core';
import {
  RESERVE_FLOOR_CENTS,
  TIER_MONTHLY_ALLOWANCE_CENTS,
  CREDIT_HOLD_ESTIMATE_CENTS,
  CREDIT_HOLD_TTL_SECONDS,
  MAX_FREE_INFLIGHT,
  isCreditsEnforcementEnabled,
} from './credit-pricing';
import type { SubscriptionTier } from '../services/subscription-utils';

/**
 * One calendar month after `from`, clamped to the last valid day of the target
 * month so a month-end start doesn't overflow. Naive `setUTCMonth(+1)` turns
 * Jan 31 into Mar 3 (Feb has no 31st), which would make a "monthly" window longer
 * than a month and delay the next allowance reset for users initialized near
 * month end. Clamping maps Jan 31 -> Feb 28/29. Time-of-day is preserved.
 * Exported for direct edge-case testing.
 */
export function addOneMonth(from: Date): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1); // avoid overflow while we shift the month
  d.setUTCMonth(d.getUTCMonth() + 1);
  const lastDayOfTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTarget));
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

  // Lazy-init from tier defaults so a balance row always exists before the
  // authoritative hold transaction below. A free user's very first request has no
  // row yet; init it from the tier allowance and stamp a period window so the reset
  // path above can later roll it (a free user with no Stripe invoice would otherwise
  // never reset). onConflictDoNothing tolerates a concurrent init — the transaction
  // judges the REAL persisted balance under a row lock, never our assumed allowance,
  // so we can't allow when a racing request already drew the row down.
  if (!row) {
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
  }

  const estCost = reservationCents(CREDIT_HOLD_ESTIMATE_CENTS);
  // Free users are capped on concurrent in-flight calls; paid tiers are bounded by
  // credits alone (no cap).
  const maxInFlight = tier === 'free' ? MAX_FREE_INFLIGHT : null;
  const expiresAt = new Date(holdExpiresAt(now.getTime(), CREDIT_HOLD_TTL_SECONDS * 1000));

  // Authoritative decision + reservation, atomic under a balance row lock. The lock
  // serializes this user's concurrent requests so they observe each other's holds —
  // two simultaneous calls can't both pass a check that only one call's worth of
  // credit can cover, and the free-tier in-flight count can't be undercounted.
  const result = await db.transaction(async (tx): Promise<GateResult> => {
    const balRows = await tx
      .select({
        monthlyRemainingCents: creditBalances.monthlyRemainingCents,
        topupRemainingCents: creditBalances.topupRemainingCents,
        monthlyPeriodEnd: creditBalances.monthlyPeriodEnd,
      })
      .from(creditBalances)
      .where(eq(creditBalances.userId, userId))
      .for('update');
    const bal = balRows[0] ?? null;

    // Sum & count this user's still-active holds (calls in flight). Expired holds
    // are excluded from both — they no longer reserve spend and are reclaimed by
    // the reconcile cron — so a crashed stream can't permanently shrink spendable
    // or block the in-flight cap forever.
    const holdAgg = await tx
      .select({
        reserved: sql<number>`coalesce(sum(${creditHolds.estCents}), 0)`,
        inFlight: sql<number>`count(*)`,
      })
      .from(creditHolds)
      .where(and(eq(creditHolds.userId, userId), gt(creditHolds.expiresAt, now)));
    const reserved = Number(holdAgg[0]?.reserved ?? 0);
    const inFlight = Number(holdAgg[0]?.inFlight ?? 0);

    // Use-it-or-lose-it for paid tiers: a paid user's monthly bucket is only spendable
    // within its window. The gate never resets paid tiers (invoice.paid is authoritative),
    // so once the window has expired we EXCLUDE the leftover monthly — otherwise a delayed
    // renewal would let last period's allowance keep funding calls. Only the never-expiring
    // top-up bucket survives. A NULL period is treated as not-yet-expired; free users were
    // handled by the reset above and never reach this exclusion.
    const paidMonthlyExpired =
      tier !== 'free' && bal !== null && bal.monthlyPeriodEnd !== null && bal.monthlyPeriodEnd < now;

    const result = evaluateGate({
      billingEnabled: true,
      balance: bal
        ? {
            monthlyCents: paidMonthlyExpired ? 0 : bal.monthlyRemainingCents,
            topupCents: bal.topupRemainingCents,
          }
        : null,
      reserveFloorCents: RESERVE_FLOOR_CENTS,
      reservedCents: reserved,
      estCostCents: estCost,
      inFlightCount: inFlight,
      maxInFlight,
    });

    if (!result.allowed) return result;

    // Reserve this call's estimated spend AND register it as one in-flight call.
    // consumeCredits deletes the hold at settle; a crashed stream leaves it for the
    // reconcile sweep to expire.
    const inserted = await tx
      .insert(creditHolds)
      .values({ userId, estCents: estCost, expiresAt })
      .returning({ id: creditHolds.id });

    return { ...result, holdId: inserted[0]?.id };
  });

  // Dark launch: the gate did all its bookkeeping above (lazy-init, reset, balance
  // read, and a hold on the allow path), but when enforcement is OFF we never hand
  // the caller a denial — the request proceeds and is still metered by consumeCredits
  // (which records real cost + charged credits, accruing debt rows for would-be
  // overages). Flip CREDITS_ENFORCEMENT_ENABLED=true to start blocking.
  if (!result.allowed && !isCreditsEnforcementEnabled()) {
    return { allowed: true, reason: 'enforcement_disabled' };
  }
  return result;
}

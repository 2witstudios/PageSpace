/**
 * credit-gate — the fast, pre-request prepaid check. Reads the denormalized
 * credit_balances row and asks the pure evaluateGate whether the user may spend.
 * Never calls Stripe; the hot path stays a single indexed read.
 *
 * A missing balance row is lazy-initialized from the tier's monthly allowance
 * (this is how a brand-new free user gets their trial allowance without a Stripe
 * subscription) and then re-evaluated.
 *
 * Free / no-subscription users get their periodic top-up HERE: there's no
 * invoice.paid to drive a refill, so when the period has expired the gate ADDS the
 * tier allowance to the carry balance (rollover) and rolls the window forward. This is
 * the imperative shell, so it owns the real clock; the period math stays trivial
 * and the rollover itself comes from the pure computeMonthlyRefill.
 */

import { db } from '@pagespace/db/db';
import { creditBalances, creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { and, eq, gt, gte, inArray, sql } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import {
  evaluateGate,
  evaluateDailyCap,
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
  dailyExposureCapForTier,
} from './credit-pricing';
import type { SubscriptionTier } from '../services/subscription-utils';

// The partial unique index credit_ledger_stripe_ref_unique is defined WHERE
// stripeRef IS NOT NULL; Postgres only infers it as the ON CONFLICT arbiter when
// we restate that predicate (mirrors the same constant in credit-funding.ts).
const STRIPE_REF_ARBITER = {
  target: creditLedger.stripeRef,
  where: sql`${creditLedger.stripeRef} IS NOT NULL`,
} as const;

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

/**
 * Midnight UTC of the day containing `from`. Defines the window for the per-user/day
 * exposure cap; UTC (not local) so the cap resets at a fixed instant regardless of where
 * a user is. Exported for direct testing.
 */
export function startOfUtcDay(from: Date): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
}

interface BalanceRow {
  monthlyRemainingCents: number;
  topupRemainingCents: number;
  debtCents: number;
  monthlyPeriodEnd: Date | null;
}

/**
 * Subscription statuses whose renewal invoice may still arrive: `invoice.paid`
 * stays authoritative for these (a gate roll would double-grant when the invoice
 * lands or replays). `unpaid` is included — Stripe keeps its open invoices
 * collectible, so a later payment still fires invoice.paid. Everything else —
 * canceled, incomplete, incomplete_expired, or no subscription row at all
 * (comped/founder accounts) — will never produce an invoice, so the gate is the
 * only thing that can roll them. Exported so other surfaces that need a "live
 * subscription" filter converge on one definition instead of drifting copies.
 */
export const RENEWAL_CAPABLE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid'];

/**
 * Whether ANY of the user's subscriptions could still deliver an invoice-driven
 * refill. Takes the executor so the reset transaction can RE-CHECK on `tx`
 * right before granting — a subscription created between the unlocked pre-check
 * and the grant (checkout completing concurrently with an AI request) would
 * otherwise double-grant when its first invoice.paid lands.
 */
async function hasRenewalCapableSubscription(
  executor: Pick<typeof db, 'select'>,
  userId: string,
): Promise<boolean> {
  const rows = await executor
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, RENEWAL_CAPABLE_STATUSES)))
    .limit(1);
  return rows.length > 0;
}

export interface GateOptions {
  /**
   * Override the per-call reservation (in whole cents) for this gate check. The
   * chat path omits it and uses the CREDIT_HOLD_ESTIMATE_CENTS default; voice
   * routes pass a per-call estimate so a sub-cent STT/TTS call doesn't reserve the
   * full chat estimate. Only bounds the in-flight hold — the real cost still settles
   * exactly via consumeCredits.
   */
  estCostCents?: number;
  /**
   * Cap on this user's concurrent in-flight calls, applied to ALL tiers (combined
   * with the free-tier cap via min). Voice routes pass VOICE_MAX_INFLIGHT to bound
   * concurrent paid voice spend, which the per-call hold alone can't (the real cost
   * only lands at settle). Omitted by chat, which leaves paid tiers uncapped.
   */
  maxInFlight?: number;
  /**
   * Skip the per-user/day exposure cap for this call. Set by internal/system callers
   * (e.g. the scheduled pulse cron) whose spend shouldn't be bounded by a per-user daily
   * ceiling meant for interactive runaway protection. User-driven routes omit it.
   */
  skipDailyCap?: boolean;
  /**
   * Per-user/day charged-spend ceiling (whole cents) applied IN ADDITION to the tier
   * cap — the effective cap is the smaller of the two — and, unlike the tier cap,
   * it binds even on deployments where DAILY_USER_EXPOSURE_CAP_CENTS is unset
   * (0 = disabled) AND on billing-disabled deployments (tenant/onprem), where the
   * day's spend is metered from aiUsageLogs instead of the credit ledger. Passed by
   * callers whose runs are forced by a bearer credential (the page-webhook trigger
   * path), so an unconfigured deployment still bounds what a leaked secret can spend
   * per day. Zero/negative values are ignored. Independent of skipDailyCap: an
   * explicit ceiling is the caller's own opt-in bound, not the interactive runaway
   * backstop that skipDailyCap exists to bypass.
   */
  dailyCapCeilingCents?: number;
}

/** Normalize the caller-supplied daily ceiling: zero/negative/absent → null (off). */
function callerCeilingCents(opts: GateOptions): number | null {
  return opts.dailyCapCeilingCents !== undefined && opts.dailyCapCeilingCents > 0
    ? opts.dailyCapCeilingCents
    : null;
}

export async function canConsumeAI(
  userId: string,
  tier: SubscriptionTier = 'free',
  opts: GateOptions = {},
): Promise<GateResult> {
  if (!isBillingEnabled()) {
    // Billing-off deployments (tenant/onprem) have no credit ledger, but a
    // caller-supplied daily ceiling must still bind: a metered provider (e.g.
    // Azure OpenAI on-prem) spends real money, and the ceiling exists precisely
    // for runs forced by a bearer credential. aiUsageLogs is written in EVERY
    // deployment mode, so meter the day's cost from it; concurrent in-flight
    // runs are accounted via creditHolds reservations (a webhook fan-out starts
    // runs concurrently — settled usage alone would let every run of a burst
    // observe the same below-cap total). The per-user advisory lock serializes
    // concurrent decisions the way the billed path's balance row lock does
    // (there is no balance row to lock in this mode). The caller releases the
    // hold after the run (releaseHold deletes in every mode); an abandoned hold
    // expires via its TTL. Without a ceiling this stays the query-free
    // unlimited fast path.
    const ceiling = callerCeilingCents(opts);
    if (ceiling === null) return { allowed: true, reason: 'unlimited' };
    const now = new Date();
    const dayStart = startOfUtcDay(now);
    const estCost = reservationCents(opts.estCostCents ?? CREDIT_HOLD_ESTIMATE_CENTS);
    const expiresAt = new Date(holdExpiresAt(now.getTime(), CREDIT_HOLD_TTL_SECONDS * 1000));
    return await db.transaction(async (tx): Promise<GateResult> => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${'billing-off-daily-ceiling:' + userId}))`,
      );
      const holdAgg = await tx
        .select({ reserved: sql<number>`coalesce(sum(${creditHolds.estCents}), 0)` })
        .from(creditHolds)
        .where(and(eq(creditHolds.userId, userId), gt(creditHolds.expiresAt, now)));
      const reserved = Number(holdAgg[0]?.reserved ?? 0);
      const agg = await tx
        .select({ costUsd: sql<number>`coalesce(sum(${aiUsageLogs.cost}), 0)` })
        .from(aiUsageLogs)
        .where(and(eq(aiUsageLogs.userId, userId), gte(aiUsageLogs.timestamp, dayStart)));
      const spentCents = Math.floor(Number(agg[0]?.costUsd ?? 0) * 100);
      const cap = evaluateDailyCap({
        dailyChargedCents: spentCents + reserved,
        estCostCents: estCost,
        capCents: ceiling,
      });
      if (!cap.allowed) return { allowed: false, reason: cap.reason };
      const inserted = await tx
        .insert(creditHolds)
        .values({ userId, estCents: estCost, expiresAt })
        .returning({ id: creditHolds.id });
      return { allowed: true, reason: 'unlimited', holdId: inserted[0]?.id };
    });
  }

  const now = new Date();

  const readBalance = async (): Promise<BalanceRow | null> => {
    const rows = await db
      .select({
        monthlyRemainingCents: creditBalances.monthlyRemainingCents,
        topupRemainingCents: creditBalances.topupRemainingCents,
        debtCents: creditBalances.debtCents,
        monthlyPeriodEnd: creditBalances.monthlyPeriodEnd,
      })
      .from(creditBalances)
      .where(eq(creditBalances.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  };

  let row = await readBalance();

  // Gate-driven monthly reset for users whose refill can never come from Stripe.
  // Free users have no invoice.paid to drive a refill, so the gate rolls their
  // window when it has expired (monthlyPeriodEnd < now) or was never stamped
  // (monthlyPeriodEnd IS NULL — e.g. a top-up funding row created bare before the
  // user's first AI request). Paid tiers get the same roll ONLY when no
  // renewal-capable subscription exists (comped/founder accounts — see
  // hasRenewalCapableSubscription): with a live subscription, invoice.paid stays
  // authoritative (keyed to the invoice stripeRef), because resetting here would
  // over-grant if a renewal invoice is late or retried after the period end — the
  // gate would refill, the user could spend, then the webhook would refill again.
  // A paid user with a live subscription and an expired window is therefore
  // (correctly) blocked until their renewal lands. The subscription lookup only
  // runs on the rare expired-window path, never on the hot path.
  //
  // The unlocked `row` read above is only a cheap pre-check: it decides whether a
  // reset is even worth attempting (don't open a transaction when the window is
  // clearly still active). The authoritative balance read + refill computation happen
  // INSIDE the transaction under `FOR UPDATE`, mirroring applyMonthlyRefill in
  // credit-funding.ts. Computing the refill from this pre-transaction snapshot races
  // any concurrent mutation committed between the read and the write: a concurrent
  // settle would have its spend silently un-billed (the reset would overwrite the
  // drawn-down balance with stale_remaining + allowance), and a concurrent
  // debt-clearing top-up would have its debt collected twice (the reset re-nets the
  // already-paid debt). Reading the row under the lock closes both interleavings.
  const windowExpired = row !== null && (row.monthlyPeriodEnd === null || row.monthlyPeriodEnd < now);
  // Only tiers with a defined allowance may roll: callers pass users.subscriptionTier
  // through unchecked casts, and a legacy/unknown value (e.g. 'normal') reaching
  // computeMonthlyRefill would silently rewrite the account to the free allowance.
  const tierHasAllowance = tier in TIER_MONTHLY_ALLOWANCE_CENTS;
  if (
    windowExpired &&
    tierHasAllowance &&
    (tier === 'free' || !(await hasRenewalCapableSubscription(db, userId)))
  ) {
    const newEnd = addOneMonth(now);
    await db.transaction(async (tx) => {
      // Lock the balance row and RE-READ the current monthly/debt values inside the
      // transaction. The lock serialises concurrent resets for this user and forces
      // us to observe any settle/top-up that committed since the unlocked pre-check.
      const lockedRows = await tx
        .select({
          monthlyRemainingCents: creditBalances.monthlyRemainingCents,
          debtCents: creditBalances.debtCents,
          monthlyPeriodEnd: creditBalances.monthlyPeriodEnd,
        })
        .from(creditBalances)
        .where(eq(creditBalances.userId, userId))
        .for('update');
      const locked = lockedRows[0] ?? null;

      // Re-check the reset predicate against the LOCKED row. A concurrent reset may
      // have rolled the window forward (or the row may have vanished) between our
      // unlocked pre-check and acquiring the lock; if the window is no longer expired,
      // that other request already granted this period — skip to avoid a double grant.
      if (!locked || !(locked.monthlyPeriodEnd === null || locked.monthlyPeriodEnd < now)) {
        return;
      }

      // Paid tiers: RE-CHECK the subscription state on the transaction right before
      // granting. The unlocked pre-check races a concurrent checkout — if the
      // customer.subscription.* webhook committed a renewal-capable row since,
      // invoice.paid now owns this user's refill and granting here would double it.
      // (Not fully serialized against the webhook's own transaction, but it shrinks
      // the race from "any time since the pre-check" to the instant before commit.)
      if (tier !== 'free' && (await hasRenewalCapableSubscription(tx, userId))) {
        return;
      }

      // Compute the refill from the LOCKED, current balance so unspent credits roll
      // over and outstanding debt is netted against the up-to-date carry (matching the
      // paid invoice.paid path), not against the stale pre-transaction snapshot.
      const refill = computeMonthlyRefill(
        tier,
        TIER_MONTHLY_ALLOWANCE_CENTS,
        locked.monthlyRemainingCents ?? 0,
        locked.debtCents ?? 0,
      );

      await tx
        .update(creditBalances)
        .set({
          monthlyRemainingCents: refill.monthlyRemainingCents,
          monthlyAllowanceCents: refill.monthlyAllowanceCents,
          // The renewal-equivalent for free/no-sub users: debt is netted against the
          // carried balance before the allowance is added (refill.debtCents === 0).
          debtCents: refill.debtCents,
          monthlyPeriodStart: now,
          monthlyPeriodEnd: newEnd,
        })
        .where(eq(creditBalances.userId, userId));

      // Record the grant. We only reach here holding the lock with a confirmed-expired
      // window, so this call owns the reset; onConflictDoNothing on the period-keyed
      // stripeRef is a belt-and-suspenders guard against a same-instant duplicate key.
      await tx
        .insert(creditLedger)
        .values({
          userId,
          entryType: 'monthly_grant',
          bucket: 'monthly',
          amountCents: refill.monthlyAllowanceCents,
          // 'free-reset' kept verbatim for the free tier (pre-existing ledger rows use
          // it); paid no-subscription rolls get their own prefix so they're
          // distinguishable in the ledger.
          stripeRef: `${tier === 'free' ? 'free' : 'gate'}-reset-${userId}-${now.toISOString()}`,
          consumeStatus: 'applied',
        })
        .onConflictDoNothing(STRIPE_REF_ARBITER);
    });
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
    await db.transaction(async (tx) => {
      const balanceInserted = await tx
        .insert(creditBalances)
        .values({
          userId,
          monthlyRemainingCents: monthly,
          monthlyAllowanceCents: monthly,
          topupRemainingCents: 0,
          monthlyPeriodStart: now,
          monthlyPeriodEnd: addOneMonth(now),
        })
        .onConflictDoNothing({ target: creditBalances.userId })
        .returning({ userId: creditBalances.userId });
      // Only record the grant when THIS transaction created the balance row.
      // If a concurrent top-up or invoice.paid already created the row between
      // readBalance() and here, balanceInserted is empty and we skip the ledger
      // write — that path writes its own grant/purchase entry, and a phantom
      // monthly_grant here would overstate the user's credits in the drift formula.
      if (balanceInserted.length > 0) {
        await tx
          .insert(creditLedger)
          .values({
            userId,
            entryType: 'monthly_grant',
            bucket: 'monthly',
            amountCents: monthly,
            stripeRef: `free-init-${userId}`,
            consumeStatus: 'applied',
          })
          .onConflictDoNothing(STRIPE_REF_ARBITER);
      }
    });
  }

  const estCost = reservationCents(opts.estCostCents ?? CREDIT_HOLD_ESTIMATE_CENTS);
  // Free users are capped on concurrent in-flight calls; paid tiers are bounded by
  // credits alone UNLESS the caller supplies its own cap (voice passes one to bound
  // concurrent paid voice spend). When both apply, the tighter (min) cap wins.
  const caps = [
    tier === 'free' ? MAX_FREE_INFLIGHT : null,
    opts.maxInFlight ?? null,
  ].filter((c): c is number => c !== null);
  const maxInFlight = caps.length > 0 ? Math.min(...caps) : null;
  const expiresAt = new Date(holdExpiresAt(now.getTime(), CREDIT_HOLD_TTL_SECONDS * 1000));

  // Per-user/day exposure cap (null = disabled, the default). Resolved here; the day's
  // charged total is summed inside the transaction below on the allow path. A caller
  // ceiling tightens (never loosens) the tier cap and applies even when the tier cap
  // is disabled or skipped — see GateOptions.dailyCapCeilingCents.
  const tierDailyCap = opts.skipDailyCap ? null : dailyExposureCapForTier(tier);
  const callerCeiling = callerCeilingCents(opts);
  const dailyCap =
    tierDailyCap !== null && callerCeiling !== null
      ? Math.min(tierDailyCap, callerCeiling)
      : (tierDailyCap ?? callerCeiling);
  const dayStart = startOfUtcDay(now);

  // Authoritative decision + reservation, atomic under a balance row lock. The lock
  // serializes this user's concurrent requests so they observe each other's holds —
  // two simultaneous calls can't both pass a check that only one call's worth of
  // credit can cover, and the free-tier in-flight count can't be undercounted.
  const result = await db.transaction(async (tx): Promise<GateResult> => {
    const balRows = await tx
      .select({
        monthlyRemainingCents: creditBalances.monthlyRemainingCents,
        topupRemainingCents: creditBalances.topupRemainingCents,
        debtCents: creditBalances.debtCents,
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

    // Rollover: the monthly bucket is always spendable — credits never expire. A paid user
    // whose window has lapsed continues to spend from their carried balance; the renewal
    // invoice.paid will then add the new allowance on top of whatever remains (not reset).
    // Free users were handled by the addOneMonth reset above and never reach here with an
    // expired window. The gate still does NOT refill paid tiers — invoice.paid is
    // authoritative for that — so there is no double-grant risk: the refill reads the
    // current DB balance inside its own transaction and adds the allowance to whatever is
    // there, exactly accounting for any spend that happened during the gap.
    const result = evaluateGate({
      billingEnabled: true,
      balance: bal
        ? {
            monthlyCents: bal.monthlyRemainingCents,
            topupCents: bal.topupRemainingCents,
            // Outstanding overage drags net spendable down: a user in the red must get
            // back to net-positive (buy credits, or wait for the renewal that nets
            // the debt against carry) before the gate allows again.
            debtCents: bal.debtCents,
          }
        : null,
      reserveFloorCents: RESERVE_FLOOR_CENTS,
      reservedCents: reserved,
      estCostCents: estCost,
      inFlightCount: inFlight,
      maxInFlight,
    });

    if (!result.allowed) return result;

    // Per-user/day exposure cap: a runaway loop can stay within the in-flight cap yet
    // accrue real cost all day. Checked only on the allow path (the credit gate denied
    // otherwise) and only when a cap is configured. Sums chargeMillicents — the full
    // intended charge, positive on usage rows and NULL elsewhere (so monthly/topup/debt
    // rows don't count) — rather than appliedCents, so an in-debt user who keeps spending
    // real provider money is still bounded. Same transaction → consistent read. NO hold
    // is inserted on a cap denial.
    if (dailyCap !== null) {
      const chargedAgg = await tx
        .select({ chargedMc: sql<number>`coalesce(sum(${creditLedger.chargeMillicents}), 0)` })
        .from(creditLedger)
        .where(and(
          eq(creditLedger.userId, userId),
          inArray(creditLedger.entryType, ['usage', 'adjustment']),
          gte(creditLedger.createdAt, dayStart),
        ));
      const dailyChargedCents = Math.max(0, Math.floor(Number(chargedAgg[0]?.chargedMc ?? 0) / 1000));
      // Add this user's still-active hold reservations (`reserved`, computed above) to the
      // settled total: a burst of concurrent requests reserves holds that haven't reached
      // the ledger yet, so without this each serialized gate check would see the same
      // dailyChargedCents and up to maxInFlight estimates could blow past the cap before
      // any settles. estCost is THIS call's reservation (not yet in `reserved`).
      const cap = evaluateDailyCap({
        dailyChargedCents: dailyChargedCents + reserved,
        estCostCents: estCost,
        capCents: dailyCap,
      });
      if (!cap.allowed) return { allowed: false, reason: cap.reason };
    }

    // Reserve this call's estimated spend AND register it as one in-flight call.
    // consumeCredits deletes the hold at settle; a crashed stream leaves it for the
    // reconcile sweep to expire.
    const inserted = await tx
      .insert(creditHolds)
      .values({ userId, estCents: estCost, expiresAt })
      .returning({ id: creditHolds.id });

    // Net spendable after ALL holds (existing `reserved` + this call's `estCost`) and
    // debt — the same quantity evaluateGate checked. Stored so onStepFinish can guard
    // the per-stream abort budget without an extra DB read. Each concurrent stream gets
    // only its fair slice, not the gross bucket balance (which would let N streams each
    // consume nearly the full balance before aborting, collectively exceeding the cap).
    const netSpendableCents = bal
      ? bal.monthlyRemainingCents + bal.topupRemainingCents - (bal.debtCents ?? 0) - reserved - estCost
      : 0;

    return {
      ...result,
      holdId: inserted[0]?.id,
      balanceSnapshot: bal ? { netSpendableCents } : undefined,
    };
  });

  // NOTE: we deliberately do NOT emit a balance update when the hold is placed. Holds
  // are hidden from the displayed balance (see getCreditBalance), and the navbar should
  // step down only when the call SETTLES to its real cost (consumeCredits emits then).
  // Emitting here pushed the reservation into the headline, making it dip on call start
  // and pop back up at settle — the "more → less → more" flicker. An abandoned/crashed
  // call leaves a dangling hold for the reconcile sweep (credit-backfill) to expire; it
  // no longer affects the displayed balance, so no gate-time push is needed.

  return result;
}

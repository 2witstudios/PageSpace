/**
 * credit-funding — imperative shell that turns a paid Stripe event into spendable
 * prepaid credit. Pure routing/arithmetic (classifyStripeEvent, computeMonthlyRefill,
 * applyPaymentToDebt) comes from credit-core; this file only does I/O.
 *
 * Two funding paths:
 *   - monthly_refill (invoice.paid): a subscription renewal RESETS the monthly
 *     bucket to the tier allowance and rolls the billing window forward.
 *   - topup (checkout.session.completed, credit_pack): a one-time purchase ADDS to
 *     the never-expiring top-up bucket.
 *
 * Correctness:
 *   - Exactly-once: every funding ledger row keys on stripeRef. The insert uses
 *     onConflictDoNothing against the partial unique index (credit_ledger_stripe_ref_unique),
 *     and the balance mutation only runs when that insert actually inserted a row —
 *     so a redelivered Stripe event credits the balance exactly once.
 *   - Atomic: the ledger insert and the balance write share one transaction, so a
 *     failure rolls back both — funding is all-or-nothing, never half-applied.
 *   - Retryable: a genuine failure (e.g. a transient DB/transaction error) is logged
 *     and RE-THROWN, not swallowed, so the webhook can let Stripe redeliver the
 *     event. Because funding keys on stripeRef, a reprocess credits exactly once.
 *     Non-actionable cases (billing disabled, ignored events, unknown customer,
 *     missing ids) return quietly — they are "nothing to do", not failures.
 */

import { db } from '@pagespace/db/db';
import { creditBalances, creditLedger } from '@pagespace/db/schema/credits';
import { users } from '@pagespace/db/schema/auth';
import { eq, sql } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import { classifyStripeEvent, computeMonthlyRefill, applyPaymentToDebt } from './credit-core';
import { TIER_MONTHLY_ALLOWANCE_CENTS } from './credit-pricing';
import type { SubscriptionTier } from '../services/subscription-utils';
import { loggers } from '../logging/logger-config';

/**
 * Structural subset of a Stripe.Event the funding shell reads. Kept minimal and
 * Stripe-SDK-free so packages/lib stays decoupled; a real Stripe.Event satisfies it.
 * `data.object` carries both the checkout-session fields (mode/metadata) routing
 * needs and the invoice fields (customer / id / period) funding needs.
 */
interface FundingEventObject {
  id?: string | null;
  customer?: string | { id?: string | null } | null;
  mode?: string | null;
  metadata?: Record<string, string> | null;
  period_start?: number | null;
  period_end?: number | null;
  lines?: {
    data?: Array<{ period?: { start?: number | null; end?: number | null } | null } | undefined> | null;
  } | null;
}

export interface FundingEvent {
  id: string;
  type: string;
  data: { object: FundingEventObject };
}

// The partial unique index credit_ledger_stripe_ref_unique is defined WHERE
// stripeRef IS NOT NULL; Postgres can only infer it as the ON CONFLICT arbiter if
// we restate that predicate (mirrors the aiUsageLogId pattern in credit-consume).
const STRIPE_REF_ARBITER = {
  target: creditLedger.stripeRef,
  where: sql`${creditLedger.stripeRef} IS NOT NULL`,
} as const;

/** Pull the Stripe customer id out of the event object (string or expanded object). */
function customerIdOf(obj: FundingEventObject): string | null {
  const c = obj.customer;
  if (!c) return null;
  return typeof c === 'string' ? c : c.id ?? null;
}

function toDate(ts?: number | null): Date | null {
  return typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts * 1000) : null;
}

/**
 * The renewal invoice is the period boundary: take period_start/period_end from
 * the invoice, falling back to the first line item's period. Either may be absent
 * (the schema allows NULL period dates).
 */
function invoicePeriod(obj: FundingEventObject): { start: Date | null; end: Date | null } {
  let start = toDate(obj.period_start);
  let end = toDate(obj.period_end);
  if (!start || !end) {
    const linePeriod = obj.lines?.data?.[0]?.period;
    start = start ?? toDate(linePeriod?.start);
    end = end ?? toDate(linePeriod?.end);
  }
  return { start, end };
}

async function resolveUser(
  customerId: string,
): Promise<{ id: string; tier: SubscriptionTier } | null> {
  const rows = await db
    .select({ id: users.id, subscriptionTier: users.subscriptionTier })
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1);
  if (!rows.length) return null;
  return { id: rows[0].id, tier: rows[0].subscriptionTier as SubscriptionTier };
}

/**
 * Resolve the buyer of a credit-pack checkout. A one-time payment-mode checkout does
 * NOT necessarily link the Stripe customer to a user (the subscription handler only
 * links subscription sessions), so a customer lookup can come up empty for a first-time
 * pack purchase. We therefore prefer metadata.userId — set by us when creating the
 * checkout session and round-tripped verbatim through the signature-verified event, so
 * it's trusted — and fall back to the customer link only when metadata is absent.
 */
async function resolveTopupUser(obj: FundingEventObject): Promise<{ id: string } | null> {
  const metaUserId = obj.metadata?.userId;
  if (metaUserId) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, metaUserId))
      .limit(1);
    if (rows.length) return { id: rows[0].id };
  }
  const customerId = customerIdOf(obj);
  if (customerId) {
    const byCustomer = await resolveUser(customerId);
    if (byCustomer) return { id: byCustomer.id };
  }
  return null;
}

/**
 * invoice.paid — reset the monthly bucket to the tier allowance and roll the
 * billing window forward, recording a monthly_grant ledger row keyed on the
 * invoice id. The balance write only runs if the grant row was newly inserted.
 */
async function applyMonthlyRefill(event: FundingEvent, tierOverride?: SubscriptionTier): Promise<void> {
  const obj = event.data.object;
  const stripeRef = obj.id ?? null;
  if (!stripeRef) {
    loggers.api.warn('credit funding skipped: invoice has no id', { eventId: event.id });
    return;
  }
  const customerId = customerIdOf(obj);
  if (!customerId) {
    loggers.api.warn('credit funding skipped: invoice has no customer', { eventId: event.id });
    return;
  }
  const user = await resolveUser(customerId);
  if (!user) {
    loggers.api.warn('credit funding skipped: user not found for customer', { eventId: event.id });
    return;
  }

  // Prefer the tier the caller derived from the PAID invoice's line price. invoice.paid
  // can land before customer.subscription.* has updated users.subscriptionTier, so the
  // stored tier (user.tier) may be stale ('free'); the invoice reflects what was actually
  // billed. Fall back to the stored tier only when the caller couldn't resolve one.
  const tier = tierOverride ?? user.tier;
  const refill = computeMonthlyRefill(tier, TIER_MONTHLY_ALLOWANCE_CENTS);
  const { start, end } = invoicePeriod(obj);

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(creditLedger)
      .values({
        userId: user.id,
        entryType: 'monthly_grant',
        bucket: 'monthly',
        amountCents: refill.monthlyAllowanceCents,
        stripeRef,
        // Settled on insert. consumeStatus defaults to 'pending', but the backfill
        // cron sweeps EVERY pending ledger row through settlePendingLedgerRow, which
        // SUBTRACTS abs(amountCents) from the balance (it's built for unsettled usage
        // charges). A pending funding row — positive amountCents — would be clawed
        // back after the grace period, reversing the credit we just granted. Funding
        // applies its balance change in this same transaction, so it is already settled.
        consumeStatus: 'applied',
      })
      .onConflictDoNothing(STRIPE_REF_ARBITER)
      .returning({ id: creditLedger.id });

    // Redelivered invoice.paid (or one already refilled): the grant row exists, so
    // the balance was already reset for this period. Do not refill again.
    if (inserted.length === 0) return;

    await tx
      .insert(creditBalances)
      .values({
        userId: user.id,
        monthlyRemainingCents: refill.monthlyRemainingCents,
        monthlyAllowanceCents: refill.monthlyAllowanceCents,
        // Renewal restores the FULL allowance and FORGIVES outstanding overage
        // (refill.debtCents === 0): last period's debt never reduces this period.
        debtCents: refill.debtCents,
        monthlyPeriodStart: start,
        monthlyPeriodEnd: end,
      })
      .onConflictDoUpdate({
        target: creditBalances.userId,
        set: {
          monthlyRemainingCents: refill.monthlyRemainingCents,
          monthlyAllowanceCents: refill.monthlyAllowanceCents,
          debtCents: refill.debtCents,
          monthlyPeriodStart: start,
          monthlyPeriodEnd: end,
        },
      });
  });

  loggers.api.info('credit funding: monthly refill applied', {
    userId: user.id,
    tier,
    allowanceCents: refill.monthlyAllowanceCents,
    stripeRef,
  });
}

/**
 * checkout.session.completed (credit_pack) — apply the purchased pack to the user's
 * balance: pay down any outstanding overage (debtCents) FIRST, then credit the
 * remainder to the never-expiring top-up bucket. Records a topup_purchase ledger row
 * keyed on the session id for the FULL amount (the debt-vs-topup split is derivable);
 * the balance change only runs if that row was newly inserted. Covers both fixed packs
 * and custom amounts — both arrive as `packCents`.
 */
async function applyTopupFunding(event: FundingEvent, packCents: number): Promise<void> {
  const obj = event.data.object;
  const stripeRef = obj.id ?? null;
  if (!stripeRef) {
    loggers.api.warn('credit funding skipped: checkout session has no id', { eventId: event.id });
    return;
  }
  // Resolve from trusted metadata.userId first (the customer may be unlinked on a
  // first-time pack purchase). Skipping here silently drops paid credit, so a miss is
  // logged loudly for follow-up — but it is NOT a failure to retry: redelivery won't
  // make an unresolvable buyer resolvable.
  const user = await resolveTopupUser(obj);
  if (!user) {
    loggers.api.warn('credit funding skipped: no user for credit-pack checkout', { eventId: event.id });
    return;
  }

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(creditLedger)
      .values({
        userId: user.id,
        entryType: 'topup_purchase',
        bucket: 'topup',
        amountCents: packCents,
        stripeRef,
        // Settled on insert — see applyMonthlyRefill: a 'pending' funding row would be
        // clawed back by the backfill cron's pending-usage sweep.
        consumeStatus: 'applied',
      })
      .onConflictDoNothing(STRIPE_REF_ARBITER)
      .returning({ id: creditLedger.id });

    // Redelivered checkout: the purchase row exists, so the top-up was already
    // credited. Do not add it again.
    if (inserted.length === 0) return;

    // Ensure a balance row exists FIRST, so the FOR UPDATE below always locks a real
    // row. Without this, two concurrent first-time purchases (distinct session ids —
    // their ledger inserts don't serialize each other) would both read 0 from a
    // non-existent row, both compute applyPaymentToDebt(.., pack), and the second write
    // would overwrite the first: a lost top-up on a money path. The lock makes the
    // read-modify-write atomic so both increments apply.
    await tx
      .insert(creditBalances)
      .values({ userId: user.id })
      .onConflictDoNothing({ target: creditBalances.userId });

    const rows = await tx
      .select({
        topupRemainingCents: creditBalances.topupRemainingCents,
        debtCents: creditBalances.debtCents,
      })
      .from(creditBalances)
      .where(eq(creditBalances.userId, user.id))
      .for('update');
    // Pay down any outstanding overage FIRST, then credit the remainder to the
    // never-expiring top-up bucket. This is the within-period recovery: a user in the
    // red who buys credits clears their debt before any surplus becomes spendable.
    const settled = applyPaymentToDebt(rows[0].debtCents, rows[0].topupRemainingCents, packCents);

    await tx
      .update(creditBalances)
      .set({ topupRemainingCents: settled.topupCents, debtCents: settled.debtCents })
      .where(eq(creditBalances.userId, user.id));
  });

  loggers.api.info('credit funding: top-up applied', {
    userId: user.id,
    packCents,
    stripeRef,
  });
}

/**
 * Fund a user's prepaid balance from a Stripe event. Routes via the pure
 * classifier, then runs the matching funding path. A no-op when billing is
 * disabled (tenant/onprem), for tier_change events (the next invoice.paid refills
 * at the new allowance — tier persistence is handled by the subscription handler),
 * and for ignored events. On a genuine failure it logs and RE-THROWS so the caller
 * (the webhook) can surface a non-2xx and let Stripe redeliver; funding is
 * idempotent on stripeRef, so a reprocess credits exactly once.
 */
export interface FundingOptions {
  /**
   * Tier derived from the PAID invoice (invoice.paid line price). Authoritative over the
   * stored user tier, which can lag behind a near-simultaneous subscription webhook.
   * Only used by the monthly_refill path.
   */
  tier?: SubscriptionTier;
}

export async function applyStripeFunding(event: FundingEvent, opts?: FundingOptions): Promise<void> {
  if (!isBillingEnabled()) return; // tenant/onprem credit via the control plane, not Stripe

  const action = classifyStripeEvent(event);
  try {
    switch (action.kind) {
      case 'monthly_refill':
        await applyMonthlyRefill(event, opts?.tier);
        break;
      case 'topup':
        await applyTopupFunding(event, action.packCents);
        break;
      case 'tier_change':
      case 'ignore':
        break;
    }
  } catch (error) {
    // Log with funding context, then rethrow: the webhook clears the processed-event
    // marker on a funding failure so Stripe's redelivery reprocesses (otherwise the
    // coarse stripeEvents guard would short-circuit the retry and the paid credit
    // would be lost permanently).
    loggers.api.error(
      'credit funding failed; rethrowing so Stripe can redeliver',
      error instanceof Error ? error : undefined,
      { eventId: event.id, kind: action.kind },
    );
    throw error instanceof Error ? error : new Error(String(error));
  }
}

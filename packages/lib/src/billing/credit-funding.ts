/**
 * credit-funding — imperative shell that turns a paid Stripe event into spendable
 * prepaid credit. Pure routing/arithmetic (classifyStripeEvent, computeMonthlyRefill,
 * applyPaymentToDebt) comes from credit-core; this file only does I/O.
 *
 * Two funding paths:
 *   - monthly_refill (invoice.paid): a subscription renewal ADDS the monthly grant
 *     to the current monthly balance (rollover) and rolls the billing window forward.
 *     Only a REAL subscription invoice (billing_reason subscription_cycle or
 *     subscription_create) can grant at all — a manual, parentless, or otherwise
 *     account-plan-classified invoice grants nothing regardless of amount_paid
 *     (invoice-grant.ts). The grant is sized from what the invoice PAID:
 *     invoice.amount_paid × the tier's included-credit ratio (Spec MON-2, via the
 *     pure invoice-grant module). The ratio itself is what MONEY_MODEL_V2_ACTIVE
 *     gates (money-model.ts, D-OW-17 — a code constant, not an env var); off, 100%
 *     of the paid amount is granted, which reproduces today's amounts for a
 *     full-price invoice. Gifts and trials are funded at
 *     list price × ratio (D-OW-16a) — gifted status is read from the invoice's
 *     own subscription-metadata snapshot first, so it cannot race the
 *     subscription webhook, with the live subscriptions row as a fallback. Any
 *     other $0 invoice grants nothing. The ledger row records paidCents so the
 *     derivation is auditable per row. A PAID invoice whose tier has no ratio is a
 *     MISSED grant: a 'missed_grant' ledger row (amountCents 0, stripeRef = the
 *     invoice) is written for the reconcile cron to re-grant once the tier is
 *     repaired, and the miss is logged at error.
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
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { eq, sql } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import { classifyStripeEvent, computeMonthlyRefill, applyPaymentToDebt } from './credit-core';
import { grantForInvoice } from './invoice-grant';
import { MONEY_MODEL_V2_ACTIVE } from './money-model';
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
  /** Stripe invoice.amount_paid — what the invoice actually collected, in minor units. */
  amount_paid?: number | null;
  /** Stripe invoice.subtotal — line items before discounts; 0 on a trial-create invoice. */
  subtotal?: number | null;
  /** Stripe invoice.billing_reason. */
  billing_reason?: string | null;
  /**
   * `invoice.parent.subscription_details.metadata` — an immutable copy of the
   * subscription's metadata Stripe snapshots onto the invoice at finalization
   * (populated for invoices created on or after 2023-06-29). Read here so gifted
   * detection needs no DB round trip and cannot race the subscription webhook —
   * see {@link isGiftInvoice}.
   */
  parent?: {
    subscription_details?: {
      metadata?: Record<string, string> | null;
      /**
       * The subscription this invoice was generated FOR — a string id, or an
       * expanded object with one, or absent/null for a manual/one-off invoice.
       * Presence is the SECURITY gate {@link invoiceHasSubscriptionParent} reads
       * (Codex P1 ruling: discriminate by subscription-parent absence, not by
       * billing_reason).
       */
      subscription?: string | { id?: string | null } | null;
    } | null;
  } | null;
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
 * The renewal invoice is the period boundary. The SERVICE period being paid for
 * lives on the invoice's line items — Stripe's invoice-level period_start/end
 * describe the cycle that just ENDED (for a first invoice, both equal the
 * creation instant), so stamping those froze every subscriber's window at
 * "already expired" the moment their renewal landed (2026-07-07 audit). Prefer
 * the line with the LATEST period end (a plan-change invoice carries proration
 * lines for the old plan alongside the new plan's full period); fall back to
 * the invoice-level fields only when no line carries a period.
 */
function invoicePeriod(obj: FundingEventObject): { start: Date | null; end: Date | null } {
  let start: Date | null = null;
  let end: Date | null = null;
  for (const line of obj.lines?.data ?? []) {
    const lineStart = toDate(line?.period?.start);
    const lineEnd = toDate(line?.period?.end);
    if (lineStart && lineEnd && (!end || lineEnd > end)) {
      start = lineStart;
      end = lineEnd;
    }
  }
  return {
    start: start ?? toDate(obj.period_start),
    end: end ?? toDate(obj.period_end),
  };
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
 * Whether the user's live subscription was gifted by an admin (D-OW-16a: a gift is
 * funded at list price × ratio, not from the $0 it paid). Gifted rows are created
 * by admin before any invoice, so this lookup is not subject to the invoice-vs-
 * subscription webhook race. Only eq() is used so the funding shell stays trivially
 * mockable.
 */
async function isGiftedSubscriber(userId: string): Promise<boolean> {
  const rows = await db
    .select({ gifted: subscriptions.gifted, status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId));
  return rows.some((r) => r.gifted === true && (r.status === 'active' || r.status === 'trialing'));
}

/** Metadata the admin gift-subscription route stamps on the Stripe subscription
 * it creates (`apps/admin/.../gift-subscription/route.ts`). */
const GIFT_SUBSCRIPTION_METADATA_TYPE = 'gift_subscription';

/**
 * Whether THIS invoice is for a gifted subscription, read straight off the
 * invoice's own subscription-metadata snapshot — no DB lookup, no ordering
 * dependency on the subscription webhook.
 *
 * `isGiftedSubscriber` (the DB row) can be wrong for the gift's OWN FIRST invoice:
 * invoice.paid can arrive before customer.subscription.created writes the local
 * `subscriptions` row, so that lookup finds nothing and reports not-gifted — the
 * recipient of a gift would get zero credits until some later invoice (Codex P1,
 * "Derive gifted status from the invoice"). The metadata snapshot on THIS event
 * has no such race: Stripe writes it onto the invoice at finalization, in the
 * same payload the webhook is already processing, so it can never lag behind.
 */
function isGiftInvoice(obj: FundingEventObject): boolean {
  return obj.parent?.subscription_details?.metadata?.type === GIFT_SUBSCRIPTION_METADATA_TYPE;
}

/**
 * Whether this invoice was generated FOR an actual subscription (Codex P1 ruling:
 * discriminate a manual/parentless invoice by the ABSENCE of a subscription
 * parent, not by billing_reason — an enumerated billing_reason allowlist first
 * excluded, then had to special-case back in, a legitimate PAID subscription_update
 * invoice from a mid-cycle upgrade; subscription-parent presence is the structural
 * fact that actually distinguishes "a real subscription invoice" and needs no
 * per-billing_reason maintenance). Mirrors dedicated-routing.ts's
 * `invoiceSubscriptionId` (kept local: that file lives in apps/web and uses the
 * real Stripe.Invoice type; packages/lib stays Stripe-SDK-free).
 */
function invoiceHasSubscriptionParent(obj: FundingEventObject): boolean {
  const subscription = obj.parent?.subscription_details?.subscription;
  if (typeof subscription === 'string') return subscription.length > 0;
  if (subscription && typeof subscription === 'object' && typeof subscription.id === 'string') {
    return subscription.id.length > 0;
  }
  return false;
}

/**
 * A PAID invoice whose tier resolved to one with no ratio (stored tier still 'free'
 * and no usable price on the line): fail closed — grant nothing — but leave a
 * 'missed_grant' ledger row (amountCents 0, stripeRef = the invoice, paidCents = what
 * was paid) so the reconcile cron (Phase 2 leaf) can re-grant once the tier is
 * repaired, and log at error with everything needed to find it. The row shares the
 * stripeRef unique index with the eventual monthly_grant, so the reconcile must
 * REPLACE this row (same stripeRef) rather than insert beside it; a plain Stripe
 * redelivery of the same event still dedupes on it.
 */
async function recordMissedGrant(
  userId: string,
  tier: SubscriptionTier,
  paidCents: number,
  stripeRef: string,
  eventId: string,
): Promise<void> {
  loggers.api.error('credit funding: MISSED grant — paid invoice resolved to a tier with no ratio', undefined, {
    eventId,
    invoiceId: stripeRef,
    userId,
    storedTier: tier,
    paidCents,
  });
  await db
    .insert(creditLedger)
    .values({
      userId,
      entryType: 'missed_grant',
      bucket: 'monthly',
      amountCents: 0,
      paidCents,
      stripeRef,
      // Settled on insert (see applyMonthlyRefill): keeps the backfill sweep off it.
      consumeStatus: 'applied',
    })
    .onConflictDoNothing(STRIPE_REF_ARBITER);
}

/**
 * invoice.paid — add the invoice-sized grant to the current monthly balance (rollover)
 * and roll the billing window forward, recording a monthly_grant ledger row keyed
 * on the invoice id. The balance write only runs if the grant row was newly inserted.
 */
async function applyMonthlyRefill(
  event: FundingEvent,
  tierOverride?: SubscriptionTier,
  active: boolean = MONEY_MODEL_V2_ACTIVE,
): Promise<void> {
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
  // MON-2 / D-OW-16: the grant is sized from what THIS invoice paid, never from a
  // tier table — a promo, a proration, or a price change flows through with no table
  // edit. A gift or a trial is us fronting the plan and derives from the list price.
  // Gifted status is read from the invoice's OWN metadata snapshot first — no DB
  // round trip, no race against the subscription webhook (Codex P1) — with the live
  // subscriptions row as a secondary OR (still correct when it resolves, and covers
  // an admin flipping the flag on an existing, already-processed subscription).
  const gifted = isGiftInvoice(obj) || (await isGiftedSubscriber(user.id));
  const grant = grantForInvoice({
    amountPaidCents: obj.amount_paid,
    subtotalCents: obj.subtotal,
    billingReason: obj.billing_reason,
    hasSubscriptionParent: invoiceHasSubscriptionParent(obj),
    gifted,
    tier,
  }, active);
  const allowanceCents = grant.allowanceCents;
  if (allowanceCents <= 0) {
    if (grant.reason === 'no_ratio' && grant.paidCents > 0) {
      await recordMissedGrant(user.id, tier, grant.paidCents, stripeRef, event.id);
      return;
    }
    // Nothing paid and not a gift or trial (proration-only, subscription_update at
    // $0, a 100% coupon on a non-gifted subscription): nothing to grant, nothing to
    // record, nothing to dedupe — the next PAID invoice sizes its own grant.
    loggers.api.info('credit funding: invoice grants nothing', {
      userId: user.id,
      tier,
      paidCents: grant.paidCents,
      stripeRef,
      reason: grant.reason,
    });
    return;
  }
  const { start, end } = invoicePeriod(obj);
  let carriedCents = 0;

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(creditLedger)
      .values({
        userId: user.id,
        entryType: 'monthly_grant',
        bucket: 'monthly',
        amountCents: allowanceCents,
        // What the invoice actually paid — the grant above is derived from it, so the
        // ratio is auditable row by row (MON-2).
        paidCents: grant.paidCents,
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
    // the balance was already updated for this period. Do not refill again.
    if (inserted.length === 0) return;

    // Ensure the balance row exists before we try to lock it. FOR UPDATE only locks
    // existing rows: if two distinct invoices race for a brand-new user, both would
    // read "no row" → carriedCents = 0 → each writes allowance, the second
    // overwriting the first and losing a grant. The stub insert guarantees a row is
    // present so the FOR UPDATE below can serialise concurrent refills correctly.
    await tx
      .insert(creditBalances)
      .values({ userId: user.id })
      .onConflictDoNothing({ target: creditBalances.userId });

    // Read the current balance INSIDE the same transaction, locked FOR UPDATE, so the
    // rollover addition is atomic. The ON CONFLICT guard serialises redelivery of the
    // SAME invoice, but two DISTINCT invoices for the same user (e.g. rapid plan change
    // triggering two consecutive renewals) would both pass the insert check and could
    // race here: without the lock both reads see the same carried balance and each
    // writes carried + allowance, the second overwriting the first and losing a grant.
    // The row lock serialises them so both increments apply.
    const [currentRow] = await tx
      .select({ monthlyRemainingCents: creditBalances.monthlyRemainingCents, debtCents: creditBalances.debtCents })
      .from(creditBalances)
      .where(eq(creditBalances.userId, user.id))
      .for('update')
      .limit(1);
    carriedCents = currentRow?.monthlyRemainingCents ?? 0;
    const refill = computeMonthlyRefill(allowanceCents, carriedCents, currentRow?.debtCents ?? 0);

    await tx
      .insert(creditBalances)
      .values({
        userId: user.id,
        monthlyRemainingCents: refill.monthlyRemainingCents,
        monthlyAllowanceCents: refill.monthlyAllowanceCents,
        // Renewal nets outstanding debt against the carried balance before adding the
        // allowance (refill.debtCents === 0 — debt absorbed, not forwarded).
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
    allowanceCents,
    paidCents: grant.paidCents,
    basis: grant.basis,
    reason: grant.reason,
    carried: carriedCents,
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
  /**
   * D-OW-17 test seam ONLY: overrides the money-model ratio flag for this call.
   * Defaults to {@link MONEY_MODEL_V2_ACTIVE} — no production caller (the Stripe
   * webhook route) ever passes this; it exists so a shell-level test can prove
   * `applyStripeFunding` actually applies the ratio (active=true → 60% of paid)
   * rather than just passing amount_paid straight through, without mutating
   * process.env.MONEY_MODEL_V2 (banned by the seam guard). Only used by the
   * monthly_refill path.
   */
  active?: boolean;
}

export async function applyStripeFunding(event: FundingEvent, opts?: FundingOptions): Promise<void> {
  if (!isBillingEnabled()) return; // tenant/onprem credit via the control plane, not Stripe

  const action = classifyStripeEvent(event);
  try {
    switch (action.kind) {
      case 'monthly_refill':
        await applyMonthlyRefill(event, opts?.tier, opts?.active);
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

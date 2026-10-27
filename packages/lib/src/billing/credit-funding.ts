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
 *     pure invoice-grant module). Gifts are funded at
 *     list price × ratio (D-OW-16a) — gifted status is read from the invoice's
 *     own subscription-metadata snapshot first, so it cannot race the
 *     subscription webhook, with the live subscriptions row as a fallback. Any
 *     other $0 invoice grants nothing. The ledger row records paidCents so the
 *     derivation is auditable per row. Missing or rejected invoice identities
 *     grant nothing and never create a repair candidate. Subscription state
 *     cannot override the invoice-derived identity.
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
import { creditLedger } from '@pagespace/db/schema/credits';
import { wallets, personalRootWalletOf, PERSONAL_ROOT_WALLET_UPSERT_TARGET } from '@pagespace/db/schema/wallets';
import { users } from '@pagespace/db/schema/auth';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { eq, sql } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import { classifyStripeEvent, computeMonthlyRefill, applyPaymentToDebt, forgivenAtRefillCents } from './credit-core';
import { debtClearedRow, DEBT_FORGIVEN_ENTRY } from './wallet-ledger-core';
import { grantForInvoice } from './invoice-grant';
import { GIFT_SUBSCRIPTION_METADATA_TYPE } from './wallet-funding';
import { ensurePersonalRootWalletId } from './personal-wallet';
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
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1);
  if (!rows.length) return null;
  return { id: rows[0].id };
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

/** The transaction handle every funding write runs inside. */
type FundingTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface MonthlyGrantInput {
  userId: string;
  /** Exactly-once key on credit_ledger.stripeRef (an invoice id, or `apple:<transactionId>`). */
  fundingRef: string;
  allowanceCents: number;
  /** The price the grant was sized from, recorded for audit (MON-2). */
  paidCents: number;
  periodStart: Date | null;
  periodEnd: Date | null;
}

/**
 * Add a monthly grant to the payer's personal root (rollover) inside `tx`, keyed on
 * `fundingRef` so a redelivery funds exactly once, and roll the billing window forward.
 * The store-agnostic core of a subscription renewal: invoice.paid and an App Store
 * renewal both fund through it. Returns whether the grant was newly applied.
 */
export async function fundMonthlyGrant(tx: FundingTx, input: MonthlyGrantInput): Promise<{ applied: boolean; carriedCents: number }> {
  const { userId, fundingRef, allowanceCents, paidCents } = input;
  const start = input.periodStart;
  const end = input.periodEnd;
  // The payer's personal root wallet (WAL-5), created bare if this is their first
  // funding. It must exist before the FOR UPDATE below: that lock only locks an
  // existing row, and if two distinct invoices raced for a brand-new user both would
  // read "no row" -> carriedCents = 0 -> each would write the allowance, the second
  // overwriting the first and losing a grant. With the row guaranteed, the lock
  // serialises concurrent refills correctly.
  const walletId = await ensurePersonalRootWalletId(tx, userId);
  const inserted = await tx
    .insert(creditLedger)
    .values({
      userId,
      walletId,
      entryType: 'monthly_grant',
      bucket: 'monthly',
      amountCents: allowanceCents,
      // What was actually paid (or, for the App Store, the web-equivalent price) — the
      // grant above is derived from it, so the ratio is auditable row by row (MON-2).
      paidCents,
      stripeRef: fundingRef,
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
  if (inserted.length === 0) return { applied: false, carriedCents: 0 };

  // Read the current balance INSIDE the same transaction, locked FOR UPDATE, so the
  // rollover addition is atomic. The ON CONFLICT guard serialises redelivery of the
  // SAME invoice, but two DISTINCT invoices for the same user (e.g. rapid plan change
  // triggering two consecutive renewals) would both pass the insert check and could
  // race here: without the lock both reads see the same carried balance and each
  // writes carried + allowance, the second overwriting the first and losing a grant.
  // The row lock serialises them so both increments apply.
  const [currentRow] = await tx
    .select({ monthlyRemainingCents: wallets.monthlyRemainingCents, debtCents: wallets.debtCents, monthlyPeriodStart: wallets.monthlyPeriodStart })
    .from(wallets)
    .where(personalRootWalletOf(userId))
    .for('update')
    .limit(1);
  const carriedCents = currentRow?.monthlyRemainingCents ?? 0;
  const refill = computeMonthlyRefill(allowanceCents, carriedCents, currentRow?.debtCents ?? 0);
  // WAL-5: debt the clamp forgives is a balance change, so it is a row in this transaction.
  const forgiven = debtClearedRow({ entryType: DEBT_FORGIVEN_ENTRY, userId, walletId, clearedCents: forgivenAtRefillCents(allowanceCents, carriedCents, currentRow?.debtCents ?? 0) });
  if (forgiven) await tx.insert(creditLedger).values(forgiven);

  // A late invoice still funds once, but cannot rewind the root clock its drive allocations use.
  const currentStart = currentRow?.monthlyPeriodStart ?? null;
  const periodMovesForward = start !== null && end !== null && (currentStart === null || start > currentStart);
  const setsAllowance = currentStart === null || (start !== null && start >= currentStart);

  await tx
    .insert(wallets)
    .values({
      userId,
      monthlyRemainingCents: refill.monthlyRemainingCents,
      monthlyAllowanceCents: refill.monthlyAllowanceCents,
      // Renewal nets outstanding debt against the carried balance before adding the
      // allowance (refill.debtCents === 0 — debt absorbed, not forwarded).
      debtCents: refill.debtCents,
      monthlyPeriodStart: start,
      monthlyPeriodEnd: end,
    })
    .onConflictDoUpdate({
      ...PERSONAL_ROOT_WALLET_UPSERT_TARGET,
      set: {
        monthlyRemainingCents: refill.monthlyRemainingCents,
        ...(setsAllowance ? { monthlyAllowanceCents: refill.monthlyAllowanceCents } : {}),
        debtCents: refill.debtCents,
        ...(periodMovesForward ? { monthlyPeriodStart: start, monthlyPeriodEnd: end } : {}),
      },
    });
  return { applied: true, carriedCents };
}

/**
 * invoice.paid — add the invoice-sized grant to the current monthly balance (rollover)
 * and roll the billing window forward, recording a monthly_grant ledger row keyed
 * on the invoice id. The balance write only runs if the grant row was newly inserted.
 */
async function applyMonthlyRefill(event: FundingEvent, tierOverride?: SubscriptionTier, planPaidCents?: number): Promise<void> {
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

  // Only a verified personal invoice identity authorizes this funding path. A
  // cached user tier cannot establish what this invoice actually purchased.
  const tier = tierOverride === 'pro' ? 'pro' : 'free';
  // MON-2 / D-OW-16: the grant is sized from what THIS invoice paid, never from a
  // tier table — a promo, a proration, or a price change flows through with no table
  // edit. A gift is us fronting the plan and derives from the list price.
  // Gifted status is read from the invoice's OWN metadata snapshot first — no DB
  // round trip, no race against the subscription webhook (Codex P1) — with the live
  // subscriptions row as a secondary OR (still correct when it resolves, and covers
  // an admin flipping the flag on an existing, already-processed subscription).
  const gifted = isGiftInvoice(obj) || (await isGiftedSubscriber(user.id));
  const grant = grantForInvoice({
    amountPaidCents: planPaidCents === undefined ? obj.amount_paid : Math.min(planPaidCents, obj.amount_paid ?? 0),
    billingReason: obj.billing_reason,
    hasSubscriptionParent: invoiceHasSubscriptionParent(obj),
    gifted,
    tier,
  });
  const allowanceCents = grant.allowanceCents;
  if (allowanceCents <= 0) {
    // Nothing paid and not a gift (proration-only, subscription_update at
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
    const funded = await fundMonthlyGrant(tx, { userId: user.id, fundingRef: stripeRef, allowanceCents, paidCents: grant.paidCents, periodStart: start, periodEnd: end });
    carriedCents = funded.carriedCents;
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

export interface TopupInput {
  userId: string;
  /** Exactly-once key on credit_ledger.stripeRef (a checkout session id, or `apple:<transactionId>`). */
  fundingRef: string;
  topupCents: number;
}

/**
 * Apply a purchased top-up to the payer's personal root inside `tx`: pay down any
 * outstanding debt FIRST, then credit the remainder to the never-expiring top-up
 * bucket, keyed on `fundingRef` so a redelivery credits exactly once. Shared by Stripe
 * credit-pack checkouts and App Store consumables. Returns whether it was newly applied.
 */
export async function fundTopup(tx: FundingTx, input: TopupInput): Promise<{ applied: boolean }> {
  const { userId, fundingRef, topupCents } = input;
  // The payer's personal root wallet (WAL-5), created bare if this is their first
  // purchase. It must exist FIRST, so the FOR UPDATE below always locks a real row.
  // Without it, two concurrent first-time purchases (distinct session ids — their
  // ledger inserts don't serialize each other) would both read 0 from a non-existent
  // row, both compute applyPaymentToDebt(.., pack), and the second write would
  // overwrite the first: a lost top-up on a money path. The lock makes the
  // read-modify-write atomic so both increments apply.
  const walletId = await ensurePersonalRootWalletId(tx, userId);
  const inserted = await tx
    .insert(creditLedger)
    .values({
      userId,
      walletId,
      entryType: 'topup_purchase',
      bucket: 'topup',
      amountCents: topupCents,
      stripeRef: fundingRef,
      // Settled on insert — see fundMonthlyGrant: a 'pending' funding row would be
      // clawed back by the backfill cron's pending-usage sweep.
      consumeStatus: 'applied',
    })
    .onConflictDoNothing(STRIPE_REF_ARBITER)
    .returning({ id: creditLedger.id });

  // Redelivered purchase: the purchase row exists, so the top-up was already
  // credited. Do not add it again.
  if (inserted.length === 0) return { applied: false };

  const rows = await tx
    .select({
      topupRemainingCents: wallets.topupRemainingCents,
      debtCents: wallets.debtCents,
    })
    .from(wallets)
    .where(personalRootWalletOf(userId))
    .for('update');
  // Pay down any outstanding overage FIRST, then credit the remainder to the
  // never-expiring top-up bucket. This is the within-period recovery: a user in the
  // red who buys credits clears their debt before any surplus becomes spendable.
  const settled = applyPaymentToDebt(rows[0].debtCents, rows[0].topupRemainingCents, topupCents);

  await tx
    .update(wallets)
    .set({ topupRemainingCents: settled.topupCents, debtCents: settled.debtCents })
    .where(personalRootWalletOf(userId));
  return { applied: true };
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
    await fundTopup(tx, { userId: user.id, fundingRef: stripeRef, topupCents: packCents });
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
   * Tier derived from the complete PAID invoice. Only personal Pro can fund a
   * monthly refill; missing, Free, Business and invalid identities grant nothing.
   * Top-ups do not use this field.
   */
  tier?: SubscriptionTier;
  /**
   * The part of invoice.amount_paid that bought the PLAN, when the invoice also
   * carries lines that are not the plan (a storage add-on). Storage revenue never
   * sizes the AI-credit grant. Absent: the whole amount_paid is the plan's.
   */
  planPaidCents?: number;
}

export async function applyStripeFunding(event: FundingEvent, opts?: FundingOptions): Promise<void> {
  if (!isBillingEnabled()) return; // tenant/onprem credit via the control plane, not Stripe

  const action = classifyStripeEvent(event);
  try {
    switch (action.kind) {
      case 'monthly_refill':
        await applyMonthlyRefill(event, opts?.tier, opts?.planPaidCents);
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

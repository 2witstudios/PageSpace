/**
 * invoice-grant — pure sizing of a monthly credit grant from a Stripe invoice
 * (Spec MON-2, MON-3; ruling D-OW-16). No I/O; credit-funding is the shell.
 *
 * SECURITY: only a REAL subscription invoice may grant at all — billing_reason must
 * be subscription_cycle or subscription_create. routeInvoice classifies a manual or
 * otherwise parentless invoice as account_plan (it has no subscription to be
 * anything else), and that invoice can still carry a large amount_paid from an
 * existing paid customer; without this gate that invoice would derive a large
 * grant it has nothing to do with (Codex P1, "Restrict derived grants to
 * account-plan invoices"). Every other billing_reason — subscription_update,
 * manual, threshold, upcoming, anything unrecognised or absent — grants nothing,
 * regardless of amount.
 *
 * Entitlement otherwise follows the amount ACTUALLY PAID, except for grants we
 * deliberately fund ourselves (D-OW-16):
 *   (a) a gifted subscription (subscriptions.gifted), or a subscription created
 *       with a trial, is us fronting the plan: grant list price × ratio;
 *   (b) a proration-only or subscription_update invoice that paid nothing: nothing;
 *   (c) a partial discount: amount_paid × ratio, per MON-2;
 *   (d) a 100% coupon on a non-gifted subscription: nothing — admin gifting sets
 *       the flag, and that is the intended door.
 *
 * Org subscriptions (Phase 3): the pool refill is (Business base + extra-seat line
 * items) paid × ratio — {@link grantForInvoiceLines} is the seam Phase 3 calls.
 * Proration lines (positive for the new plan, negative credit for the unused old
 * plan) are plain amounts and sum naturally; a net negative sum grants nothing.
 */

import type { SubscriptionTier } from './subscription-tiers';
import { allowanceCentsForPaidCents, tierListPriceCents } from './money-model';

/** What the grant was sized from. */
export type GrantBasis =
  /** amount_paid × ratio (MON-2). */
  | 'paid'
  /** list price × ratio — a gift or a trial we fund ourselves (D-OW-16a). */
  | 'list'
  /** nothing granted. */
  | 'none';

export type GrantReason =
  | 'paid'
  | 'gifted'
  | 'trial'
  /** amount_paid is 0 and neither gifted nor a trial (D-OW-16 b, d). */
  | 'zero_amount'
  /** something was paid but the resolved tier has no ratio (free/unknown): a MISSED grant. */
  | 'no_ratio'
  /**
   * billing_reason is not subscription_cycle or subscription_create: not a real
   * subscription renewal/creation, so never a grant regardless of amount paid
   * (Codex P1 security fix). Distinct from 'zero_amount' — this is refused on the
   * invoice's KIND, not its amount, and is never a missed_grant candidate: there is
   * no tier to repair here, the invoice itself is simply not eligible.
   */
  | 'not_a_subscription_invoice';

export interface InvoiceGrant {
  /** What the invoice actually paid, in whole cents — recorded on the ledger row for audit. */
  paidCents: number;
  /** Credit value granted. */
  allowanceCents: number;
  basis: GrantBasis;
  reason: GrantReason;
}

export interface InvoiceGrantInput {
  /** Stripe invoice.amount_paid (minor units). */
  amountPaidCents: number | null | undefined;
  /**
   * Stripe invoice.subtotal — the line items BEFORE discounts. Distinguishes a trial
   * (the plan costs nothing this period: subtotal 0) from a 100% coupon (subtotal is
   * the list price, total 0). Read off the invoice, so it is race-free against the
   * subscription webhook.
   */
  subtotalCents?: number | null;
  /** Stripe invoice.billing_reason ('subscription_create' | 'subscription_cycle' | 'subscription_update' | …). */
  billingReason?: string | null;
  /** subscriptions.gifted for the paying subscription. */
  gifted?: boolean;
  tier: SubscriptionTier;
}

/**
 * Structural subset of a Stripe invoice line item the grant reads. `amount` is
 * the line total in the invoice currency's minor unit (signed: proration credits
 * are negative), exactly as Stripe's `InvoiceLineItem.amount`.
 */
export interface InvoiceGrantLine {
  amount?: number | null;
}

function toCents(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

/** The only billing_reason values a derived grant may ever fire on. */
const GRANT_ELIGIBLE_BILLING_REASONS = new Set(['subscription_cycle', 'subscription_create']);

function isGrantEligibleInvoice(billingReason: string | null | undefined): boolean {
  return typeof billingReason === 'string' && GRANT_ELIGIBLE_BILLING_REASONS.has(billingReason);
}

/**
 * A subscription created with a trial: the first invoice charges nothing AND the
 * plan itself cost nothing this period (subtotal 0). A 100% coupon also pays 0 but
 * its subtotal is the list price, so it does not match — D-OW-16(d).
 */
function isTrialCreate(input: InvoiceGrantInput, paidCents: number): boolean {
  return input.billingReason === 'subscription_create'
    && paidCents === 0
    && toCents(input.subtotalCents) === 0;
}

/** Size the grant for a PERSONAL subscription invoice (D-OW-16 a–d). */
export function grantForInvoice(input: InvoiceGrantInput): InvoiceGrant {
  const paidCents = Math.max(0, toCents(input.amountPaidCents));

  // SECURITY gate FIRST, ahead of gifted/trial: an invoice that is not a real
  // subscription renewal or creation never grants, no matter what `gifted` says.
  // This is what confines D-OW-16's gifted/trial carve-outs to invoices that are
  // actually subscription invoices in the first place.
  if (!isGrantEligibleInvoice(input.billingReason)) {
    return { paidCents, allowanceCents: 0, basis: 'none', reason: 'not_a_subscription_invoice' };
  }

  const funded: GrantReason | null = input.gifted === true ? 'gifted' : isTrialCreate(input, paidCents) ? 'trial' : null;
  if (funded) {
    // We front the plan: the grant is what a full-price invoice would derive.
    const allowanceCents = allowanceCentsForPaidCents(tierListPriceCents(input.tier), input.tier);
    return allowanceCents > 0
      ? { paidCents, allowanceCents, basis: 'list', reason: funded }
      : { paidCents, allowanceCents: 0, basis: 'none', reason: 'no_ratio' };
  }

  if (paidCents === 0) return { paidCents, allowanceCents: 0, basis: 'none', reason: 'zero_amount' };

  const allowanceCents = allowanceCentsForPaidCents(paidCents, input.tier);
  return allowanceCents > 0
    ? { paidCents, allowanceCents, basis: 'paid', reason: 'paid' }
    : { paidCents, allowanceCents: 0, basis: 'none', reason: 'no_ratio' };
}

/**
 * Sum the line items an ORG subscription invoice paid for and size the pool refill
 * from that sum (MON-3): base + extra-seat items, with proration credits netted.
 * Seam for Phase 3 (org Stripe subscriptions); nothing calls it yet.
 */
export function grantForInvoiceLines(
  lines: ReadonlyArray<InvoiceGrantLine | null | undefined>,
  tier: SubscriptionTier,
): InvoiceGrant {
  let sum = 0;
  for (const line of lines) sum += toCents(line?.amount);
  const paidCents = Math.max(0, sum);
  if (paidCents === 0) return { paidCents, allowanceCents: 0, basis: 'none', reason: 'zero_amount' };
  const allowanceCents = allowanceCentsForPaidCents(paidCents, tier);
  return allowanceCents > 0
    ? { paidCents, allowanceCents, basis: 'paid', reason: 'paid' }
    : { paidCents, allowanceCents: 0, basis: 'none', reason: 'no_ratio' };
}

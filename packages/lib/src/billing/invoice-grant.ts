/**
 * invoice-grant — pure sizing of a monthly credit grant from what a Stripe invoice
 * actually paid (Spec MON-2, MON-3). No I/O; credit-funding is the shell.
 *
 * Personal subscriptions: the grant is invoice.amount_paid × ratio.
 * Org subscriptions (Phase 3): the grant is (Business base + extra-seat line items)
 * paid × ratio — {@link grantForInvoiceLines} is the seam Phase 3 calls with the
 * subscription's line items. Proration lines (positive for the new plan, negative
 * credit for the unused old plan) are plain amounts and sum naturally; a net
 * negative sum grants nothing.
 */

import type { SubscriptionTier } from './subscription-tiers';
import { allowanceCentsForPaidCents } from './money-model';

export interface InvoiceGrant {
  /** What the invoice paid, in whole cents — recorded on the ledger row for audit. */
  paidCents: number;
  /** Credit value granted for it: paidCents × the tier's included-credit ratio. */
  allowanceCents: number;
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

/**
 * Size the grant for a PERSONAL subscription invoice from the amount it paid.
 * A zero or missing amount (trial start, 100% promo, proration-only) grants nothing.
 */
export function grantForInvoice(
  input: { amountPaidCents: number | null | undefined; tier: SubscriptionTier },
): InvoiceGrant {
  const paidCents = Math.max(0, toCents(input.amountPaidCents));
  return { paidCents, allowanceCents: allowanceCentsForPaidCents(paidCents, input.tier) };
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
  return { paidCents, allowanceCents: allowanceCentsForPaidCents(paidCents, tier) };
}

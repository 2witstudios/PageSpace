import type Stripe from 'stripe';
import { stripe } from '@/lib/stripe';

/** Expand truncated Stripe evidence before deriving plan identity, money, or period. */
export async function completeInvoiceLines(invoice: Stripe.Invoice): Promise<Stripe.Invoice> {
  return completeInvoiceLinesWith(stripe, invoice);
}

/** {@link completeInvoiceLines} over a given Stripe client: every line, `has_more` false. */
export async function completeInvoiceLinesWith(client: Stripe, invoice: Stripe.Invoice): Promise<Stripe.Invoice> {
  if (!invoice.lines?.has_more) return invoice;
  const lines: Stripe.InvoiceLineItem[] = [];
  for await (const line of client.invoices.listLineItems(invoice.id, { limit: 100 })) {
    lines.push(line);
  }
  return { ...invoice, lines: { ...invoice.lines, data: lines, has_more: false } };
}

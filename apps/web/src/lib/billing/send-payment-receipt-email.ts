import React from 'react';
import type { Stripe } from '@/lib/stripe';
import { stripe } from '@/lib/stripe';
import { sendEmail, resolveAppUrl } from '@pagespace/lib/services/email-service';
import { PaymentReceiptEmail } from '@pagespace/lib/email-templates/PaymentReceiptEmail';
import { loggers } from '@pagespace/lib/logging/logger-config';

function formatCents(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

function formatDate(unixSeconds: number): string {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(
    new Date(unixSeconds * 1000),
  );
}

/**
 * Subscription renewal receipt — sent from the webhook's `invoice.paid` branch.
 * Uses only fields already on the paid invoice (no extra Stripe API call): the
 * hosted invoice link is Stripe's own authoritative payment-method/tax detail
 * page, so last4 is deliberately not fetched for this path (see epic plan).
 * Best-effort: never throws, so a Resend failure can't affect the funding that
 * already succeeded or force the webhook to retry.
 */
export async function sendSubscriptionReceiptEmail(params: {
  invoice: Stripe.Invoice;
  email: string;
  userName: string;
  eventId: string;
}): Promise<void> {
  const { invoice, email, userName, eventId } = params;
  try {
    const currency = invoice.currency;
    const fallbackDescription = 'PageSpace subscription';
    const lines = invoice.lines?.data ?? [];
    const lineItems = lines.length
      ? lines.map((line) => ({
          description: line.description ?? fallbackDescription,
          amountFormatted: formatCents(line.amount, currency),
        }))
      : [{ description: fallbackDescription, amountFormatted: formatCents(invoice.amount_paid, currency) }];
    const taxCents = (invoice.total_taxes ?? []).reduce((sum, t) => sum + t.amount, 0);

    await sendEmail({
      to: email,
      subject: 'Your PageSpace receipt',
      react: React.createElement(PaymentReceiptEmail, {
        userName,
        description: lines[0]?.description ?? fallbackDescription,
        dateFormatted: formatDate(invoice.status_transitions?.paid_at ?? invoice.created),
        lineItems,
        taxFormatted: taxCents > 0 ? formatCents(taxCents, currency) : undefined,
        totalFormatted: formatCents(invoice.amount_paid, currency),
        invoiceUrl: invoice.hosted_invoice_url ?? undefined,
        billingSettingsUrl: `${resolveAppUrl()}/settings/billing`,
      }),
      idempotencyKey: `receipt:${eventId}`,
    });
  } catch (error) {
    loggers.api.error(
      'Failed to send subscription payment receipt',
      error instanceof Error ? error : undefined,
      { eventId },
    );
  }
}

/**
 * Credit top-up receipt — sent from the webhook's `checkout.session.completed`
 * (credit_pack) branch. Unlike the subscription path, a top-up's session has no
 * hosted invoice, so last4/receipt link are fetched via ONE extra, version-stable
 * PaymentIntent→Charge lookup; failure there is swallowed and those fields are
 * simply omitted. Best-effort: never throws (see sendSubscriptionReceiptEmail).
 */
export async function sendTopupReceiptEmail(params: {
  session: Stripe.Checkout.Session;
  packLabel: string;
  email: string;
  userName: string;
  eventId: string;
}): Promise<void> {
  const { session, packLabel, email, userName, eventId } = params;
  try {
    const currency = session.currency ?? 'usd';
    const amountCents = session.amount_total ?? 0;
    const taxCents = session.total_details?.amount_tax ?? 0;

    let last4: string | undefined;
    let invoiceUrl: string | undefined;
    const paymentIntentId =
      typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    if (paymentIntentId) {
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
          expand: ['latest_charge'],
        });
        const charge =
          typeof paymentIntent.latest_charge === 'string' ? undefined : paymentIntent.latest_charge;
        last4 = charge?.payment_method_details?.card?.last4 ?? undefined;
        invoiceUrl = charge?.receipt_url ?? undefined;
      } catch (error) {
        loggers.api.warn('Could not fetch payment method details for top-up receipt', {
          eventId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await sendEmail({
      to: email,
      subject: 'Your PageSpace receipt',
      react: React.createElement(PaymentReceiptEmail, {
        userName,
        description: packLabel,
        dateFormatted: formatDate(session.created),
        lineItems: [{ description: packLabel, amountFormatted: formatCents(amountCents, currency) }],
        taxFormatted: taxCents > 0 ? formatCents(taxCents, currency) : undefined,
        totalFormatted: formatCents(amountCents, currency),
        last4,
        invoiceUrl,
        billingSettingsUrl: `${resolveAppUrl()}/settings/billing`,
      }),
      idempotencyKey: `receipt:${eventId}`,
    });
  } catch (error) {
    loggers.api.error(
      'Failed to send credit top-up payment receipt',
      error instanceof Error ? error : undefined,
      { eventId },
    );
  }
}

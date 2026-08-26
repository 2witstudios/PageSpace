/**
 * dedicated-routing — the webhook's fork between an ACCOUNT PLAN and a
 * DEDICATED HOSTING subscription.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A FORK IS NEEDED AT ALL, stated once so nobody removes it as ceremony.
 *
 * The account-plan handlers in `route.ts` assume every subscription on a customer
 * IS that customer's plan. `handleSubscriptionChange` derives a tier from the one
 * subscription in the event and writes it to `users.subscriptionTier`; the
 * `invoice.paid` path refills the customer's monthly AI-credit bucket. Both are
 * correct for the only kind of subscription that has ever existed here, and both
 * are wrong for a hosting charge:
 *
 *   - a hosting subscription carries a price the tier map does not know, so the
 *     tier derives to `free` and a paying Pro/Founder/Business customer is
 *     DEMOTED by buying more. The reconcile cron then reads their unmapped
 *     entitled row as `indeterminate` and deliberately refuses to auto-repair it,
 *     so the demotion is permanent and invisible to the machinery built for
 *     exactly that failure.
 *   - a hosting invoice paid on its own billing anchor would REFILL the monthly
 *     credit allowance a second time each month — free credits, silently, forever.
 *
 * So hosting subscriptions are stamped `metadata.kind = 'published_app_dedicated'`
 * at create, and this module is where that stamp is read.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * FAIL CLOSED MEANS "THE OLD BEHAVIOUR", NOT "NO BEHAVIOUR". Every subscription
 * that exists today has no `kind` at all, and must keep taking the existing path
 * byte-identically — so an absent discriminator classifies as `account_plan`, not
 * as something to quarantine. An UNRECOGNISED `kind` is logged and then also takes
 * the account path: dropping it instead would mean a typo'd or future value on a
 * real account subscription silently stops maintaining that customer's tier, with
 * nothing left for the reconcile cron to repair from. The only thing diverted is
 * a value we positively recognise.
 */

import type { Stripe } from '@/lib/stripe';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  classifySubscriptionKind,
  type StripeSubscriptionKind,
} from '@pagespace/lib/services/app-hosting/dedicated-tier';

/** Stripe metadata, narrowed to what the classifier reads. */
type MetadataBag = Record<string, string> | null | undefined;

/**
 * Classify one subscription, logging an unrecognised `kind` on the way past.
 *
 * The log is the whole value of distinguishing `unknown` from `account_plan`:
 * behaviourally they are the same (both take the existing path), but only one of
 * them means somebody wrote a discriminator this code has never been taught.
 */
export function routeSubscription(
  subscription: Stripe.Subscription,
  eventId: string,
): StripeSubscriptionKind {
  const kind = classifySubscriptionKind(subscription.metadata as MetadataBag);
  if (kind === 'unknown') {
    loggers.api.warn(
      'Stripe subscription carries an unrecognised metadata kind; handling it as an account plan',
      { eventId, subscriptionId: subscription.id, kind: subscription.metadata?.kind },
    );
  }
  return kind;
}

/**
 * Classify one INVOICE, by the subscription metadata Stripe snapshots onto it.
 *
 * `invoice.parent.subscription_details.metadata` is an immutable copy of the
 * subscription's metadata taken at invoice finalization (Stripe populates it for
 * invoices created on or after 2023-06-29). Reading the snapshot rather than
 * looking the subscription up is deliberate: it needs no API call on the hot
 * webhook path, and it describes the subscription AS IT WAS BILLED, which is the
 * thing the funding decision is actually about.
 *
 * An invoice with no subscription parent at all — a one-off credit-pack payment,
 * a manual invoice — has no metadata to read and classifies as `account_plan`,
 * which routes it exactly where it goes today.
 */
export function routeInvoice(invoice: Stripe.Invoice, eventId: string): StripeSubscriptionKind {
  const parent = invoice.parent;
  const metadata = parent?.subscription_details?.metadata as MetadataBag;
  const kind = classifySubscriptionKind(metadata);
  if (kind === 'unknown') {
    loggers.api.warn(
      'Stripe invoice carries an unrecognised subscription metadata kind; handling it as an account plan',
      { eventId, invoiceId: invoice.id, kind: metadata?.kind },
    );
  }
  return kind;
}

/**
 * The subscription id an invoice was generated from, or null.
 *
 * Lives here rather than inline because the field has moved with the API version
 * and the shape is easy to get subtly wrong: it can be an id string OR an expanded
 * `Subscription` object, and a caller that assumed the string would silently
 * stringify an object into a lookup that matches nothing.
 */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (typeof subscription === 'string') return subscription;
  if (subscription && typeof subscription === 'object' && typeof subscription.id === 'string') {
    return subscription.id;
  }
  return null;
}

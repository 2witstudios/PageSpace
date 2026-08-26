/**
 * dedicated-subscription — buying and cancelling the flat monthly SKU that makes
 * a published app always-on.
 *
 * Follows the account-plan pattern in `api/stripe/create-subscription/route.ts`:
 * get-or-create the customer, create the subscription with
 * `payment_behavior: 'default_incomplete'` and a `confirmation_secret`, hand the
 * client secret back for the PaymentElement to confirm. The differences from that
 * route are the two that matter and both are deliberate:
 *
 *   1. THE SUBSCRIPTION IS STAMPED `metadata.kind = 'published_app_dedicated'`,
 *      which is the only thing that keeps it out of the account-tier machinery.
 *      Without it the webhook's `handleSubscriptionChange` would derive an account
 *      tier of `free` from this unmapped price and write it over a paying
 *      customer's tier — see the docblock on `published_app_subscriptions`. The
 *      stamp is applied at CREATE and Stripe treats it as immutable enough for our
 *      purposes (it is snapshotted onto every invoice at finalization), which is
 *      what lets invoice events be routed too.
 *   2. THE APP IS NOT MADE DEDICATED HERE. The subscription is created
 *      `incomplete`, i.e. unpaid; entitlement begins when Stripe says `active`,
 *      which arrives as a webhook. Flipping the tier at create time would hand out
 *      an always-on machine to anyone who started a checkout and abandoned it.
 *      The mirror row IS written now, so the webhook that follows has something to
 *      resolve the subscription to.
 *
 * Every entry point refuses BEFORE touching Stripe when `isDedicatedTierPurchasable()`
 * is false — hosting dark, or a deployment (tenant, onprem) where
 * `isBillingEnabled()` is false and there is no customer to charge.
 */

import { stripe } from '@/lib/stripe';
import { getOrCreateStripeCustomer } from '@/lib/stripe-customer';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  DEDICATED_SUBSCRIPTION_KIND,
  SUBSCRIPTION_KIND_METADATA_KEY,
  isDedicatedEntitled,
  isGuestPresetAllowedForTier,
} from '@pagespace/lib/services/app-hosting/dedicated-tier';
import {
  findDedicatedSubscriptionForApp,
  isDedicatedTierPurchasable,
  recordDedicatedSubscription,
} from '@pagespace/lib/services/app-hosting/dedicated-tier-service';
import { checkDedicatedPrice, type DedicatedPriceRefusal } from './dedicated-price';
import { subscriptionPeriod } from './stripe-subscription-period';

export type StartDedicatedRefusal =
  | 'unavailable'
  | 'guest_preset_not_allowed'
  | 'already_subscribed'
  | DedicatedPriceRefusal;

export type StartDedicatedResult =
  | { ok: true; stripeSubscriptionId: string; clientSecret: string; status: string }
  | { ok: false; reason: StartDedicatedRefusal };

export interface StartDedicatedInput {
  publishedAppId: string;
  /** The app's payer — the drive owner, resolved by the caller. */
  user: Parameters<typeof getOrCreateStripeCustomer>[0];
  /** The size being bought. Must be dedicated-legal and must have a configured price. */
  guestPreset: string;
}

/**
 * Start a dedicated subscription for one published app.
 *
 * Returns a client secret for the PaymentElement; the app becomes dedicated only
 * when Stripe reports the subscription `active` (or `trialing`) through the
 * webhook.
 */
export async function startDedicatedSubscription(
  input: StartDedicatedInput,
): Promise<StartDedicatedResult> {
  if (!isDedicatedTierPurchasable()) return { ok: false, reason: 'unavailable' };

  // Asked before the price, and before Stripe: a size the dedicated tier may not
  // run is not a pricing question, and a deployment that has configured a price
  // for it anyway must still be refused.
  if (!isGuestPresetAllowedForTier(input.guestPreset, 'dedicated')) {
    return { ok: false, reason: 'guest_preset_not_allowed' };
  }

  // One LIVE dedicated subscription per app — and "live" is the whole point of
  // this check, not "a row exists".
  //
  // The mirror keeps a row after a subscription ends, deliberately: the row is
  // what explains WHY an app went back to metered. So refusing on mere existence
  // would mean one abandoned checkout (`incomplete_expired`) or one ordinary
  // cancellation permanently brick the SKU for that app — the customer could
  // never buy always-on again, and the cancel escape hatch would not help them
  // either, since cancelling an already-terminal Stripe subscription errors.
  //
  // What must be refused is a SECOND concurrent charge: a subscription that is
  // paying (`active` / `trialing` / `past_due`), or one whose checkout is still
  // open (`incomplete` — the customer has a payment sheet in front of them right
  // now, and issuing a second subscription would let them pay twice for one app).
  // Anything terminal is a closed chapter, and re-buying overwrites the mirror row
  // through the upsert's `publishedAppId` conflict target.
  const existing = await findDedicatedSubscriptionForApp(input.publishedAppId);
  if (existing && (isDedicatedEntitled(existing.status) || existing.status === 'incomplete')) {
    return { ok: false, reason: 'already_subscribed' };
  }

  const price = await checkDedicatedPrice(input.guestPreset);
  if (!price.ok) {
    loggers.api.warn('Dedicated hosting purchase refused on price validation', {
      publishedAppId: input.publishedAppId,
      guestPreset: input.guestPreset,
      reason: price.reason,
      floorCents: price.floorCents,
      unitAmountCents: price.unitAmountCents,
    });
    return { ok: false, reason: price.reason };
  }

  const customerId = await getOrCreateStripeCustomer(input.user);

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: price.priceId }],
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.confirmation_secret'],
    metadata: {
      // THE DISCRIMINATOR. Everything downstream — the subscription webhook, the
      // invoice webhook, the credit-refill path — routes on this one key. A
      // subscription created without it is an account plan as far as the rest of
      // the system is concerned.
      [SUBSCRIPTION_KIND_METADATA_KEY]: DEDICATED_SUBSCRIPTION_KIND,
      publishedAppId: input.publishedAppId,
      guestPreset: input.guestPreset,
      userId: input.user.id,
    },
  });

  const period = subscriptionPeriod(subscription);
  // Written BEFORE the customer pays, and that ordering is the same one
  // `published_apps` uses for its Fly app: the local pointer exists before the
  // billable thing does. A crash between the Stripe create and this write would
  // leave a subscription in Stripe that nothing local can resolve — the webhook's
  // `unknown_subscription` outcome — whereas this ordering leaves at worst a
  // mirror row for a subscription that never activates, which the status column
  // describes accurately and which entitles nobody.
  await recordDedicatedSubscription({
    publishedAppId: input.publishedAppId,
    userId: input.user.id,
    stripeSubscriptionId: subscription.id,
    stripePriceId: price.priceId,
    guestPreset: input.guestPreset,
    status: subscription.status,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    // No stamp: this write comes from an API RESPONSE, not a webhook, so there is
    // no `event.created` to order it by. A null stamp reads as "unknown order" and
    // does not block the first real event from landing — the terminal-status rule
    // is what protects this row until an event stamps it.
    stripeEventCreated: null,
  });

  const invoice = subscription.latest_invoice as
    | { confirmation_secret?: { client_secret?: string } }
    | null;
  const clientSecret = invoice?.confirmation_secret?.client_secret;
  if (!clientSecret) {
    // The subscription exists and the mirror row records it, so this is not a
    // rollback situation — it is a create we cannot hand a payment sheet for. The
    // customer retries; `already_subscribed` then points them at the pending
    // subscription rather than creating a second one.
    loggers.api.error('Dedicated hosting subscription created with no confirmation secret', undefined, {
      publishedAppId: input.publishedAppId,
      stripeSubscriptionId: subscription.id,
    });
    return { ok: false, reason: 'price_not_found' };
  }

  return {
    ok: true,
    stripeSubscriptionId: subscription.id,
    clientSecret,
    status: subscription.status,
  };
}

export type CancelDedicatedResult =
  | { ok: true; cancelAtPeriodEnd: boolean; currentPeriodEnd: Date }
  | { ok: false; reason: 'unavailable' | 'not_subscribed' };

/**
 * Cancel an app's dedicated subscription AT PERIOD END.
 *
 * At period end rather than immediately, because the customer has paid for the
 * month: an immediate cancel would take an always-on app back to scale-to-zero
 * partway through a period they are already billed for. The tier follows when
 * Stripe emits `customer.subscription.deleted` at the end of the period — the
 * webhook is the only thing that moves the tier, here as everywhere, so a cancel
 * that is later reversed (`reactivate`) needs no compensating local write.
 */
export async function cancelDedicatedSubscription(
  publishedAppId: string,
): Promise<CancelDedicatedResult> {
  if (!isDedicatedTierPurchasable()) return { ok: false, reason: 'unavailable' };

  const mirror = await findDedicatedSubscriptionForApp(publishedAppId);
  if (!mirror) return { ok: false, reason: 'not_subscribed' };

  const subscription = await stripe.subscriptions.update(mirror.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });
  const period = subscriptionPeriod(subscription);

  await recordDedicatedSubscription({
    publishedAppId: mirror.publishedAppId,
    userId: mirror.userId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: mirror.stripePriceId,
    guestPreset: mirror.guestPreset,
    status: subscription.status,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    stripeEventCreated: null,
  });

  return { ok: true, cancelAtPeriodEnd: subscription.cancel_at_period_end, currentPeriodEnd: period.end };
}

/**
 * dedicated-handlers — what the Stripe webhook does with a DEDICATED HOSTING
 * subscription event, once `dedicated-routing.ts` has established that it is one.
 *
 * Two writes, in this order, and the order is the point:
 *
 *   1. MIRROR the subscription into `published_app_subscriptions`. Stripe is the
 *      source of truth for money; that table is our copy of it, and it is what the
 *      publish surface reads to say "renews on…" or "cancels on…".
 *   2. MAKE THE APP'S TIER FOLLOW the subscription's status. Entitlement is a
 *      status question (`active` / `trialing`), never an existence one — a
 *      cancelled subscription keeps its mirror row, because the row is what
 *      explains WHY an app went back to metered.
 *
 * The mirror is written FIRST because the tier sync resolves the app THROUGH it. A
 * `customer.subscription.created` that beat the purchase path's own mirror write
 * would otherwise find nothing and no-op; writing here makes the webhook
 * self-sufficient and makes the two orderings converge on the same state.
 *
 * NEVER THROWS FOR AN ORDINARY MISS. A subscription this deployment has no app for
 * is acked, not retried: Stripe would redeliver forever against a row that is
 * never going to appear (a subscription created against another environment's
 * database is the common case in test mode). A genuine failure — the database is
 * down — still propagates, and the webhook's own retry machinery handles it.
 */

import * as Sentry from '@sentry/nextjs';
import type { Stripe } from '@/lib/stripe';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  findDedicatedSubscriptionByStripeId,
  recordDedicatedSubscription,
  syncAppTierToSubscription,
} from '@pagespace/lib/services/app-hosting/dedicated-tier-service';
import { subscriptionPeriod } from '@/lib/app-hosting/stripe-subscription-period';

export async function handleDedicatedSubscriptionEvent(
  subscription: Stripe.Subscription,
  eventId: string,
): Promise<void> {
  const publishedAppId = subscription.metadata?.publishedAppId;
  const userId = subscription.metadata?.userId;
  const guestPreset = subscription.metadata?.guestPreset;

  // Prefer the metadata the purchase path stamped; fall back to the existing
  // mirror row when an event carries a partial bag (metadata can be edited in the
  // Stripe dashboard, and a human editing one key should not be able to orphan the
  // subscription). Only if BOTH are empty is there nothing to act on.
  const existing = await findDedicatedSubscriptionByStripeId(subscription.id);
  const resolvedAppId = publishedAppId ?? existing?.publishedAppId;
  const resolvedUserId = userId ?? existing?.userId;
  const resolvedPreset = guestPreset ?? existing?.guestPreset;
  const priceId = subscription.items?.data?.[0]?.price?.id ?? existing?.stripePriceId;

  if (!resolvedAppId || !resolvedUserId || !resolvedPreset || !priceId) {
    loggers.api.warn('Dedicated hosting subscription event could not be resolved to an app; acking', {
      eventId,
      stripeSubscriptionId: subscription.id,
      hasMetadataAppId: Boolean(publishedAppId),
      hasMirrorRow: Boolean(existing),
    });
    return;
  }

  const period = subscriptionPeriod(subscription);
  await recordDedicatedSubscription({
    publishedAppId: resolvedAppId,
    userId: resolvedUserId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: priceId,
    guestPreset: resolvedPreset,
    status: subscription.status,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });

  const outcome = await syncAppTierToSubscription(subscription.id, subscription.status);
  loggers.api.info('Dedicated hosting subscription synced', {
    eventId,
    stripeSubscriptionId: subscription.id,
    status: subscription.status,
    outcome: outcome.outcome,
    publishedAppId: resolvedAppId,
  });

  if (outcome.outcome === 'tier_change_refused') {
    // A PURE REVENUE LEAK, and it needs an operator rather than a log line.
    //
    // The case that produces it: a subscription stops paying, so the app should go
    // back to metered — but it is running a guest size the metered tier may not
    // run (`published_apps_metered_guest_preset`, because the awake meter prices
    // one fixed shape). The downgrade is refused rather than forced, deliberately:
    // resizing means destroying and recreating the machine, and a webhook must not
    // take a live app down as a side effect of a billing event. The consequence is
    // an always-on machine nobody is paying for, and it persists until a human
    // resizes or stops it — so a human has to be told.
    //
    // Warning, not error, and fingerprinted on the CAUSE: nothing is broken, and a
    // persistent situation should stay one issue rather than opening a fresh one on
    // every redelivery.
    Sentry.captureMessage(
      `Dedicated hosting: app ${outcome.publishedAppId} could not follow its subscription (${outcome.reason}) — it may be always-on and unbilled`,
      {
        level: 'warning',
        fingerprint: ['dedicated-hosting-tier-change-refused'],
        tags: { check: 'published_app_dedicated_tier_sync' },
        extra: {
          eventId,
          publishedAppId: outcome.publishedAppId,
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
          reason: outcome.reason,
        },
      },
    );
  }
}

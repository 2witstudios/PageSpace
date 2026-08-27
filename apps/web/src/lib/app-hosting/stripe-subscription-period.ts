/**
 * subscriptionPeriod — read a Stripe subscription's current billing period.
 *
 * Exists because the period moved. As of Stripe API version 2025-08-27
 * `current_period_start` / `current_period_end` live on the subscription ITEM,
 * not on the subscription, and the SDK's `Subscription` type has not been widened
 * to say so — which is why `handleSubscriptionChange` in the Stripe webhook casts
 * an item to an intersection type to reach them. This is that extraction, in one
 * place, for the hosting path that now needs it too.
 */

import type { Stripe } from '@/lib/stripe';
import { loggers } from '@pagespace/lib/logging/logger-config';

/** Subscription-item fields the SDK's type does not yet carry. */
type ItemWithPeriod = Stripe.SubscriptionItem & {
  current_period_start?: number;
  current_period_end?: number;
};

export interface SubscriptionPeriod {
  start: Date;
  end: Date;
}

/**
 * WHAT HAPPENS WHEN STRIPE GIVES NO USABLE PERIOD, and why it is a placeholder
 * rather than a thrown error.
 *
 * The alternative — refusing to write — is the worse trade at the one moment this
 * matters. The mirror row is written immediately after the Stripe subscription is
 * created, so failing over an unreadable date leaves a live recurring charge in
 * Stripe that nothing locally can resolve: a subscription we cannot cancel,
 * attribute or reason about. A zero-length window at `now` is self-healing
 * instead — nothing gates on these two columns (entitlement is the `status`
 * column), and the next subscription webhook overwrites them with the real period.
 *
 * The warning below is how it is said out loud. It is deliberately not also a flag
 * on the return value: no caller has anything different to do about it, and a
 * field nobody reads is a claim that somebody is checking.
 */

export function subscriptionPeriod(subscription: Stripe.Subscription): SubscriptionPeriod {
  const item = subscription.items?.data?.[0] as ItemWithPeriod | undefined;
  const startTs = item?.current_period_start;
  const endTs = item?.current_period_end;

  if (typeof startTs === 'number' && typeof endTs === 'number' && startTs > 0 && endTs >= startTs) {
    const start = new Date(startTs * 1000);
    const end = new Date(endTs * 1000);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      return { start, end };
    }
  }

  loggers.api.warn('Stripe subscription carried no readable billing period; mirroring a placeholder', {
    subscriptionId: subscription.id,
    itemId: item?.id,
    startTs,
    endTs,
  });
  const now = new Date();
  return { start: now, end: now };
}

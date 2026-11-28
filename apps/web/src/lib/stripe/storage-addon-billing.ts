import Stripe from 'stripe';
import type { StorageAddonPort } from '@pagespace/lib/billing/storage-addon';
import { stripeConfig } from '../stripe-config';

/**
 * The storage add-on's Stripe writes for one subscription (a person's Pro or an
 * org's Business). Every write refuses rather than leaving an unpaid invoice open
 * (`error_if_incomplete`): a declined card changes nothing and surfaces as an error.
 */
export function stripeStorageAddonPort(client: Stripe, subscriptionId: string): StorageAddonPort {
  return {
    async createItem({ quantity, prorationBehavior, idempotencyKey }) {
      const item = await client.subscriptionItems.create(
        {
          subscription: subscriptionId,
          price: stripeConfig.storageAddonPriceId,
          quantity,
          proration_behavior: prorationBehavior,
          payment_behavior: 'error_if_incomplete',
        },
        { idempotencyKey },
      );
      return { id: item.id };
    },
    async updateItem({ itemId, quantity, prorationBehavior, idempotencyKey }) {
      await client.subscriptionItems.update(
        itemId,
        {
          quantity,
          proration_behavior: prorationBehavior,
          payment_behavior: 'error_if_incomplete',
        },
        { idempotencyKey },
      );
    },
  };
}

/**
 * How a refused storage write is reported. Only a card decline is a payment refusal (and,
 * since the charging step is the one that failed, nothing was charged for it). Anything
 * else (network, Stripe outage) is the provider being unreachable, with no claim about
 * charges.
 */
export function classifyStorageAddonFailure(error: unknown): { declined: boolean; message: string } {
  if (error instanceof Stripe.errors.StripeError && error.type === 'StripeCardError') {
    return { declined: true, message: error.message || 'Your card was declined. Update your payment method and try again.' };
  }
  return { declined: false, message: 'We could not reach the payment provider. Try again in a moment.' };
}

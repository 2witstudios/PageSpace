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

/** A user-facing reason for a refused storage write. */
export function storageAddonFailureMessage(error: unknown): string {
  if (error instanceof Stripe.errors.StripeError && error.type === 'StripeCardError') {
    return error.message || 'Your card was declined. Update your payment method and try again.';
  }
  return 'The storage change could not be completed. Nothing was charged.';
}

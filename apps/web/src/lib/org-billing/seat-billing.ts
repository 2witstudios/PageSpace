/**
 * The Stripe side of seat accounting (Spec SEAT-4, SEAT-5): the two operations
 * @pagespace/lib/organizations/seat-service needs, over the app's Stripe client. The
 * idempotency key is derived in the service (org + operation + item + revision + quantity +
 * proration, planSeatQuantitySync) and passed straight through to Stripe here.
 */
import type Stripe from 'stripe';
import { stripe as appStripe } from '@/lib/stripe';
import type { SeatBillingPort } from '@pagespace/lib/organizations/seat-service';

export function stripeSeatBilling(client: Stripe): SeatBillingPort {
  return {
    async setSeatQuantity(params, idempotencyKey) {
      const item = await client.subscriptionItems.update(
        params.itemId,
        { quantity: params.quantity, proration_behavior: params.prorationBehavior },
        { idempotencyKey },
      );
      return { quantity: item.quantity ?? 0 };
    },
    async readSeatQuantity(itemId) {
      const item = await client.subscriptionItems.retrieve(itemId);
      return item.quantity ?? 0;
    },
  };
}

/** Production wiring. The app client is a lazy proxy: no key is read until the first real call. */
export const defaultSeatBilling = (): SeatBillingPort => stripeSeatBilling(appStripe);

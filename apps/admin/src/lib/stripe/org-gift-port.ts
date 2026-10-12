import type { OrgGiftStripe } from '@pagespace/lib/billing/org-gift';
import { stripe } from './client';

/** The admin app's Stripe client as the org-gift shell's port (SEAT-8). */
export function orgGiftStripe(): OrgGiftStripe {
  return {
    async createCoupon(params, idempotencyKey) {
      const coupon = await stripe.coupons.create(params, { idempotencyKey });
      return { id: coupon.id };
    },
    async updateSubscription(subscriptionId, params, idempotencyKey) {
      const sub = await stripe.subscriptions.update(subscriptionId, params, { idempotencyKey });
      return { id: sub.id, status: sub.status };
    },
  };
}

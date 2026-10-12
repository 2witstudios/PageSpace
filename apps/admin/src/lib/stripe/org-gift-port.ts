import type { OrgGiftStripe } from '@pagespace/lib/billing/org-gift';
import { Stripe, stripe } from './client';

/** The admin app's Stripe client as the org-gift shell's port (SEAT-8, D-OW-54). */
export function orgGiftStripe(): OrgGiftStripe {
  return {
    async retrieveCoupon(id) {
      try {
        const coupon = await stripe.coupons.retrieve(id);
        return { id: coupon.id };
      } catch (error) {
        if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') return null;
        throw error;
      }
    },
    async createCoupon(params, idempotencyKey) {
      const coupon = await stripe.coupons.create(params, { idempotencyKey });
      return { id: coupon.id };
    },
    async listOpenInvoiceIds(subscriptionId) {
      const ids: string[] = [];
      for await (const invoice of stripe.invoices.list({ subscription: subscriptionId, status: 'open', limit: 100 })) {
        if (invoice.id) ids.push(invoice.id);
      }
      return ids;
    },
    async voidInvoice(invoiceId, idempotencyKey) {
      await stripe.invoices.voidInvoice(invoiceId, {}, { idempotencyKey });
    },
    async setSeatQuantity({ itemId, quantity, prorationBehavior }, idempotencyKey) {
      const item = await stripe.subscriptionItems.update(itemId, { quantity, proration_behavior: prorationBehavior }, { idempotencyKey });
      return { quantity: item.quantity ?? quantity };
    },
    async updateSubscription(subscriptionId, params, idempotencyKey) {
      const sub = await stripe.subscriptions.update(subscriptionId, params, { idempotencyKey });
      return { id: sub.id, status: sub.status };
    },
  };
}

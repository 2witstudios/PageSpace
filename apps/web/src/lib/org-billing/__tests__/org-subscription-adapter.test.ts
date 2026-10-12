// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { stripeOrgBilling } from '../org-subscription';
import { planOrgSubscriptionPriceMirror } from '@pagespace/lib/billing/org-webhook-core';

describe('Stripe org subscription adapter', () => {
  it('preserves pagination evidence so a valid-looking first page cannot authorize Business', async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: 'sub_org', customer: 'cus_org', status: 'active', created: 1,
      metadata: {}, cancel_at_period_end: false,
      items: { has_more: true, data: [
        { id: 'si_base', price: { id: 'price_base' }, quantity: 1 },
        { id: 'si_seat', price: { id: 'price_seat' }, quantity: 0 },
      ] },
    });
    const client = { subscriptions: { retrieve } } as unknown as Stripe;
    const subscription = await stripeOrgBilling(client).retrieveSubscription('sub_org');
    const mirror = planOrgSubscriptionPriceMirror({
      stored: { stripeBaseItemId: 'si_base', stripeSeatItemId: 'si_seat', extraSeatQuantity: 0, seatRevision: 0 },
      subscription,
      prices: { basePriceId: 'price_base', seatPriceId: 'price_seat' },
    });
    expect(mirror).toEqual({ status: 'unverified_price', stripeBasePriceId: '', stripeSeatPriceId: '' });
  });
});

// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { stripeOrgBilling } from '../org-subscription';
import { planOrgSubscriptionPriceMirror } from '@pagespace/lib/billing/org-webhook-core';

vi.mock('@/lib/stripe-config', () => ({
  stripeConfig: { portalConfigurationIds: { personal: 'bpc_personal_test', organization: 'bpc_org_test' } },
}));

describe('Stripe org subscription adapter', () => {
  it('binds the organization portal to its customer and explicit organization configuration', async () => {
    const create = vi.fn().mockResolvedValue({ url: 'https://billing.stripe.com/session/test' });
    const client = { billingPortal: { sessions: { create } } } as unknown as Stripe;
    await stripeOrgBilling(client).createBillingPortalSession('cus_org', 'https://app.test/org');
    expect(create).toHaveBeenCalledWith({
      customer: 'cus_org', return_url: 'https://app.test/org', configuration: 'bpc_org_test',
    });
  });

  it('D-OW-44 maps collection_method, so a send_invoice subscription is never read as automatically collected', async () => {
    const retrieve = vi.fn().mockResolvedValue({
      id: 'sub_org', customer: 'cus_org', status: 'active', created: 1, collection_method: 'send_invoice',
      metadata: {}, cancel_at_period_end: false,
      items: { has_more: false, data: [
        { id: 'si_base', price: { id: 'price_base' }, quantity: 1 },
        { id: 'si_seat', price: { id: 'price_seat' }, quantity: 0 },
      ] },
    });
    const client = { subscriptions: { retrieve } } as unknown as Stripe;
    expect((await stripeOrgBilling(client).retrieveSubscription('sub_org')).collectionMethod).toBe('send_invoice');
  });

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

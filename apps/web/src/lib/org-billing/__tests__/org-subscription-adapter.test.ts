// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { stripeOrgBilling } from '../org-subscription';
import { planOrgSubscriptionPriceMirror } from '@pagespace/lib/billing/org-webhook-core';

describe('Stripe org subscription adapter', () => {
  const prices = { basePriceId: 'price_base', seatPriceId: 'price_seat' };
  const subscription = (status: string) => ({
    id: 'sub_org', customer: 'cus_org', status, created: 1, metadata: {}, cancel_at_period_end: false,
    items: { has_more: false, data: [{ id: 'si_base', price: { id: 'price_base' }, quantity: 1 }, { id: 'si_seat', price: { id: 'price_seat' }, quantity: 0 }] },
    latest_invoice: null, collection_method: 'charge_automatically',
  });
  it.each(['trialing', 'paused'])('rejects invoice-sent %s recovery before generating a payable invoice', async (status) => {
    const update = vi.fn().mockResolvedValue(subscription('active'));
    const resume = vi.fn().mockResolvedValue(subscription('active'));
    const retrieve = vi.fn().mockResolvedValue({ ...subscription(status), collection_method: 'send_invoice' });
    const client = { subscriptions: { retrieve, update, resume } } as unknown as Stripe;
    await expect(stripeOrgBilling(client).recoverSubscription('sub_org', prices, 'recovery')).rejects.toThrow('automatic collection');
    expect(update).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
  it('preserves a trial that Stripe now reports as active', async () => {
    const cancel = vi.fn();
    const client = { subscriptions: { retrieve: vi.fn().mockResolvedValue(subscription('active')), cancel } } as unknown as Stripe;
    expect((await stripeOrgBilling(client).recoverSubscription('sub_org', prices, 'recovery')).status).toBe('active');
    expect(cancel).not.toHaveBeenCalled();
  });
  it('ends an unsupported trial in place even if payment completes between retrieve and update', async () => {
    const cancel = vi.fn();
    const update = vi.fn().mockResolvedValue(subscription('active'));
    const client = { subscriptions: { retrieve: vi.fn().mockResolvedValue(subscription('trialing')), update, cancel } } as unknown as Stripe;
    expect((await stripeOrgBilling(client).recoverSubscription('sub_org', prices, 'recovery')).id).toBe('sub_org');
    expect(update).toHaveBeenCalledWith('sub_org', { trial_end: 'now', payment_behavior: 'default_incomplete', proration_behavior: 'none', trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' } } }, { idempotencyKey: 'recovery:end-trial' });
    expect(cancel).not.toHaveBeenCalled();
  });
  it('preserves concurrent payment when Stripe refuses to resume a now-active subscription', async () => {
    const cancel = vi.fn();
    const resume = vi.fn().mockRejectedValue(new Error('Subscription is not paused'));
    const retrieve = vi.fn().mockResolvedValueOnce(subscription('paused')).mockResolvedValueOnce(subscription('active'));
    const client = { subscriptions: { retrieve, resume, cancel } } as unknown as Stripe;
    expect((await stripeOrgBilling(client).recoverSubscription('sub_org', prices, 'recovery')).status).toBe('active');
    expect(cancel).not.toHaveBeenCalled();
  });
  it('reuses an open paused resumption invoice instead of resuming and invoicing again', async () => {
    const resume = vi.fn();
    const retrieve = vi.fn().mockResolvedValue({ ...subscription('paused'), latest_invoice: { id: 'in_open', status: 'open', amount_due: 5000 } });
    const client = { subscriptions: { retrieve, resume } } as unknown as Stripe;
    expect((await stripeOrgBilling(client).recoverSubscription('sub_org', prices, 'recovery')).status).toBe('paused');
    expect(resume).not.toHaveBeenCalled();
  });
  it('resumes a paused subscription with a new invoice after the previous invoice was voided', async () => {
    const resume = vi.fn().mockResolvedValue(subscription('paused'));
    const retrieve = vi.fn().mockResolvedValue({ ...subscription('paused'), latest_invoice: { id: 'in_void', status: 'void', amount_due: 5000 } });
    const client = { subscriptions: { retrieve, resume } } as unknown as Stripe;
    await stripeOrgBilling(client).recoverSubscription('sub_org', prices, 'recovery');
    expect(resume).toHaveBeenCalledWith('sub_org', { billing_cycle_anchor: 'now', proration_behavior: 'none' }, { idempotencyKey: 'recovery:resume:in_void' });
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

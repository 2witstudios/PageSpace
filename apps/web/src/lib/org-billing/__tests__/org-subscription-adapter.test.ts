// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { stripeOrgBilling } from '../org-subscription';
import { planOrgSubscriptionPriceMirror } from '@pagespace/lib/billing/org-webhook-core';

describe('Stripe org subscription adapter', () => {
  const prices = { basePriceId: 'price_base', seatPriceId: 'price_seat', extraSeatQuantity: 0 };
  const subscription = (status: string) => ({
    id: 'sub_org', customer: 'cus_org', status, created: 1, metadata: {}, cancel_at_period_end: false,
    items: { has_more: false, data: [{ id: 'si_base', price: { id: 'price_base' }, quantity: 1 }, { id: 'si_seat', price: { id: 'price_seat' }, quantity: 0 }] },
    latest_invoice: null, collection_method: 'charge_automatically',
  });
  it.each([['trialing', false], ['trialing', true], ['paused', false], ['paused', true]] as const)('reconciles %s seats before the invoice (missing=%s)', async (status, missing) => {
    const current = subscription(status);
    if (missing) current.items.data = current.items.data.slice(0, 1);
    const order: string[] = [];
    const create = vi.fn(async () => { order.push('seats'); return { id: 'si_seat', quantity: 3 }; });
    const updateItem = vi.fn(async () => { order.push('seats'); return { id: 'si_seat', quantity: 3 }; });
    const update = vi.fn(async () => { order.push('invoice'); return subscription('past_due'); });
    const resume = vi.fn(async () => { order.push('invoice'); return subscription('paused'); });
    const reconciled = subscription(status);
    reconciled.items.data[1].quantity = 3;
    const client = { subscriptions: { retrieve: vi.fn().mockResolvedValueOnce(current).mockResolvedValue(reconciled), update, resume },
      subscriptionItems: { create, update: updateItem },
    } as unknown as Stripe;
    await stripeOrgBilling(client).recoverSubscription('sub_org', { ...prices, extraSeatQuantity: 3 }, 'recovery');
    expect(order).toEqual(['seats', 'invoice']);
    if (missing) expect(create).toHaveBeenCalledWith({ subscription: 'sub_org', price: 'price_seat', quantity: 3, proration_behavior: 'none' }, expect.anything());
    else expect(updateItem).toHaveBeenCalledWith('si_seat', { quantity: 3, proration_behavior: 'none' }, expect.anything());
  });

  it('refuses to generate an invoice when an idempotent seat response did not reconcile the current subscription', async () => {
    const current = subscription('trialing');
    const update = vi.fn();
    const updateItem = vi.fn().mockResolvedValue({ id: 'si_seat', quantity: 3 });
    const client = { subscriptions: { retrieve: vi.fn().mockResolvedValue(current), update }, subscriptionItems: { update: updateItem } } as unknown as Stripe;
    await expect(stripeOrgBilling(client).recoverSubscription('sub_org', { ...prices, extraSeatQuantity: 3 }, 'recovery')).rejects.toThrow('seats changed');
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a paused open invoice if its seat quantity no longer matches the organization', async () => {
    const current = { ...subscription('paused'), latest_invoice: { id: 'in_open', status: 'open', amount_due: 5000 } };
    const resume = vi.fn();
    const updateItem = vi.fn();
    const client = { subscriptions: { retrieve: vi.fn().mockResolvedValue(current), resume }, subscriptionItems: { update: updateItem } } as unknown as Stripe;
    await expect(stripeOrgBilling(client).recoverSubscription('sub_org', { ...prices, extraSeatQuantity: 3 }, 'recovery')).rejects.toThrow('open invoice');
    expect(resume).not.toHaveBeenCalled();
    expect(updateItem).not.toHaveBeenCalled();
  });

  it('rejects an invoice-sent trial that transitioned to active before the recovery read', async () => {
    const current = { ...subscription('active'), collection_method: 'send_invoice' };
    const update = vi.fn();
    const client = { subscriptions: { retrieve: vi.fn().mockResolvedValue(current), update } } as unknown as Stripe;
    await expect(stripeOrgBilling(client).recoverSubscription('sub_org', prices, 'recovery')).rejects.toThrow('automatic collection');
    expect(update).not.toHaveBeenCalled();
  });

  it('does not accept invoice-sent active status while reconciling a failed resume', async () => {
    const resume = vi.fn().mockRejectedValue(new Error('resume failed'));
    const retrieve = vi.fn().mockResolvedValueOnce(subscription('paused')).mockResolvedValueOnce({ ...subscription('active'), collection_method: 'send_invoice' });
    const client = { subscriptions: { retrieve, resume } } as unknown as Stripe;
    await expect(stripeOrgBilling(client).recoverSubscription('sub_org', prices, 'recovery')).rejects.toThrow('resume failed');
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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { stripeConfig, stripeMode } from '../../apps/web/src/lib/stripe-config';

const testKey = process.env.STRIPE_TEST_SECRET_KEY;
const customers: string[] = [];
const products: string[] = [];
const coupons: string[] = [];
let stripe: Stripe;

describe.skipIf(!testKey)('gifted personal Business to Pro against Stripe TEST', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    expect(testKey).toMatch(/^sk_test_/);
    expect(stripeMode).toBe('test');
    stripe = new Stripe(testKey!, { apiVersion: '2026-02-25.clover' });
    expect((await stripe.accounts.retrieve()).id).toBe('acct_1S2LlQPRnBcvXFso');
    const price = await stripe.prices.retrieve(stripeConfig.priceIds.pro);
    expect(price).toMatchObject({ livemode: false, active: true, unit_amount: 1500, currency: 'usd' });
  });

  afterAll(async () => {
    if (!stripe) return;
    for (const id of customers) await stripe.customers.del(id);
    for (const id of coupons) await stripe.coupons.del(id);
    for (const id of products) await stripe.products.update(id, { active: false });
  });

  it('preserves the subscription, anchor and exhausted 100% discount with a zero-charge preview and no proration', async () => {
    const product = await stripe.products.create({ name: 'Cutover rehearsal retired personal Business' });
    products.push(product.id);
    const businessPrice = await stripe.prices.create({ product: product.id, unit_amount: 10000, currency: 'usd', recurring: { interval: 'month' } });
    const coupon = await stripe.coupons.create({ percent_off: 100, duration: 'forever', max_redemptions: 1 });
    coupons.push(coupon.id);
    const customer = await stripe.customers.create({ metadata: { cutover_rehearsal: 'org-wallets' } });
    customers.push(customer.id);
    const before = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: businessPrice.id }], discounts: [{ coupon: coupon.id }] });
    expect(before).toMatchObject({ status: 'active', livemode: false });
    expect(await stripe.coupons.retrieve(coupon.id)).toMatchObject({ times_redeemed: 1, valid: false });
    const item = before.items.data[0];
    const items = [{ id: item.id, price: stripeConfig.priceIds.pro, quantity: 1 }];
    // Omit discounts: preserve the existing discount, never redeem the exhausted coupon again.
    const preview = await stripe.invoices.createPreview({ customer: customer.id, subscription: before.id, subscription_details: { items, proration_behavior: 'none' } });
    expect(preview).toMatchObject({ amount_due: 0, total: 0 });
    const after = await stripe.subscriptions.update(before.id, { items, proration_behavior: 'none', billing_cycle_anchor: 'unchanged' });
    expect(after).toMatchObject({ id: before.id, status: 'active', billing_cycle_anchor: before.billing_cycle_anchor, discounts: before.discounts, latest_invoice: before.latest_invoice });
    expect(after.items.data[0]).toMatchObject({ id: item.id, quantity: 1, price: { id: stripeConfig.priceIds.pro }, current_period_start: item.current_period_start, current_period_end: item.current_period_end });
    expect(await stripe.coupons.retrieve(coupon.id)).toMatchObject({ times_redeemed: 1, valid: false });
    const portal = await stripe.billingPortal.sessions.create({ customer: customer.id, configuration: stripeConfig.portalConfigurationIds.personal, return_url: 'https://app.pagespace.test/settings/billing' });
    expect(portal).toMatchObject({ customer: customer.id, configuration: stripeConfig.portalConfigurationIds.personal, livemode: false });
  });
});

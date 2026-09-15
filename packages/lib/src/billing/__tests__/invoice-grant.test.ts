import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { grantForInvoice, grantForInvoiceLines } from '../invoice-grant';
import { INCLUDED_CREDIT_RATIO_BPS, allowanceCentsForPaidCents, tierListPriceCents } from '../money-model';
import { TIERS, TIER_PLAN_LIMITS } from '../subscription-tiers';

// A1's money-model gates the RATIO on MONEY_MODEL_V2 (off = 100% of paid, today's
// amounts). These tests exercise the derived model, so the flag is on throughout;
// the flag-off path is covered by money-model.test.ts and credit-funding.test.ts.
beforeEach(() => { process.env.MONEY_MODEL_V2 = 'true'; });
afterEach(() => { delete process.env.MONEY_MODEL_V2; });

const ratio = (tier: keyof typeof INCLUDED_CREDIT_RATIO_BPS, cents: number) =>
  Math.floor((cents * INCLUDED_CREDIT_RATIO_BPS[tier]) / 10_000);

describe('invoice-grant derives every grant through allowanceCentsForPaidCents', () => {
  it('MON-2 derives the allowance for EVERY tier as paidCents × ratio, never from a table', () => {
    for (const tier of TIERS) {
      const listCents = TIER_PLAN_LIMITS[tier].priceMonthlyUsd * 100;
      expect(grantForInvoice({ amountPaidCents: listCents, tier }).allowanceCents).toBe(ratio(tier, listCents));
      expect(grantForInvoice({ amountPaidCents: listCents, tier }).allowanceCents).toBe(allowanceCentsForPaidCents(listCents, tier));
    }
  });

  it('MON-2 Pro at list price ($15) includes 900 credits of value (A-11)', () => {
    expect(grantForInvoice({ amountPaidCents: 1500, tier: 'pro' }).allowanceCents).toBe(900);
  });

  it('MON-8 the free tier has no ratio: a paid amount on free grants nothing here', () => {
    expect(grantForInvoice({ amountPaidCents: 1500, tier: 'free' }).allowanceCents).toBe(0);
  });
});

describe('grantForInvoice (personal subscriptions)', () => {
  it('MON-2 sizes the grant from what the invoice paid and records paidCents', () => {
    expect(grantForInvoice({ amountPaidCents: 1500, tier: 'pro' })).toEqual({
      paidCents: 1500,
      allowanceCents: ratio('pro', 1500),
      basis: 'paid',
      reason: 'paid',
    });
  });

  it('MON-2 a 50%-off invoice grants exactly half the list grant', () => {
    const full = grantForInvoice({ amountPaidCents: 1500, tier: 'pro' });
    const half = grantForInvoice({ amountPaidCents: 750, tier: 'pro' });
    expect(half.allowanceCents).toBe(full.allowanceCents / 2);
    expect(half.paidCents).toBe(750);
  });

  it('MON-2 a zero-amount invoice grants nothing', () => {
    expect(grantForInvoice({ amountPaidCents: 0, tier: 'pro' })).toMatchObject({ paidCents: 0, allowanceCents: 0, basis: 'none' });
  });

  it('MON-2 a missing or negative amount_paid grants nothing (fails closed)', () => {
    expect(grantForInvoice({ amountPaidCents: undefined, tier: 'pro' }).allowanceCents).toBe(0);
    expect(grantForInvoice({ amountPaidCents: null, tier: 'business' }).allowanceCents).toBe(0);
    expect(grantForInvoice({ amountPaidCents: -500, tier: 'business' })).toMatchObject({ paidCents: 0, allowanceCents: 0, basis: 'none' });
  });
});

describe('grantForInvoice — D-OW-16: entitlement follows amount paid except grants we fund', () => {
  const list = () => allowanceCentsForPaidCents(tierListPriceCents('pro'), 'pro');

  it('MON-2 (a) a gifted subscription grants list price × ratio, records paidCents 0, basis list', () => {
    expect(grantForInvoice({ amountPaidCents: 0, subtotalCents: 1500, billingReason: 'subscription_cycle', gifted: true, tier: 'pro' }))
      .toEqual({ paidCents: 0, allowanceCents: list(), basis: 'list', reason: 'gifted' });
    expect(list()).toBe(900);
  });

  it('MON-2 (a) a subscription created with a trial (subscription_create, paid 0, subtotal 0) grants list price × ratio', () => {
    expect(grantForInvoice({ amountPaidCents: 0, subtotalCents: 0, billingReason: 'subscription_create', gifted: false, tier: 'pro' }))
      .toEqual({ paidCents: 0, allowanceCents: list(), basis: 'list', reason: 'trial' });
  });

  it('MON-2 (b) a proration-only or subscription_update invoice that paid 0 grants nothing', () => {
    expect(grantForInvoice({ amountPaidCents: 0, subtotalCents: 0, billingReason: 'subscription_update', tier: 'pro' }))
      .toEqual({ paidCents: 0, allowanceCents: 0, basis: 'none', reason: 'zero_amount' });
    expect(grantForInvoice({ amountPaidCents: 0, subtotalCents: 300, billingReason: 'subscription_update', tier: 'pro' }).allowanceCents).toBe(0);
  });

  it('MON-2 (c) a partial discount grants from amount_paid: 50% off → half, 20% off → 720', () => {
    expect(grantForInvoice({ amountPaidCents: 750, subtotalCents: 1500, billingReason: 'subscription_cycle', tier: 'pro' }))
      .toEqual({ paidCents: 750, allowanceCents: list() / 2, basis: 'paid', reason: 'paid' });
    expect(grantForInvoice({ amountPaidCents: 1200, subtotalCents: 1500, billingReason: 'subscription_cycle', tier: 'pro' }).allowanceCents).toBe(720);
  });

  it('MON-2 (d) a 100% coupon on a non-gifted subscription grants nothing, even on subscription_create', () => {
    // subtotal is the list price, paid 0: a coupon, not a trial.
    expect(grantForInvoice({ amountPaidCents: 0, subtotalCents: 1500, billingReason: 'subscription_create', gifted: false, tier: 'pro' }))
      .toEqual({ paidCents: 0, allowanceCents: 0, basis: 'none', reason: 'zero_amount' });
  });

  it('MON-2 a paid invoice whose tier has no ratio is a missed grant (reason no_ratio), never silently zero_amount', () => {
    expect(grantForInvoice({ amountPaidCents: 1500, tier: 'free' }))
      .toEqual({ paidCents: 1500, allowanceCents: 0, basis: 'none', reason: 'no_ratio' });
  });

  it('MON-2 a gift on a tier with no ratio funds nothing (no list price to derive from)', () => {
    expect(grantForInvoice({ amountPaidCents: 0, gifted: true, tier: 'free' }).allowanceCents).toBe(0);
  });
});

describe('grantForInvoiceLines (org subscriptions seam, Phase 3)', () => {
  it('MON-3 sums the Business base and extra-seat line items before applying the ratio', () => {
    // Northwind Labs: Business base ($50) + 10 extra seats at $10 = $150 paid.
    const lines = [{ amount: 5000 }, { amount: 10 * 1000 }];
    const grant = grantForInvoiceLines(lines, 'business');
    expect(grant.paidCents).toBe(15_000);
    expect(grant.allowanceCents).toBe(ratio('business', 15_000));
    // More seats means a bigger pool without a second constant.
    expect(grant.allowanceCents).toBeGreaterThan(grantForInvoiceLines([{ amount: 5000 }], 'business').allowanceCents);
  });

  it('MON-3 proration lines sum correctly: a negative unused-time credit nets against the new charge', () => {
    // Mid-period seat add: +$30 remaining-time charge for 3 seats, −$10 credit for unused time.
    const lines = [{ amount: 3000 }, { amount: -1000 }];
    expect(grantForInvoiceLines(lines, 'business')).toMatchObject({
      paidCents: 2000,
      allowanceCents: ratio('business', 2000),
      basis: 'paid',
    });
  });

  it('MON-3 a net-negative or empty line set grants nothing and never goes below zero', () => {
    expect(grantForInvoiceLines([{ amount: -500 }], 'business')).toMatchObject({ paidCents: 0, allowanceCents: 0, basis: 'none' });
    expect(grantForInvoiceLines([], 'business')).toMatchObject({ paidCents: 0, allowanceCents: 0, basis: 'none' });
  });

  it('MON-3 ignores lines with a missing or non-numeric amount instead of poisoning the sum', () => {
    const lines = [{ amount: 5000 }, { amount: null }, undefined, { amount: Number.NaN }];
    expect(grantForInvoiceLines(lines, 'business').paidCents).toBe(5000);
  });

  it('MON-2/MON-3 the org seam and the personal path apply the SAME ratio to the same paid amount', () => {
    expect(grantForInvoiceLines([{ amount: 1500 }], 'pro')).toEqual(grantForInvoice({ amountPaidCents: 1500, tier: 'pro' }));
  });
});

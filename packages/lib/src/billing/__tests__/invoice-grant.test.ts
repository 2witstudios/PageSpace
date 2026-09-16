import { describe, it, expect } from 'vitest';
import { grantForInvoice, grantForInvoiceLines } from '../invoice-grant';
import { INCLUDED_CREDIT_RATIO_BPS, allowanceCentsForPaidCents, tierListPriceCents } from '../money-model';
import { TIERS, TIER_PLAN_LIMITS } from '../subscription-tiers';

// D-OW-17: the ratio switch is a code constant (MONEY_MODEL_V2_ACTIVE), not an env
// var. These tests exercise the DERIVED (ratio-on) model, so every call below passes
// `active: true` explicitly to grantForInvoice/grantForInvoiceLines — never by
// mutating process.env.MONEY_MODEL_V2, which the money-model module no longer reads
// at all. The active=false (legacy 1:1, today's real production behavior while the
// constant is FALSE) path is covered by the last describe block in this file, by
// money-model.test.ts, and by credit-funding.test.ts.

const ratio = (tier: keyof typeof INCLUDED_CREDIT_RATIO_BPS, cents: number) =>
  Math.floor((cents * INCLUDED_CREDIT_RATIO_BPS[tier]) / 10_000);

describe('invoice-grant derives every grant through allowanceCentsForPaidCents', () => {
  it('MON-2 derives the allowance for EVERY tier as paidCents × ratio, never from a table', () => {
    for (const tier of TIERS) {
      const listCents = TIER_PLAN_LIMITS[tier].priceMonthlyUsd * 100;
      const input = { amountPaidCents: listCents, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier };
      expect(grantForInvoice(input, true).allowanceCents).toBe(ratio(tier, listCents));
      expect(grantForInvoice(input, true).allowanceCents).toBe(allowanceCentsForPaidCents(listCents, tier, true));
    }
  });

  it('MON-2 Pro at list price ($15) includes 900 credits of value (A-11)', () => {
    expect(grantForInvoice({ amountPaidCents: 1500, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'pro' }, true).allowanceCents).toBe(900);
  });

  it('MON-8 the free tier has no ratio: a paid amount on free grants nothing here', () => {
    expect(grantForInvoice({ amountPaidCents: 1500, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'free' }, true).allowanceCents).toBe(0);
  });
});

describe('grantForInvoice (personal subscriptions)', () => {
  it('MON-2 sizes the grant from what the invoice paid and records paidCents', () => {
    expect(grantForInvoice({ amountPaidCents: 1500, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'pro' }, true)).toEqual({
      paidCents: 1500,
      allowanceCents: ratio('pro', 1500),
      basis: 'paid',
      reason: 'paid',
    });
  });

  it('MON-2 a 50%-off invoice grants exactly half the list grant', () => {
    const full = grantForInvoice({ amountPaidCents: 1500, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'pro' }, true);
    const half = grantForInvoice({ amountPaidCents: 750, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'pro' }, true);
    expect(half.allowanceCents).toBe(full.allowanceCents / 2);
    expect(half.paidCents).toBe(750);
  });

  it('MON-2 a zero-amount invoice grants nothing', () => {
    expect(grantForInvoice({ amountPaidCents: 0, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'pro' }, true)).toMatchObject({ paidCents: 0, allowanceCents: 0, basis: 'none' });
  });

  it('MON-2 a missing or negative amount_paid grants nothing (fails closed)', () => {
    expect(grantForInvoice({ amountPaidCents: undefined, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'pro' }, true).allowanceCents).toBe(0);
    expect(grantForInvoice({ amountPaidCents: null, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'business' }, true).allowanceCents).toBe(0);
    expect(grantForInvoice({ amountPaidCents: -500, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'business' }, true)).toMatchObject({ paidCents: 0, allowanceCents: 0, basis: 'none' });
  });
});

describe('grantForInvoice — D-OW-16: entitlement follows amount paid except grants we fund', () => {
  const list = () => allowanceCentsForPaidCents(tierListPriceCents('pro'), 'pro', true);

  it('MON-2 (a) a gifted subscription grants list price × ratio, records paidCents 0, basis list', () => {
    expect(grantForInvoice({ amountPaidCents: 0, subtotalCents: 1500, billingReason: 'subscription_cycle', hasSubscriptionParent: true, gifted: true, tier: 'pro' }, true))
      .toEqual({ paidCents: 0, allowanceCents: list(), basis: 'list', reason: 'gifted' });
    expect(list()).toBe(900);
  });

  it('MON-2 (a) a subscription created with a trial (subscription_create, paid 0, subtotal 0) grants list price × ratio', () => {
    expect(grantForInvoice({ amountPaidCents: 0, subtotalCents: 0, billingReason: 'subscription_create', hasSubscriptionParent: true, gifted: false, tier: 'pro' }, true))
      .toEqual({ paidCents: 0, allowanceCents: list(), basis: 'list', reason: 'trial' });
  });

  it('MON-2 (b) a proration-only or subscription_update invoice that paid 0 grants nothing (subscription_update is grant-eligible as a KIND, but $0 paid is $0 granted, via the ordinary zero_amount path)', () => {
    expect(grantForInvoice({ amountPaidCents: 0, subtotalCents: 0, billingReason: 'subscription_update', hasSubscriptionParent: true, tier: 'pro' }, true))
      .toEqual({ paidCents: 0, allowanceCents: 0, basis: 'none', reason: 'zero_amount' });
    expect(grantForInvoice({ amountPaidCents: 0, subtotalCents: 300, billingReason: 'subscription_update', hasSubscriptionParent: true, tier: 'pro' }, true).allowanceCents).toBe(0);
  });

  it('MON-2 (c) a partial discount grants from amount_paid: 50% off → half, 20% off → 720', () => {
    expect(grantForInvoice({ amountPaidCents: 750, subtotalCents: 1500, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'pro' }, true))
      .toEqual({ paidCents: 750, allowanceCents: list() / 2, basis: 'paid', reason: 'paid' });
    expect(grantForInvoice({ amountPaidCents: 1200, subtotalCents: 1500, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'pro' }, true).allowanceCents).toBe(720);
  });

  it('MON-2 (d) a 100% coupon on a non-gifted subscription grants nothing, even on subscription_create', () => {
    // subtotal is the list price, paid 0: a coupon, not a trial.
    expect(grantForInvoice({ amountPaidCents: 0, subtotalCents: 1500, billingReason: 'subscription_create', hasSubscriptionParent: true, gifted: false, tier: 'pro' }, true))
      .toEqual({ paidCents: 0, allowanceCents: 0, basis: 'none', reason: 'zero_amount' });
  });

  it('MON-2 a paid invoice whose tier has no ratio is a missed grant (reason no_ratio), never silently zero_amount', () => {
    expect(grantForInvoice({ amountPaidCents: 1500, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'free' }, true))
      .toEqual({ paidCents: 1500, allowanceCents: 0, basis: 'none', reason: 'no_ratio' });
  });

  it('MON-2 a gift on a tier with no ratio funds nothing (no list price to derive from)', () => {
    expect(grantForInvoice({ amountPaidCents: 0, billingReason: 'subscription_cycle', hasSubscriptionParent: true, gifted: true, tier: 'free' }, true).allowanceCents).toBe(0);
  });
});

describe('SECURITY (Codex P1, thread "Restrict derived grants to account-plan invoices"): only invoices with a real subscription parent may grant', () => {
  it('a manual/parentless invoice for an existing paid user grants NOTHING even for a large payment — reproduces the exact defect: routeInvoice classifies a parentless invoice as account_plan, and nothing downstream checked for a subscription parent before deriving a grant from amount_paid', () => {
    // The exact scenario Codex named: a $1,000 manual invoice on a Business
    // subscriber must not mint $600 of AI credit. hasSubscriptionParent is
    // omitted — exactly what a manual invoice's absent invoice.parent produces.
    const result = grantForInvoice({ amountPaidCents: 100_000, billingReason: 'manual', tier: 'business' }, true);
    expect(result).toMatchObject({ allowanceCents: 0, basis: 'none', reason: 'not_a_subscription_invoice' });
  });

  it('billing_reason alone never grants — only hasSubscriptionParent does; a "subscription_cycle" claim on an invoice with no subscription parent still grants nothing (fails closed on the STRUCTURAL fact, not a caller-supplied label)', () => {
    expect(grantForInvoice({ amountPaidCents: 100_000, billingReason: 'subscription_cycle', hasSubscriptionParent: false, tier: 'business' }, true).allowanceCents).toBe(0);
  });

  it('once an invoice has a real subscription parent, subscription_cycle, subscription_create, and subscription_update all grant — nothing else does', () => {
    for (const reason of ['subscription_cycle', 'subscription_create', 'subscription_update']) {
      expect(grantForInvoice({ amountPaidCents: 100_000, billingReason: reason, hasSubscriptionParent: true, tier: 'business' }, true).allowanceCents).toBeGreaterThan(0);
    }
  });

  it('a gifted subscription is still restricted to a real subscription invoice: a manual invoice on a gifted account grants nothing even with gifted: true', () => {
    const result = grantForInvoice({ amountPaidCents: 0, subtotalCents: 5000, billingReason: 'manual', gifted: true, tier: 'business' }, true);
    expect(result.allowanceCents).toBe(0);
  });

  it('CORRECTION (Codex P1 ruling, "Allow paid subscription-update invoices to grant credits"): a PAID subscription_update invoice with a real subscription parent — a mid-cycle upgrade proration (update-subscription/route.ts, proration_behavior: always_invoice) — grants proportional credits, discriminated from a manual invoice by subscription-parent PRESENCE, not by billing_reason', () => {
    // A $10 mid-cycle proration charge on an upgrade.
    const result = grantForInvoice({ amountPaidCents: 1000, billingReason: 'subscription_update', hasSubscriptionParent: true, tier: 'business' }, true);
    expect(result.allowanceCents).toBeGreaterThan(0);
    expect(result).toMatchObject({ basis: 'paid', reason: 'paid' });
  });
});

describe('grantForInvoiceLines (org subscriptions seam, Phase 3)', () => {
  it('MON-3 sums the Business base and extra-seat line items before applying the ratio', () => {
    // Northwind Labs: Business base ($50) + 10 extra seats at $10 = $150 paid.
    const lines = [{ amount: 5000 }, { amount: 10 * 1000 }];
    const grant = grantForInvoiceLines(lines, 'business', true);
    expect(grant.paidCents).toBe(15_000);
    expect(grant.allowanceCents).toBe(ratio('business', 15_000));
    // More seats means a bigger pool without a second constant.
    expect(grant.allowanceCents).toBeGreaterThan(grantForInvoiceLines([{ amount: 5000 }], 'business', true).allowanceCents);
  });

  it('MON-3 proration lines sum correctly: a negative unused-time credit nets against the new charge', () => {
    // Mid-period seat add: +$30 remaining-time charge for 3 seats, −$10 credit for unused time.
    const lines = [{ amount: 3000 }, { amount: -1000 }];
    expect(grantForInvoiceLines(lines, 'business', true)).toMatchObject({
      paidCents: 2000,
      allowanceCents: ratio('business', 2000),
      basis: 'paid',
    });
  });

  it('MON-3 a net-negative or empty line set grants nothing and never goes below zero', () => {
    expect(grantForInvoiceLines([{ amount: -500 }], 'business', true)).toMatchObject({ paidCents: 0, allowanceCents: 0, basis: 'none' });
    expect(grantForInvoiceLines([], 'business', true)).toMatchObject({ paidCents: 0, allowanceCents: 0, basis: 'none' });
  });

  it('MON-3 ignores lines with a missing or non-numeric amount instead of poisoning the sum', () => {
    const lines = [{ amount: 5000 }, { amount: null }, undefined, { amount: Number.NaN }];
    expect(grantForInvoiceLines(lines, 'business', true).paidCents).toBe(5000);
  });

  it('MON-2/MON-3 the org seam and the personal path apply the SAME ratio to the same paid amount', () => {
    expect(grantForInvoiceLines([{ amount: 1500 }], 'pro', true)).toEqual(grantForInvoice({ amountPaidCents: 1500, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'pro' }, true));
  });
});

describe('D-OW-17 active=false (today\'s real production default) reproduces the legacy 1:1 amounts, with no env var involved', () => {
  it('a full-price Pro invoice grants exactly what it paid, not the 60% ratio', () => {
    const result = grantForInvoice({ amountPaidCents: 1500, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'pro' }, false);
    expect(result).toMatchObject({ paidCents: 1500, allowanceCents: 1500, basis: 'paid', reason: 'paid' });
  });

  it('grantForInvoice with no active argument at all defaults to false in this PR — production\'s actual call shape', () => {
    const explicit = grantForInvoice({ amountPaidCents: 1500, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'pro' }, false);
    const defaulted = grantForInvoice({ amountPaidCents: 1500, billingReason: 'subscription_cycle', hasSubscriptionParent: true, tier: 'pro' });
    expect(defaulted).toEqual(explicit);
  });

  it('grantForInvoiceLines with no active argument also defaults to false', () => {
    const explicit = grantForInvoiceLines([{ amount: 5000 }], 'business', false);
    const defaulted = grantForInvoiceLines([{ amount: 5000 }], 'business');
    expect(defaulted).toEqual(explicit);
  });
});

import { describe, it, expect } from 'vitest';
import {
  APPLE_PRODUCTS,
  APPLE_PRO_MONTHLY,
  APPLE_SMALL_BUSINESS_COMMISSION_BPS,
  appleProceedsCents,
  appleProduct,
  appleProductIds,
} from '../apple-products';
import { CREDIT_PACKS, centsFromCredits, creditPackPriceCents, tierListPriceCents } from '../../money-model';

describe('the App Store catalog', () => {
  it('sells personal Pro and the three credit packs, and nothing an organization buys', () => {
    expect(appleProductIds()).toEqual([
      'ai.pagespace.ios.pro.monthly',
      'ai.pagespace.ios.credits.100',
      'ai.pagespace.ios.credits.250',
      'ai.pagespace.ios.credits.500',
    ]);
    for (const product of APPLE_PRODUCTS) {
      if (product.kind === 'subscription') expect(product.tier).toBe('pro');
    }
  });

  it('values iOS Pro at the WEB list price, so its included credits match web Pro exactly', () => {
    expect(APPLE_PRO_MONTHLY.webEquivalentCents).toBe(tierListPriceCents('pro'));
  });

  it('grants each pack the same credits as its web pack, sized one-for-one in cents', () => {
    const packs = APPLE_PRODUCTS.filter((p) => p.kind === 'consumable');
    expect(packs.map((p) => p.kind === 'consumable' && p.packId)).toEqual(['pack_10', 'pack_25', 'pack_50']);
    for (const pack of packs) {
      if (pack.kind !== 'consumable') continue;
      const web = CREDIT_PACKS[pack.packId];
      expect(pack.credits).toBe(web.credits);
      expect(pack.topupCents).toBe(centsFromCredits(web.credits));
      expect(pack.webEquivalentCents).toBe(creditPackPriceCents(web));
    }
  });

  it('prices every product so that, after the Small Business Program commission, Apple pays us at least the web price', () => {
    for (const product of APPLE_PRODUCTS) {
      const proceeds = appleProceedsCents(product.appleUsdPriceCents, APPLE_SMALL_BUSINESS_COMMISSION_BPS);
      expect(proceeds).toBeGreaterThanOrEqual(product.webEquivalentCents);
    }
  });

  it('keeps the upcharge to the lowest Apple price point that covers the commission ($x.99 steps)', () => {
    for (const product of APPLE_PRODUCTS) {
      expect(product.appleUsdPriceCents % 100).toBe(99);
      const oneStepLower = product.appleUsdPriceCents - 100;
      expect(appleProceedsCents(oneStepLower, APPLE_SMALL_BUSINESS_COMMISSION_BPS)).toBeLessThan(product.webEquivalentCents);
    }
  });

  it('publishes the iOS prices the catalog was designed around', () => {
    expect(APPLE_PRODUCTS.map((p) => [p.productId, p.appleUsdPriceCents])).toEqual([
      ['ai.pagespace.ios.pro.monthly', 1799],
      ['ai.pagespace.ios.credits.100', 1199],
      ['ai.pagespace.ios.credits.250', 2999],
      ['ai.pagespace.ios.credits.500', 5899],
    ]);
  });

  it('resolves a known product id and refuses an unknown one', () => {
    expect(appleProduct('ai.pagespace.ios.credits.250')).toMatchObject({ kind: 'consumable', credits: 250 });
    expect(appleProduct('ai.pagespace.ios.founder.monthly')).toBeUndefined();
    expect(appleProduct('')).toBeUndefined();
  });
});

describe('appleProceedsCents', () => {
  it('takes the commission off the gross price, rounding down to whole cents', () => {
    expect(appleProceedsCents(1799, 1500)).toBe(1529);
    expect(appleProceedsCents(1799, 3000)).toBe(1259);
    expect(appleProceedsCents(1000, 0)).toBe(1000);
  });

  it('fails closed on a non-positive or non-finite price', () => {
    expect(appleProceedsCents(0, 1500)).toBe(0);
    expect(appleProceedsCents(-5, 1500)).toBe(0);
    expect(appleProceedsCents(Number.NaN, 1500)).toBe(0);
  });
});

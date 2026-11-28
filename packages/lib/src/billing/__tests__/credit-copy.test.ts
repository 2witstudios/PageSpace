import { describe, it, expect } from 'vitest';
import { TIERS } from '../subscription-tiers';
import {
  MONTHLY_CREDIT_CENTS,
  MONTHLY_CREDITS,
  FREE_STARTER_CREDITS_DISPLAY,
  monthlyCreditsPhrase,
  monthlyCreditsPhraseForCents,
  creditsCellPhrase,
  creditsPhrase,
  includedCreditsPhrase,
  includedCreditsPhraseForCents,
  CREDIT_PACK_LIST,
  CREDIT_PACKS_DISPLAY,
  creditPacksPhrase,
  topUpRatePhrase,
} from '../credit-copy';
import { tierAllowanceCents, formatCreditCount, FREE_STARTER_CREDITS } from '../money-model';

// MONTHLY_CREDIT_CENTS is `perTier(tierAllowanceCents)`; the ratio math itself is
// covered in money-model.test.ts. This file proves the WIRING (MONTHLY_CREDIT_CENTS
// and every phrase built on it agree with tierAllowanceCents) and pins A-11's
// literal figures, so an expectation is never rebuilt from the module under test.

describe('MON-5 (partial) the web formatter, the marketing mirror, and admin consume one credit definition', () => {
  it('MON-2 MONTHLY_CREDIT_CENTS per tier equals tierAllowanceCents(tier)\'s own default, and MONTHLY_CREDITS is its count', () => {
    for (const tier of TIERS) {
      expect(MONTHLY_CREDIT_CENTS[tier], tier).toBe(tierAllowanceCents(tier));
      expect(MONTHLY_CREDITS[tier], tier).toBe(formatCreditCount(MONTHLY_CREDIT_CENTS[tier]));
    }
    // A-11: Pro is $15 × 100% → 150.
    expect(MONTHLY_CREDITS.pro).toBe('150');
  });

  it('MON-8 FREE_STARTER_CREDITS_DISPLAY is the starter count, not a monthly figure', () => {
    expect(FREE_STARTER_CREDITS_DISPLAY).toBe(String(FREE_STARTER_CREDITS));
    expect(MONTHLY_CREDITS.free).toBe(FREE_STARTER_CREDITS_DISPLAY);
  });

  it('UI-12 every credit phrase is a count: no dollar sign, no decimals', () => {
    for (const tier of TIERS) {
      for (const phrase of [
        monthlyCreditsPhrase(tier),
        creditsCellPhrase(tier, MONTHLY_CREDIT_CENTS[tier]),
        creditsPhrase(tier),
      ]) {
        expect(phrase, `${tier}: ${phrase}`).not.toContain('$');
        expect(phrase, `${tier}: ${phrase}`).not.toMatch(/\d\.\d/);
      }
    }
  });

  it('UI-12 the free phrase says "to start" and never "/month"; paid phrases say "/month"', () => {
    expect(monthlyCreditsPhrase('free')).toBe('50 credits to start');
    expect(creditsPhrase('free')).toBe('50 to start');
    // A-11: Pro $15 × 100% → 150; Business $50 × 100% → 500.
    expect(monthlyCreditsPhrase('pro')).toBe('150 credits/month');
    expect(creditsPhrase('pro')).toBe('150/mo');
    expect(monthlyCreditsPhrase('business')).toBe('500 credits/month');
    expect(creditsPhrase('business')).toBe('500/mo');
  });

  it('MON-4 top-up packs are credit counts; their prices are real purchases and keep dollar strings', () => {
    expect(CREDIT_PACK_LIST.map((p) => p.credits)).toEqual([100, 250, 500]);
    expect(CREDIT_PACK_LIST.map((p) => p.label)).toEqual(['100 credits', '250 credits', '500 credits']);
    expect(CREDIT_PACKS_DISPLAY).toEqual(['$10', '$25', '$50']);
    expect(creditPacksPhrase()).toBe('$10, $25, or $50');
  });
});

describe('MON-6 plan-card facts (lane A2)', () => {
  it('MON-6 includedCreditsPhrase is an integer credit count with no dollar sign, per tier', () => {
    // Literal A-11 copy, not rebuilt from MONTHLY_CREDITS: an expectation derived
    // from the module under test cannot fail.
    expect(includedCreditsPhrase('free')).toBe('50 credits to start');
    expect(includedCreditsPhrase('pro')).toBe('150 credits included each month');
    expect(includedCreditsPhrase('business')).toBe('500 credits included each month');
    for (const tier of TIERS) {
      expect(includedCreditsPhrase(tier), tier).not.toContain('$');
      expect(includedCreditsPhrase(tier), tier).toMatch(/^\d/);
    }
  });

  it('MON-6 / MON-4 topUpRatePhrase states the smallest pack as a credit count over a real purchase price, no ratio applied', () => {
    // A-11: a $10 pack is 100 credits.
    expect(topUpRatePhrase()).toBe('100 credits per $10');
  });

  it('MON-6 / MON-4 the subscription figure carries the ratio and the top-up rate does not: Pro pays $15 for 150 included credits while $10 of top-up buys 100', () => {
    expect(tierAllowanceCents('pro')).toBe(1500);
    expect(topUpRatePhrase()).toBe('100 credits per $10');
  });

  it('MON-2 the *ForCents siblings render A-11 figures from a server-supplied number', () => {
    expect(includedCreditsPhraseForCents('pro', tierAllowanceCents('pro'))).toBe('150 credits included each month');
    expect(monthlyCreditsPhraseForCents('business', tierAllowanceCents('business'))).toBe('500 credits/month');
    expect(creditsCellPhrase('pro', tierAllowanceCents('pro'))).toBe('150 credits/mo');
  });
});

describe('MON-2 the *ForCents siblings rebuild copy from a server-supplied number', () => {
  it('includedCreditsPhraseForCents matches includedCreditsPhrase for the tier\'s own number, and differs for another', () => {
    expect(includedCreditsPhraseForCents('pro', MONTHLY_CREDIT_CENTS.pro)).toBe(includedCreditsPhrase('pro'));
    // A server-supplied override (e.g. a promo invoice) renders its OWN number, not
    // the module's build-time one — this is the seam withCreditOverrides depends on.
    expect(includedCreditsPhraseForCents('pro', 740)).toBe('74 credits included each month');
    expect(includedCreditsPhraseForCents('free', 500)).toBe('50 credits to start');
  });

  it('monthlyCreditsPhraseForCents matches monthlyCreditsPhrase for the tier\'s own number, and differs for another', () => {
    expect(monthlyCreditsPhraseForCents('pro', MONTHLY_CREDIT_CENTS.pro)).toBe(monthlyCreditsPhrase('pro'));
    expect(monthlyCreditsPhraseForCents('business', 9000)).toBe('900 credits/month');
    expect(monthlyCreditsPhraseForCents('free', 500)).toBe('50 credits to start');
  });

});

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
import { tierAllowanceCents, formatCreditCount, FREE_STARTER_CREDITS, MONEY_MODEL_V2_ACTIVE } from '../money-model';

// D-OW-17: MONTHLY_CREDIT_CENTS is `perTier(tierAllowanceCents)` — no `active`
// argument passed — so it is hardwired to MONEY_MODEL_V2_ACTIVE (false in this PR)
// exactly like production. There is no env var left to flip here; the ratio math
// itself (both active=true and active=false) is covered directly in
// money-model.test.ts. This file only proves the WIRING: MONTHLY_CREDIT_CENTS and
// every phrase built on it agree with tierAllowanceCents(tier)'s own default.

describe('MON-5 the web formatter, the marketing mirror, and admin consume one credit definition', () => {
  it('MON-2 MONTHLY_CREDIT_CENTS per tier equals tierAllowanceCents(tier)\'s own default, and MONTHLY_CREDITS is its count', () => {
    for (const tier of TIERS) {
      expect(MONTHLY_CREDIT_CENTS[tier], tier).toBe(tierAllowanceCents(tier));
      expect(MONTHLY_CREDITS[tier], tier).toBe(formatCreditCount(MONTHLY_CREDIT_CENTS[tier]));
    }
    // Today's production figure (MONEY_MODEL_V2_ACTIVE = false): Pro is $15 → 1,500.
    expect(MONTHLY_CREDITS.pro).toBe('1,500');
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
    expect(monthlyCreditsPhrase('free')).toBe('500 credits to start');
    expect(creditsPhrase('free')).toBe('500 to start');
    // Today's production figure: Pro $15 → 1,500 (MONEY_MODEL_V2_ACTIVE = false).
    expect(monthlyCreditsPhrase('pro')).toBe('1,500 credits/month');
    expect(creditsPhrase('pro')).toBe('1,500/mo');
  });

  it('MON-4 top-up packs are credit counts; their prices are real purchases and keep dollar strings', () => {
    expect(CREDIT_PACK_LIST.map((p) => p.credits)).toEqual([1000, 2500, 5000]);
    expect(CREDIT_PACK_LIST.map((p) => p.label)).toEqual(['1,000 credits', '2,500 credits', '5,000 credits']);
    expect(CREDIT_PACKS_DISPLAY).toEqual(['$10', '$25', '$50']);
    expect(creditPacksPhrase()).toBe('$10, $25, or $50');
  });
});

describe('MON-6 plan-card facts (lane A2)', () => {
  it('MON-6 includedCreditsPhrase is an integer credit count with no dollar sign, per tier', () => {
    // Literal committed-default copy (MONEY_MODEL_V2_ACTIVE = false), not rebuilt from
    // MONTHLY_CREDITS: an expectation derived from the module under test cannot fail.
    expect(MONEY_MODEL_V2_ACTIVE).toBe(false);
    expect(includedCreditsPhrase('free')).toBe('500 credits to start');
    expect(includedCreditsPhrase('pro')).toBe('1,500 credits included each month');
    expect(includedCreditsPhrase('business')).toBe('5,000 credits included each month');
    for (const tier of TIERS) {
      expect(includedCreditsPhrase(tier), tier).not.toContain('$');
      expect(includedCreditsPhrase(tier), tier).toMatch(/^\d/);
    }
  });

  it('MON-6 / MON-4 topUpRatePhrase states the smallest pack as a credit count over a real purchase price, no ratio applied', () => {
    // A-11: a $10 pack is 1,000 credits.
    expect(topUpRatePhrase()).toBe('1,000 credits per $10');
  });

  it('MON-6 / D-OW-17 flipping the ratio constant (active=true, tested directly on tierAllowanceCents) never changes the top-up rate — only the migration-day commit could change MONTHLY_CREDIT_CENTS, and MON-4 top-ups take no ratio regardless', () => {
    // Package-level: prove the two facts are computed from genuinely different
    // inputs, not just "currently equal by coincidence".
    expect(tierAllowanceCents('pro', true)).not.toBe(tierAllowanceCents('pro', false));
    // topUpRatePhrase reads CREDIT_PACKS (money-model, no ratio applied at all, MON-4)
    // — nothing in its call graph takes an `active` argument to flip.
    expect(topUpRatePhrase()).toBe('1,000 credits per $10');
  });
});

describe('MON-2 the *ForCents siblings rebuild copy from a server-supplied number', () => {
  it('includedCreditsPhraseForCents matches includedCreditsPhrase for the tier\'s own number, and differs for another', () => {
    expect(includedCreditsPhraseForCents('pro', MONTHLY_CREDIT_CENTS.pro)).toBe(includedCreditsPhrase('pro'));
    // A server-supplied override (e.g. a promo invoice) renders its OWN number, not
    // the module's build-time one — this is the seam withCreditOverrides depends on.
    expect(includedCreditsPhraseForCents('pro', 740)).toBe('740 credits included each month');
    expect(includedCreditsPhraseForCents('free', 500)).toBe('500 credits to start');
  });

  it('monthlyCreditsPhraseForCents matches monthlyCreditsPhrase for the tier\'s own number, and differs for another', () => {
    expect(monthlyCreditsPhraseForCents('pro', MONTHLY_CREDIT_CENTS.pro)).toBe(monthlyCreditsPhrase('pro'));
    expect(monthlyCreditsPhraseForCents('business', 9000)).toBe('9,000 credits/month');
    expect(monthlyCreditsPhraseForCents('free', 500)).toBe('500 credits to start');
  });

  it('D-OW-17 no client-visible mirror of the flag leaks into this module either', async () => {
    const mod: Record<string, unknown> = await import('../credit-copy');
    expect(mod.isMoneyModelV2EnabledForDisplay).toBeUndefined();
  });
});

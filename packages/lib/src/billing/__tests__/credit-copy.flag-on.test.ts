import { describe, it, expect, vi } from 'vitest';

/**
 * D-OW-17 flag-on copy coverage (independent review on #2649). credit-copy.test.ts
 * runs with MONEY_MODEL_V2_ACTIVE as committed (false), so without this file the
 * ratio copy would first be rendered by a test in the migration commit itself — the
 * same commit that rewrites every hard-coded 1,500, where a wrong phrase is easy to
 * "fix" by editing the expectation.
 *
 * credit-copy sizes MONTHLY_CREDIT_CENTS with `tierAllowanceCents(tier)` and no
 * `active` argument. Mocking the exported constant would not reach that default (it
 * binds inside money-model), so this file routes credit-copy's call to the REAL
 * tierAllowanceCents with `active = true` passed explicitly. Every other export is
 * the real module.
 */
const realMoneyModel = vi.hoisted(() => ({} as typeof import('../money-model')));

vi.mock('../money-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../money-model')>();
  Object.assign(realMoneyModel, actual);
  return {
    ...actual,
    tierAllowanceCents: (tier: string) => actual.tierAllowanceCents(tier, true),
  };
});

import { TIERS } from '../subscription-tiers';
import {
  MONTHLY_CREDIT_CENTS,
  MONTHLY_CREDITS,
  monthlyCreditsPhrase,
  monthlyCreditsPhraseForCents,
  creditsCellPhrase,
  creditsPhrase,
  includedCreditsPhrase,
  includedCreditsPhraseForCents,
} from '../credit-copy';

describe('D-OW-17 credit copy with the ratio active (active=true passed explicitly)', () => {
  it('the copy module is sized by the ratio, not the committed default', () => {
    for (const tier of TIERS) {
      expect(MONTHLY_CREDIT_CENTS[tier], tier).toBe(realMoneyModel.tierAllowanceCents(tier, true));
    }
    expect(MONTHLY_CREDIT_CENTS.pro).not.toBe(realMoneyModel.tierAllowanceCents('pro', false));
  });

  it('A-11 Pro is 900 and Business is 3,000 credits a month; the free starter grant is unchanged', () => {
    expect(MONTHLY_CREDITS.pro).toBe('900');
    expect(MONTHLY_CREDITS.business).toBe('3,000');
    expect(monthlyCreditsPhrase('pro')).toBe('900 credits/month');
    expect(monthlyCreditsPhrase('business')).toBe('3,000 credits/month');
    expect(creditsPhrase('pro')).toBe('900/mo');
    expect(creditsPhrase('business')).toBe('3,000/mo');
    expect(includedCreditsPhrase('pro')).toBe('900 credits included each month');
    expect(includedCreditsPhrase('business')).toBe('3,000 credits included each month');
    expect(monthlyCreditsPhrase('free')).toBe('500 credits to start');
    expect(creditsPhrase('free')).toBe('500 to start');
  });

  it('MON-2 the *ForCents siblings render the same ratio figures from a server-supplied number', () => {
    const proCents = realMoneyModel.tierAllowanceCents('pro', true);
    const businessCents = realMoneyModel.tierAllowanceCents('business', true);
    expect(includedCreditsPhraseForCents('pro', proCents)).toBe('900 credits included each month');
    expect(monthlyCreditsPhraseForCents('business', businessCents)).toBe('3,000 credits/month');
    expect(creditsCellPhrase('pro', proCents)).toBe('900 credits/mo');
  });

  it('UI-12 no credit phrase carries a dollar sign or a decimal with the ratio active', () => {
    for (const tier of TIERS) {
      const cents = realMoneyModel.tierAllowanceCents(tier, true);
      for (const phrase of [
        monthlyCreditsPhrase(tier),
        monthlyCreditsPhraseForCents(tier, cents),
        creditsCellPhrase(tier, cents),
        creditsPhrase(tier),
        includedCreditsPhrase(tier),
        includedCreditsPhraseForCents(tier, cents),
      ]) {
        expect(phrase, `${tier}: ${phrase}`).not.toContain('$');
        expect(phrase, `${tier}: ${phrase}`).not.toMatch(/\d\.\d/);
      }
    }
  });
});

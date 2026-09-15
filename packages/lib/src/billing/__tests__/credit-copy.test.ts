import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TIERS } from '../subscription-tiers';

const ORIGINAL_ENV = { ...process.env };

async function load(env: Record<string, string> = {}) {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, ...env };
  delete process.env.MONEY_MODEL_V2;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const copy = await import('../credit-copy');
  const model = await import('../money-model');
  return { ...copy, ...model };
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('MON-5 the web formatter, the marketing mirror, and admin consume one credit definition', () => {
  it('MON-2 MONTHLY_CREDIT_CENTS per tier equals the list-price derivation, and MONTHLY_CREDITS is its count', async () => {
    const { MONTHLY_CREDIT_CENTS, MONTHLY_CREDITS, tierAllowanceCents, formatCreditCount } = await load({
      MONEY_MODEL_V2: 'true',
    });
    for (const tier of TIERS) {
      expect(MONTHLY_CREDIT_CENTS[tier], tier).toBe(tierAllowanceCents(tier));
      expect(MONTHLY_CREDITS[tier], tier).toBe(formatCreditCount(MONTHLY_CREDIT_CENTS[tier]));
    }
    // A-11: Pro includes 900 credits a month.
    expect(MONTHLY_CREDITS.pro).toBe('900');
  });

  it('MON-8 FREE_STARTER_CREDITS_DISPLAY is the starter count, not a monthly figure', async () => {
    const { FREE_STARTER_CREDITS_DISPLAY, FREE_STARTER_CREDITS, MONTHLY_CREDITS } = await load();
    expect(FREE_STARTER_CREDITS_DISPLAY).toBe(String(FREE_STARTER_CREDITS));
    expect(MONTHLY_CREDITS.free).toBe(FREE_STARTER_CREDITS_DISPLAY);
  });

  it('UI-12 every credit phrase is a count: no dollar sign, no decimals', async () => {
    const { monthlyCreditsPhrase, creditsCellPhrase, creditsPhrase, MONTHLY_CREDIT_CENTS } = await load({
      MONEY_MODEL_V2: 'true',
    });
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

  it('MON-6 the free phrase says "to start" and never "/month"; paid phrases say "/month"', async () => {
    const { monthlyCreditsPhrase, creditsPhrase } = await load({ MONEY_MODEL_V2: 'true' });
    expect(monthlyCreditsPhrase('free')).toBe('500 credits to start');
    expect(creditsPhrase('free')).toBe('500 to start');
    expect(monthlyCreditsPhrase('pro')).toBe('900 credits/month');
    expect(creditsPhrase('pro')).toBe('900/mo');
  });

  it('top-up packs are real purchases and keep their dollar price strings', async () => {
    const { CREDIT_PACKS_DISPLAY, creditPacksPhrase, CREDIT_PACK_LIST } = await load();
    expect(CREDIT_PACKS_DISPLAY).toEqual(['$10', '$25', '$50']);
    expect(creditPacksPhrase()).toBe('$10, $25, or $50');
    expect(CREDIT_PACK_LIST.map((p) => p.cents)).toEqual([1000, 2500, 5000]);
  });
});

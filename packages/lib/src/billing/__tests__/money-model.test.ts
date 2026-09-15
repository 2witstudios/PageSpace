import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TIERS, TIER_PLAN_LIMITS } from '../subscription-tiers';

// money-model reads MONEY_MODEL_V2 and CREDIT_MARKUP_BPS at call/import time, so
// every case re-imports the module against a controlled environment.
const ORIGINAL_ENV = { ...process.env };

async function load(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MONEY_MODEL_V2;
  delete process.env.CREDIT_MARKUP_BPS;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../money-model');
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('MON-1 one module defines the money model', () => {
  it('MON-1 exports MARKUP_BPS (moved from credit-pricing) with the 1.5× default and env override', async () => {
    const def = await load();
    expect(def.MARKUP_BPS).toBe(15000);
    const over = await load({ CREDIT_MARKUP_BPS: '12000' });
    expect(over.MARKUP_BPS).toBe(12000);
  });

  it('MON-1 credit-pricing re-exports the SAME MARKUP_BPS, not a second definition', async () => {
    const mm = await load({ CREDIT_MARKUP_BPS: '17000' });
    const pricing = await import('../credit-pricing');
    expect(pricing.MARKUP_BPS).toBe(mm.MARKUP_BPS);
    expect(pricing.MARKUP_BPS).toBe(17000);
  });

  it('A-11 CREDITS_PER_DOLLAR is 100 and INCLUDED_CREDIT_RATIO_BPS is 60% for pro and business', async () => {
    const { CREDITS_PER_DOLLAR, INCLUDED_CREDIT_RATIO_BPS } = await load();
    expect(CREDITS_PER_DOLLAR).toBe(100);
    expect(INCLUDED_CREDIT_RATIO_BPS.pro).toBe(6000);
    expect(INCLUDED_CREDIT_RATIO_BPS.business).toBe(6000);
  });

  it('MON-1 the ratio table is keyed by the canonical vocabulary; free derives nothing (0)', async () => {
    const { INCLUDED_CREDIT_RATIO_BPS } = await load();
    expect(Object.keys(INCLUDED_CREDIT_RATIO_BPS).sort()).toEqual([...TIERS].sort());
    expect(INCLUDED_CREDIT_RATIO_BPS.free).toBe(0);
  });

  it('MON-2 isMoneyModelV2Enabled reads MONEY_MODEL_V2 at call time from an injectable env', async () => {
    const { isMoneyModelV2Enabled } = await load();
    expect(isMoneyModelV2Enabled()).toBe(false);
    process.env.MONEY_MODEL_V2 = 'true';
    expect(isMoneyModelV2Enabled()).toBe(true);
    expect(isMoneyModelV2Enabled({ MONEY_MODEL_V2: '0' })).toBe(false);
    expect(isMoneyModelV2Enabled({ MONEY_MODEL_V2: 'on' })).toBe(true);
    expect(isMoneyModelV2Enabled({})).toBe(false);
  });
});

describe('MON-2 the monthly allowance is derived from the amount paid, never tabulated', () => {
  it('MON-2 allowanceCentsForPaidCents = paidCents × ratio for every paid tier (MONEY_MODEL_V2 on)', async () => {
    const { allowanceCentsForPaidCents, INCLUDED_CREDIT_RATIO_BPS } = await load({ MONEY_MODEL_V2: 'true' });
    for (const tier of TIERS) {
      if (tier === 'free') continue;
      const paid = TIER_PLAN_LIMITS[tier].priceMonthlyUsd * 100;
      const expected = Math.floor((paid * INCLUDED_CREDIT_RATIO_BPS[tier]) / 10000);
      expect(allowanceCentsForPaidCents(paid, tier), tier).toBe(expected);
    }
  });

  it('A-11 Pro $15 → 900 credits; Business $50 + 10 seats × $10 → 9,000 credits (Northwind Labs)', async () => {
    const { allowanceCentsForPaidCents, creditsFromCents } = await load({ MONEY_MODEL_V2: 'true' });
    expect(creditsFromCents(allowanceCentsForPaidCents(1500, 'pro'))).toBe(900);
    expect(creditsFromCents(allowanceCentsForPaidCents(5000, 'business'))).toBe(3000);
    expect(creditsFromCents(allowanceCentsForPaidCents(5000 + 10 * 1000, 'business'))).toBe(9000);
    // One extra seat is $10 → 600 credits, so 6 extra seats add 3,600.
    expect(creditsFromCents(allowanceCentsForPaidCents(1000, 'business'))).toBe(600);
  });

  it('MON-2 a promo or partial period flows through: a $12.34 invoice grants floor(1234 × 0.6) = 740¢', async () => {
    const { allowanceCentsForPaidCents } = await load({ MONEY_MODEL_V2: 'true' });
    expect(allowanceCentsForPaidCents(1234, 'pro')).toBe(740);
    expect(allowanceCentsForPaidCents(0, 'pro')).toBe(0);
  });

  it('MON-2 the free tier and an unknown tier derive nothing from a payment', async () => {
    const { allowanceCentsForPaidCents, includedCreditRatioBps } = await load({ MONEY_MODEL_V2: 'true' });
    expect(allowanceCentsForPaidCents(1500, 'free')).toBe(0);
    expect(includedCreditRatioBps('enterprise')).toBe(0);
  });

  it('MON-2 a negative or non-finite paid amount grants nothing (never a negative allowance)', async () => {
    const { allowanceCentsForPaidCents } = await load({ MONEY_MODEL_V2: 'true' });
    expect(allowanceCentsForPaidCents(-1500, 'pro')).toBe(0);
    expect(allowanceCentsForPaidCents(Number.NaN, 'pro')).toBe(0);
  });

  it('MON-2 with MONEY_MODEL_V2 off the ratio is the legacy 1:1 so balances compute as today', async () => {
    const { allowanceCentsForPaidCents, includedCreditRatioBps } = await load();
    expect(includedCreditRatioBps('pro')).toBe(10000);
    expect(allowanceCentsForPaidCents(1500, 'pro')).toBe(1500);
    expect(allowanceCentsForPaidCents(10000, 'business')).toBe(10000);
  });

  it('MON-2 tierAllowanceCents sizes a grant from the list price when there is no invoice, per tier', async () => {
    const { tierAllowanceCents, allowanceCentsForPaidCents } = await load({ MONEY_MODEL_V2: 'true' });
    for (const tier of TIERS) {
      if (tier === 'free') continue;
      const list = TIER_PLAN_LIMITS[tier].priceMonthlyUsd * 100;
      expect(tierAllowanceCents(tier), tier).toBe(allowanceCentsForPaidCents(list, tier));
      expect(tierAllowanceCents(tier), tier).toBeGreaterThan(0);
    }
    // Flag off: today's numbers exactly (pro $15 → 1500¢).
    const legacy = await load();
    expect(legacy.tierAllowanceCents('pro')).toBe(1500);
  });
});

describe('MON-8 the free starter grant is a plain credit count, not derived from a price', () => {
  it('MON-8 FREE_STARTER_CREDITS is an integer credit count', async () => {
    const { FREE_STARTER_CREDITS } = await load();
    expect(Number.isInteger(FREE_STARTER_CREDITS)).toBe(true);
    expect(FREE_STARTER_CREDITS).toBeGreaterThan(0);
  });

  it('MON-8 tierAllowanceCents("free") is the starter grant in cents regardless of the flag or any price', async () => {
    const on = await load({ MONEY_MODEL_V2: 'true' });
    const off = await load();
    expect(on.tierAllowanceCents('free')).toBe(on.centsFromCredits(on.FREE_STARTER_CREDITS));
    expect(off.tierAllowanceCents('free')).toBe(on.tierAllowanceCents('free'));
    // Today's $5 of starter value, unchanged.
    expect(off.tierAllowanceCents('free')).toBe(500);
  });

  it('MON-8 an unknown/legacy tier is treated as free for grant sizing (never a paid allowance)', async () => {
    const { tierAllowanceCents } = await load({ MONEY_MODEL_V2: 'true' });
    expect(tierAllowanceCents('enterprise')).toBe(tierAllowanceCents('free'));
  });
});

describe('MON-5 one definition of a credit', () => {
  it('MON-5 a credit is CREDITS_PER_DOLLAR⁻¹ of a dollar: creditsFromCents / centsFromCredits round-trip', async () => {
    const { creditsFromCents, centsFromCredits, CREDITS_PER_DOLLAR } = await load();
    expect(creditsFromCents(100)).toBe(CREDITS_PER_DOLLAR);
    expect(centsFromCredits(CREDITS_PER_DOLLAR)).toBe(100);
    for (const cents of [0, 1, 500, 1500, 123456]) {
      expect(centsFromCredits(creditsFromCents(cents))).toBe(cents);
    }
  });

  it('A-11 a $10 top-up pack is 1,000 credits at the full rate, no ratio applied', async () => {
    const { creditsFromCents, formatCreditCount } = await load({ MONEY_MODEL_V2: 'true' });
    expect(creditsFromCents(1000)).toBe(1000);
    expect(formatCreditCount(1000)).toBe('1,000');
  });

  it('MON-5 dollarsFromCents is the single cents→dollars conversion', async () => {
    const { dollarsFromCents, formatDollars } = await load();
    expect(dollarsFromCents(1050)).toBe(10.5);
    expect(formatDollars(1000)).toBe('$10');
    expect(formatDollars(1050)).toBe('$10.50');
    expect(formatDollars(0)).toBe('$0');
  });
});

describe('MON-5 formatCreditCount renders an integer count with thousands separators', () => {
  it('MON-5 formats the canvas numbers: 900, 1,200, 3,000, 9,000, 192', async () => {
    const { formatCreditCount, centsFromCredits } = await load();
    expect(formatCreditCount(centsFromCredits(900))).toBe('900');
    expect(formatCreditCount(centsFromCredits(1200))).toBe('1,200');
    expect(formatCreditCount(centsFromCredits(3000))).toBe('3,000');
    expect(formatCreditCount(centsFromCredits(9000))).toBe('9,000');
    expect(formatCreditCount(centsFromCredits(192))).toBe('192');
    expect(formatCreditCount(0)).toBe('0');
  });

  it('MON-5 never shows decimals: fractional credits round to the nearest whole credit', async () => {
    const { formatCreditCount } = await load();
    // 0.4 credits → "0"; 0.6 → "1"; 1,499.5 → "1,500" (half away from zero).
    expect(formatCreditCount(0.4)).toBe('0');
    expect(formatCreditCount(0.6)).toBe('1');
    expect(formatCreditCount(149950 / 100)).toBe('1,500');
    for (const cents of [0.4, 1, 150, 149950 / 100, 1234567]) {
      expect(formatCreditCount(cents)).not.toMatch(/\./);
    }
  });

  it('UI-12 never carries a dollar sign and negatives (overage) carry a leading minus', async () => {
    const { formatCreditCount } = await load();
    expect(formatCreditCount(-5000)).toBe('-5,000');
    expect(formatCreditCount(-0.2)).toBe('0');
    for (const cents of [-5000, -1, 0, 1, 99, 100, 123456789]) {
      expect(formatCreditCount(cents)).not.toContain('$');
    }
  });
});

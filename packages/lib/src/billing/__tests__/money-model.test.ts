import { describe, it, expect, afterEach, vi } from 'vitest';
import { TIERS, TIER_PLAN_LIMITS } from '../subscription-tiers';
import {
  MARKUP_BPS,
  CREDITS_PER_DOLLAR,
  INCLUDED_CREDIT_RATIO_BPS,
  includedCreditRatioBps,
  allowanceCentsForPaidCents,
  tierAllowanceCents,
  FREE_STARTER_CREDITS,
  creditsFromCents,
  centsFromCredits,
  dollarsFromCents,
  providerDollarsCoveredByCents,
  chargedCentsFromProviderDollars,
  chargedMillicentsFromProviderDollars,
  exactCentsFromDollars,
  centsFromDollars,
  centsFromMillicents,
  CENTS_PER_DOLLAR,
  formatDollars,
  formatCreditCount,
  creditsFromDollars,
  CREDIT_PACKS,
  creditPackPriceCents,
  getCreditPack,
  validateTopupCredits,
  CREDIT_TOPUP_MIN_CREDITS,
  CREDIT_TOPUP_MAX_CREDITS,
} from '../money-model';
import { MARKUP_BPS as CREDIT_PRICING_MARKUP_BPS } from '../credit-pricing';

// Only CREDIT_MARKUP_BPS / CREDIT_TOPUP_MIN_CREDITS / CREDIT_TOPUP_MAX_CREDITS are real
// env vars left in this module (D-OW-17 made the ratio switch a code constant, not an
// env var) — this loader is only for those, re-importing against a controlled env.
const ORIGINAL_ENV = { ...process.env };

async function loadWithEnv(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.CREDIT_MARKUP_BPS;
  delete process.env.CREDIT_TOPUP_MIN_CREDITS;
  delete process.env.CREDIT_TOPUP_MAX_CREDITS;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../money-model');
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('MON-1 (partial) one module defines the money model', () => {
  it('MON-1 (partial) exports MARKUP_BPS (moved from credit-pricing) with the 1.5× default and env override', async () => {
    expect(MARKUP_BPS).toBe(15000);
    const over = await loadWithEnv({ CREDIT_MARKUP_BPS: '12000' });
    expect(over.MARKUP_BPS).toBe(12000);
  });

  it('MON-1 (partial) credit-pricing re-exports the SAME MARKUP_BPS, not a second definition', () => {
    expect(CREDIT_PRICING_MARKUP_BPS).toBe(MARKUP_BPS);
  });

  it('A-11 CREDITS_PER_DOLLAR is 10 and INCLUDED_CREDIT_RATIO_BPS is 60% for pro and business', () => {
    expect(CREDITS_PER_DOLLAR).toBe(10);
    expect(INCLUDED_CREDIT_RATIO_BPS.pro).toBe(6000);
    expect(INCLUDED_CREDIT_RATIO_BPS.business).toBe(6000);
  });

  it('MON-1 (partial) the ratio table is keyed by the canonical vocabulary; free derives nothing (0)', () => {
    expect(Object.keys(INCLUDED_CREDIT_RATIO_BPS).sort()).toEqual([...TIERS].sort());
    expect(INCLUDED_CREDIT_RATIO_BPS.free).toBe(0);
  });

  it('D-OW-17 / D-OW-42 the ratio is in force unconditionally: no switch, flag or legacy 100% ratio is exported', async () => {
    const mod: Record<string, unknown> = await import('../money-model');
    expect(mod.MONEY_MODEL_V2_ACTIVE).toBeUndefined();
    expect(mod.isMoneyModelV2Enabled).toBeUndefined();
    expect(mod.LEGACY_INCLUDED_CREDIT_RATIO_BPS).toBeUndefined();
    expect(includedCreditRatioBps.length).toBe(1);
    expect(allowanceCentsForPaidCents.length).toBe(2);
    expect(tierAllowanceCents.length).toBe(1);
  });
});

describe('includedCreditRatioBps reads the ratio table', () => {
  it('pro and business are 60%; the free tier and an unknown tier derive nothing', () => {
    expect(includedCreditRatioBps('pro')).toBe(6000);
    expect(includedCreditRatioBps('business')).toBe(6000);
    expect(includedCreditRatioBps('free')).toBe(0);
    expect(includedCreditRatioBps('enterprise')).toBe(0);
  });
});

describe('MON-2 the monthly allowance is derived from the amount paid, never tabulated', () => {
  it('MON-2 allowanceCentsForPaidCents = paidCents × ratio for every paid tier', () => {
    for (const tier of TIERS) {
      if (tier === 'free') continue;
      const paid = TIER_PLAN_LIMITS[tier].priceMonthlyUsd * 100;
      const expected = Math.floor((paid * INCLUDED_CREDIT_RATIO_BPS[tier]) / 10000);
      expect(allowanceCentsForPaidCents(paid, tier), tier).toBe(expected);
    }
  });

  it('A-11 Pro $15 → 90 credits; Business $50 + 10 seats × $10 → 900 credits (Northwind Labs)', () => {
    expect(creditsFromCents(allowanceCentsForPaidCents(1500, 'pro'))).toBe(90);
    expect(creditsFromCents(allowanceCentsForPaidCents(5000, 'business'))).toBe(300);
    expect(creditsFromCents(allowanceCentsForPaidCents(5000 + 10 * 1000, 'business'))).toBe(900);
    // One extra seat is $10 → 60 credits, so 6 extra seats add 360.
    expect(creditsFromCents(allowanceCentsForPaidCents(1000, 'business'))).toBe(60);
  });

  it('MON-2 a promo or partial period flows through: a $12.34 invoice grants floor(1234 × 0.6) = 740¢', () => {
    expect(allowanceCentsForPaidCents(1234, 'pro')).toBe(740);
    expect(allowanceCentsForPaidCents(0, 'pro')).toBe(0);
  });

  it('MON-2 the free tier and an unknown tier derive nothing from a payment', () => {
    expect(allowanceCentsForPaidCents(1500, 'free')).toBe(0);
    expect(includedCreditRatioBps('enterprise')).toBe(0);
  });

  it('MON-2 a negative or non-finite paid amount grants nothing (never a negative allowance)', () => {
    expect(allowanceCentsForPaidCents(-1500, 'pro')).toBe(0);
    expect(allowanceCentsForPaidCents(Number.NaN, 'pro')).toBe(0);
  });

  it('MON-2 tierAllowanceCents sizes a grant from the list price when there is no invoice, per tier', () => {
    for (const tier of TIERS) {
      if (tier === 'free') continue;
      const list = TIER_PLAN_LIMITS[tier].priceMonthlyUsd * 100;
      expect(tierAllowanceCents(tier), tier).toBe(allowanceCentsForPaidCents(list, tier));
      expect(tierAllowanceCents(tier), tier).toBeGreaterThan(0);
    }
    // Pro $15 × 60% → 900¢.
    expect(tierAllowanceCents('pro')).toBe(900);
  });
});

describe('MON-8 the free starter grant is a plain credit count, not derived from a price', () => {
  it('MON-8 FREE_STARTER_CREDITS is an integer credit count', () => {
    expect(Number.isInteger(FREE_STARTER_CREDITS)).toBe(true);
    expect(FREE_STARTER_CREDITS).toBeGreaterThan(0);
  });

  it('MON-8 tierAllowanceCents("free") is the starter grant in cents regardless of any price', () => {
    expect(tierAllowanceCents('free')).toBe(centsFromCredits(FREE_STARTER_CREDITS));
    // Today's $5 of starter value, unchanged.
    expect(tierAllowanceCents('free')).toBe(500);
  });

  it('MON-8 an unknown/legacy tier is treated as free for grant sizing (never a paid allowance)', () => {
    expect(tierAllowanceCents('enterprise')).toBe(tierAllowanceCents('free'));
  });
});

describe('MON-5 (partial) one definition of a credit', () => {
  it('MON-5 (partial) a credit is CREDITS_PER_DOLLAR⁻¹ of a dollar: creditsFromCents / centsFromCredits round-trip', () => {
    expect(creditsFromCents(100)).toBe(CREDITS_PER_DOLLAR);
    expect(centsFromCredits(CREDITS_PER_DOLLAR)).toBe(100);
    for (const cents of [0, 1, 7, 500, 1500, 123456]) {
      expect(centsFromCredits(creditsFromCents(cents))).toBe(cents);
    }
  });

  it('MON-5 (partial) centsFromCredits returns an exact integer for every whole credit count 0..10,000', () => {
    // Stripe rejects a non-integer amount, and integer cents columns and equality checks
    // break on one. At the A-11 rate one credit is exactly ten cents, so the oracle is the
    // input times ten (an independent value, not the implementation's formula restated).
    expect(CREDITS_PER_DOLLAR).toBe(10);
    const counts = Array.from({ length: 10_001 }, (_, credits) => credits);
    // Collected rather than asserted per value, so a regression names every bad count at once.
    expect(counts.filter((credits) => centsFromCredits(credits) !== credits * 10)).toEqual([]);
    expect(counts.map(centsFromCredits).every(Number.isInteger)).toBe(true);
    expect(centsFromCredits(7)).toBe(70);
  });

  it('MON-5 (partial) creditsFromCents is exact for every whole cent amount 0..100,000 and round-trips back to it', () => {
    // A cent amount that is not a whole number of credits is a fractional count (7¢ is
    // 0.7 credits); it must still come back to the same whole cents, never 7.000000000000001.
    expect(CREDITS_PER_DOLLAR).toBe(10);
    const amounts = Array.from({ length: 100_001 }, (_, cents) => cents);
    expect(amounts.filter((cents) => centsFromCredits(creditsFromCents(cents)) !== cents)).toEqual([]);
    const wholeCredits = Array.from({ length: 10_001 }, (_, credits) => credits);
    expect(wholeCredits.filter((credits) => creditsFromCents(credits * 10) !== credits)).toEqual([]);
    expect(creditsFromCents(70)).toBe(7);
  });

  it('A-11 a $10 top-up pack is 100 credits at the full rate, no ratio applied', () => {
    expect(creditsFromCents(1000)).toBe(100);
    expect(formatCreditCount(1000)).toBe('100');
  });

  it('MON-5 (partial) dollarsFromCents is the single cents→dollars conversion', () => {
    expect(dollarsFromCents(1050)).toBe(10.5);
    expect(formatDollars(1000)).toBe('$10');
    expect(formatDollars(1050)).toBe('$10.50');
    expect(formatDollars(0)).toBe('$0');
  });
});

// Outside the 'MON-5 …' describe on purpose: a bare MON-5 in the enclosing describe would claim
// MON-5 in full for this test and silently upgrade its partial marker (the spec-coverage gate
// fails on that; see partialClaimsUpgradedByChain).
describe('the provider cost a charge covers', () => {
  it('MON-5 (partial) providerDollarsCoveredByCents takes charged cents back through the markup to the provider cost they cover', () => {
    // At the 1.5× default: 150¢ charged covers $1.00 of provider cost; 3¢ covers $0.02.
    expect(providerDollarsCoveredByCents(150)).toBe(1);
    expect(providerDollarsCoveredByCents(3)).toBe(0.02);
    expect(providerDollarsCoveredByCents(0)).toBe(0);
    // An explicit markup (the machine floor, say) is honoured instead of MARKUP_BPS.
    expect(providerDollarsCoveredByCents(200, 20000)).toBe(1);
    // Multiply before divide. The divide-first form this replaces (cents / 100 / (markup / 10000))
    // gives 0.09999999999999999, 0.11333333333333334, 0.13999999999999999, 0.15333333333333335
    // and 0.18000000000000002 for these inputs; literal expectations, never the formula itself.
    expect(providerDollarsCoveredByCents(15)).toBe(0.1);
    expect(providerDollarsCoveredByCents(17)).toBe(0.11333333333333333);
    expect(providerDollarsCoveredByCents(21)).toBe(0.14);
    expect(providerDollarsCoveredByCents(23)).toBe(0.15333333333333332);
    expect(providerDollarsCoveredByCents(27)).toBe(0.18);
  });
});

describe('MON-5 (partial) every dollars→cents step goes through money-model', () => {
  it('MON-5 (partial) CENTS_PER_DOLLAR is the one stated cents-per-dollar, for SQL that multiplies in the database', () => {
    expect(CENTS_PER_DOLLAR).toBe(100);
  });

  it('MON-5 (partial) exactCentsFromDollars leaves rounding to the caller; centsFromDollars rounds to the nearest cent', () => {
    expect(exactCentsFromDollars(0.125)).toBe(12.5);
    expect(exactCentsFromDollars(1.5)).toBe(150);
    expect(centsFromDollars(0.125)).toBe(13);
    expect(centsFromDollars(12.34)).toBe(1234);
    // The billing-off daily ceiling floors a float SUM of provider dollars.
    expect(Math.floor(exactCentsFromDollars(0.019))).toBe(1);
  });

  it('MON-5 (partial) chargedCentsFromProviderDollars applies the markup, then converts, with no rounding', () => {
    // At 1.5×: $0.10 of provider cost is charged 15¢; $0.001 is 0.15¢ (a TTS hold ceils it to 1¢).
    expect(chargedCentsFromProviderDollars(0.1, 15000)).toBeCloseTo(15, 10);
    expect(chargedCentsFromProviderDollars(0.001, 15000)).toBeCloseTo(0.15, 10);
    expect(Math.round(chargedCentsFromProviderDollars(0.123456, 15000))).toBe(19);
    // The default markup is MARKUP_BPS.
    expect(chargedCentsFromProviderDollars(1)).toBeCloseTo(MARKUP_BPS / 100, 10);
    // It inverts providerDollarsCoveredByCents.
    expect(chargedCentsFromProviderDollars(providerDollarsCoveredByCents(25, 15000), 15000)).toBeCloseTo(25, 10);
  });

  it('MON-5 (partial) centsFromMillicents is the millicent accrual unit back in cents, unrounded', () => {
    expect(centsFromMillicents(90_000)).toBe(90);
    expect(centsFromMillicents(100)).toBe(0.1);
    expect(centsFromMillicents(0)).toBe(0);
  });

  it('MON-5 (partial) chargedMillicentsFromProviderDollars is the same charge a thousand times finer', () => {
    expect(Math.round(chargedMillicentsFromProviderDollars(0.000123, 15000))).toBe(18);
    expect(Math.round(chargedMillicentsFromProviderDollars(0.1, 15000))).toBe(15000);
  });
});

describe('MON-5 (partial) formatCreditCount renders an integer count with thousands separators', () => {
  it('MON-5 (partial) formats the canvas numbers: 900, 1,200, 3,000, 9,000, 192', () => {
    expect(formatCreditCount(centsFromCredits(900))).toBe('900');
    expect(formatCreditCount(centsFromCredits(1200))).toBe('1,200');
    expect(formatCreditCount(centsFromCredits(3000))).toBe('3,000');
    expect(formatCreditCount(centsFromCredits(9000))).toBe('9,000');
    expect(formatCreditCount(centsFromCredits(192))).toBe('192');
    expect(formatCreditCount(0)).toBe('0');
  });

  it('MON-5 (partial) never shows decimals: fractional credits round to the nearest whole credit', () => {
    // 4¢ is 0.4 credits → "0"; 6¢ is 0.6 → "1"; 14,995¢ is 1,499.5 → "1,500" (half up).
    expect(formatCreditCount(4)).toBe('0');
    expect(formatCreditCount(6)).toBe('1');
    expect(formatCreditCount(14_995)).toBe('1,500');
    for (const cents of [0.4, 1, 7, 150, 14_995, 1234567]) {
      expect(formatCreditCount(cents)).not.toMatch(/\./);
    }
  });

  it('UI-12 never carries a dollar sign and negatives (overage) carry a leading minus', () => {
    expect(formatCreditCount(-50_000)).toBe('-5,000');
    expect(formatCreditCount(-2)).toBe('0');
    for (const cents of [-5000, -1, 0, 1, 99, 100, 123456789]) {
      expect(formatCreditCount(cents)).not.toContain('$');
    }
  });
});

describe('MON-4 top-ups buy credits at CREDITS_PER_DOLLAR with no ratio; packs are credit counts', () => {
  it('MON-4 packs are defined as credit counts 100 / 250 / 500 and priced from the rate', () => {
    const packs = Object.values(CREDIT_PACKS).sort((a, b) => a.credits - b.credits);
    expect(packs.map((p) => p.credits)).toEqual([100, 250, 500]);
    for (const pack of packs) {
      // $ price = credits / CREDITS_PER_DOLLAR, in cents; the 60% ratio never applies.
      expect(creditPackPriceCents(pack)).toBe((pack.credits / CREDITS_PER_DOLLAR) * 100);
    }
    expect(creditPackPriceCents(CREDIT_PACKS.pack_10)).toBe(1000);
  });

  it('MON-4 no pack states a size in cents; the label is a credit count with no dollar sign', () => {
    for (const pack of Object.values(CREDIT_PACKS)) {
      expect('cents' in pack).toBe(false);
      expect(pack.label).toBe(`${pack.credits.toLocaleString('en-US')} credits`);
      expect(pack.label).not.toContain('$');
    }
  });

  it('MON-4 getCreditPack resolves a SKU id and rejects an unknown one', () => {
    expect(getCreditPack('pack_25')).toBe(CREDIT_PACKS.pack_25);
    expect(getCreditPack('pack_does_not_exist')).toBeUndefined();
  });

  it('MON-4 a custom top-up is validated in credits: an integer within [min, max]', () => {
    expect(CREDIT_TOPUP_MIN_CREDITS).toBe(50);
    expect(CREDIT_TOPUP_MAX_CREDITS).toBe(5_000);
    expect(validateTopupCredits(1234)).toBe(1234);
    expect(validateTopupCredits(CREDIT_TOPUP_MIN_CREDITS)).toBe(CREDIT_TOPUP_MIN_CREDITS);
    expect(validateTopupCredits(CREDIT_TOPUP_MAX_CREDITS)).toBe(CREDIT_TOPUP_MAX_CREDITS);
    expect(validateTopupCredits(CREDIT_TOPUP_MIN_CREDITS - 1)).toBeNull();
    expect(validateTopupCredits(CREDIT_TOPUP_MAX_CREDITS + 1)).toBeNull();
    expect(validateTopupCredits(1000.5)).toBeNull();
    expect(validateTopupCredits(Number.NaN)).toBeNull();
    expect(validateTopupCredits(Number.POSITIVE_INFINITY)).toBeNull();
    expect(validateTopupCredits(-1000)).toBeNull();
    // Explicit bounds win over the defaults.
    expect(validateTopupCredits(100, 50, 200)).toBe(100);
    expect(validateTopupCredits(100, 150, 200)).toBeNull();
  });

  it('MON-4 the top-up bounds take env overrides in credits', async () => {
    const { CREDIT_TOPUP_MIN_CREDITS: min, CREDIT_TOPUP_MAX_CREDITS: max } = await loadWithEnv({
      CREDIT_TOPUP_MIN_CREDITS: '100',
      CREDIT_TOPUP_MAX_CREDITS: '9000',
    });
    expect(min).toBe(100);
    expect(max).toBe(9000);
  });

  it('MON-4 a dollar amount buys credits at the full rate: $12.30 → 123 credits → 1230¢ charged', () => {
    expect(creditsFromDollars(12.3)).toBe(123);
    expect(creditsFromDollars(10)).toBe(100);
    expect(centsFromCredits(creditsFromDollars(12.3))).toBe(1230);
  });

  it('MON-4 a dollar amount that is not a whole number of credits is refused, never rounded to a different charge', () => {
    // $5.04 would otherwise charge $5.00, and $4.96 would pass the $5 minimum.
    expect(validateTopupCredits(creditsFromDollars(5.04))).toBeNull();
    expect(validateTopupCredits(creditsFromDollars(4.96))).toBeNull();
    expect(validateTopupCredits(creditsFromDollars(5.1))).toBe(51);
    expect(validateTopupCredits(creditsFromDollars(5))).toBe(50);
  });
});

describe('D-OW-17 no client-visible mirror, and no env var, of the flag (single source of truth: a code constant)', () => {
  it('exports no display/browser variant of the flag or the derivation — that whole mechanism is superseded by the constant', async () => {
    const mod: Record<string, unknown> = await import('../money-model');
    expect(mod.isMoneyModelV2EnabledForDisplay).toBeUndefined();
    expect(mod.tierAllowanceCentsForDisplay).toBeUndefined();
  });

  it('this module never reads process.env.MONEY_MODEL_V2 — the seam guard in __tests__/seams/credit-conversion.seam.test.ts enforces this repo-wide', () => {
    const original = process.env.MONEY_MODEL_V2;
    process.env.MONEY_MODEL_V2 = 'false';
    try {
      expect(tierAllowanceCents('pro')).toBe(900);
    } finally {
      if (original === undefined) delete process.env.MONEY_MODEL_V2;
      else process.env.MONEY_MODEL_V2 = original;
    }
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TIERS, TIER_PLAN_LIMITS } from '../subscription-tiers';
import {
  MARKUP_BPS,
  CREDITS_PER_DOLLAR,
  INCLUDED_CREDIT_RATIO_BPS,
  MONEY_MODEL_V2_ACTIVE,
  isMoneyModelV2Enabled,
  includedCreditRatioBps,
  allowanceCentsForPaidCents,
  tierAllowanceCents,
  FREE_STARTER_CREDITS,
  creditsFromCents,
  centsFromCredits,
  dollarsFromCents,
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

describe('MON-1 one module defines the money model', () => {
  it('MON-1 exports MARKUP_BPS (moved from credit-pricing) with the 1.5× default and env override', async () => {
    expect(MARKUP_BPS).toBe(15000);
    const over = await loadWithEnv({ CREDIT_MARKUP_BPS: '12000' });
    expect(over.MARKUP_BPS).toBe(12000);
  });

  it('MON-1 credit-pricing re-exports the SAME MARKUP_BPS, not a second definition', () => {
    expect(CREDIT_PRICING_MARKUP_BPS).toBe(MARKUP_BPS);
  });

  it('A-11 CREDITS_PER_DOLLAR is 100 and INCLUDED_CREDIT_RATIO_BPS is 60% for pro and business', () => {
    expect(CREDITS_PER_DOLLAR).toBe(100);
    expect(INCLUDED_CREDIT_RATIO_BPS.pro).toBe(6000);
    expect(INCLUDED_CREDIT_RATIO_BPS.business).toBe(6000);
  });

  it('MON-1 the ratio table is keyed by the canonical vocabulary; free derives nothing (0)', () => {
    expect(Object.keys(INCLUDED_CREDIT_RATIO_BPS).sort()).toEqual([...TIERS].sort());
    expect(INCLUDED_CREDIT_RATIO_BPS.free).toBe(0);
  });

  it('D-OW-17 MONEY_MODEL_V2_ACTIVE is a plain code constant, FALSE in this PR — migration day is a follow-up commit, never an env var', () => {
    expect(typeof MONEY_MODEL_V2_ACTIVE).toBe('boolean');
    expect(MONEY_MODEL_V2_ACTIVE).toBe(false);
  });

  it('D-OW-17 isMoneyModelV2Enabled() takes no argument and returns the constant directly', () => {
    expect(isMoneyModelV2Enabled.length).toBe(0);
    expect(isMoneyModelV2Enabled()).toBe(MONEY_MODEL_V2_ACTIVE);
  });
});

describe('D-OW-17 includedCreditRatioBps is a pure function of an explicit `active` flag', () => {
  it('active=true selects the real per-tier ratio; active=false selects the legacy 1:1 ratio — no env, no module reload needed to see both', () => {
    expect(includedCreditRatioBps('pro', true)).toBe(6000);
    expect(includedCreditRatioBps('business', true)).toBe(6000);
    expect(includedCreditRatioBps('pro', false)).toBe(10000);
    expect(includedCreditRatioBps('business', false)).toBe(10000);
  });

  it('the free tier and an unknown tier derive nothing regardless of active', () => {
    expect(includedCreditRatioBps('free', true)).toBe(0);
    expect(includedCreditRatioBps('free', false)).toBe(0);
    expect(includedCreditRatioBps('enterprise', true)).toBe(0);
    expect(includedCreditRatioBps('enterprise', false)).toBe(0);
  });

  it('defaults to MONEY_MODEL_V2_ACTIVE when active is omitted — this is "production passing the constant"', () => {
    expect(includedCreditRatioBps('pro')).toBe(includedCreditRatioBps('pro', MONEY_MODEL_V2_ACTIVE));
    expect(includedCreditRatioBps.length).toBe(1); // the default isn't a REQUIRED param
  });
});

describe('MON-2 the monthly allowance is derived from the amount paid, never tabulated', () => {
  it('MON-2 allowanceCentsForPaidCents = paidCents × ratio for every paid tier, with active=true', () => {
    for (const tier of TIERS) {
      if (tier === 'free') continue;
      const paid = TIER_PLAN_LIMITS[tier].priceMonthlyUsd * 100;
      const expected = Math.floor((paid * INCLUDED_CREDIT_RATIO_BPS[tier]) / 10000);
      expect(allowanceCentsForPaidCents(paid, tier, true), tier).toBe(expected);
    }
  });

  it('A-11 Pro $15 → 900 credits; Business $50 + 10 seats × $10 → 9,000 credits (Northwind Labs), with active=true', () => {
    expect(creditsFromCents(allowanceCentsForPaidCents(1500, 'pro', true))).toBe(900);
    expect(creditsFromCents(allowanceCentsForPaidCents(5000, 'business', true))).toBe(3000);
    expect(creditsFromCents(allowanceCentsForPaidCents(5000 + 10 * 1000, 'business', true))).toBe(9000);
    // One extra seat is $10 → 600 credits, so 6 extra seats add 3,600.
    expect(creditsFromCents(allowanceCentsForPaidCents(1000, 'business', true))).toBe(600);
  });

  it('MON-2 a promo or partial period flows through: a $12.34 invoice grants floor(1234 × 0.6) = 740¢, with active=true', () => {
    expect(allowanceCentsForPaidCents(1234, 'pro', true)).toBe(740);
    expect(allowanceCentsForPaidCents(0, 'pro', true)).toBe(0);
  });

  it('MON-2 the free tier and an unknown tier derive nothing from a payment, either active value', () => {
    expect(allowanceCentsForPaidCents(1500, 'free', true)).toBe(0);
    expect(allowanceCentsForPaidCents(1500, 'free', false)).toBe(0);
    expect(includedCreditRatioBps('enterprise', true)).toBe(0);
  });

  it('MON-2 a negative or non-finite paid amount grants nothing (never a negative allowance)', () => {
    expect(allowanceCentsForPaidCents(-1500, 'pro', true)).toBe(0);
    expect(allowanceCentsForPaidCents(Number.NaN, 'pro', true)).toBe(0);
  });

  it('MON-2 with active=false the ratio is the legacy 1:1 so balances compute as today (this PR\'s actual production behavior)', () => {
    expect(includedCreditRatioBps('pro', false)).toBe(10000);
    expect(allowanceCentsForPaidCents(1500, 'pro', false)).toBe(1500);
    expect(allowanceCentsForPaidCents(10000, 'business', false)).toBe(10000);
    // No third argument: production's actual call shape, defaulting to the FALSE constant.
    expect(allowanceCentsForPaidCents(1500, 'pro')).toBe(1500);
  });

  it('MON-2 tierAllowanceCents sizes a grant from the list price when there is no invoice, per tier, both active values', () => {
    for (const tier of TIERS) {
      if (tier === 'free') continue;
      const list = TIER_PLAN_LIMITS[tier].priceMonthlyUsd * 100;
      expect(tierAllowanceCents(tier, true), tier).toBe(allowanceCentsForPaidCents(list, tier, true));
      expect(tierAllowanceCents(tier, true), tier).toBeGreaterThan(0);
    }
    // No third argument (today's production shape): pro $15 → 1500¢.
    expect(tierAllowanceCents('pro')).toBe(1500);
  });
});

describe('MON-8 the free starter grant is a plain credit count, not derived from a price', () => {
  it('MON-8 FREE_STARTER_CREDITS is an integer credit count', () => {
    expect(Number.isInteger(FREE_STARTER_CREDITS)).toBe(true);
    expect(FREE_STARTER_CREDITS).toBeGreaterThan(0);
  });

  it('MON-8 tierAllowanceCents("free") is the starter grant in cents regardless of active or any price', () => {
    expect(tierAllowanceCents('free', true)).toBe(centsFromCredits(FREE_STARTER_CREDITS));
    expect(tierAllowanceCents('free', false)).toBe(tierAllowanceCents('free', true));
    // Today's $5 of starter value, unchanged.
    expect(tierAllowanceCents('free')).toBe(500);
  });

  it('MON-8 an unknown/legacy tier is treated as free for grant sizing (never a paid allowance)', () => {
    expect(tierAllowanceCents('enterprise', true)).toBe(tierAllowanceCents('free', true));
  });
});

describe('MON-5 one definition of a credit', () => {
  it('MON-5 a credit is CREDITS_PER_DOLLAR⁻¹ of a dollar: creditsFromCents / centsFromCredits round-trip', () => {
    expect(creditsFromCents(100)).toBe(CREDITS_PER_DOLLAR);
    expect(centsFromCredits(CREDITS_PER_DOLLAR)).toBe(100);
    for (const cents of [0, 1, 500, 1500, 123456]) {
      expect(centsFromCredits(creditsFromCents(cents))).toBe(cents);
    }
  });

  it('MON-5 centsFromCredits returns an exact integer for every whole credit count 0..10,000', () => {
    // Divide-then-multiply drifts: (7 / 100) * 100 is 7.000000000000001. Stripe rejects
    // a non-integer amount, and integer cents columns and equality checks break on it.
    for (let credits = 0; credits <= 10_000; credits++) {
      const cents = centsFromCredits(credits);
      if (!Number.isInteger(cents) || cents !== (credits * 100) / CREDITS_PER_DOLLAR) {
        expect.fail(`centsFromCredits(${credits}) returned ${cents}`);
      }
    }
    expect(centsFromCredits(7)).toBe(7);
  });

  it('MON-5 creditsFromCents returns an exact integer for every whole cent amount 0..10,000', () => {
    for (let cents = 0; cents <= 10_000; cents++) {
      const credits = creditsFromCents(cents);
      if (!Number.isInteger(credits) || credits !== (cents * CREDITS_PER_DOLLAR) / 100) {
        expect.fail(`creditsFromCents(${cents}) returned ${credits}`);
      }
    }
    expect(creditsFromCents(7)).toBe(7);
  });

  it('A-11 a $10 top-up pack is 1,000 credits at the full rate, no ratio applied', () => {
    expect(creditsFromCents(1000)).toBe(1000);
    expect(formatCreditCount(1000)).toBe('1,000');
  });

  it('MON-5 dollarsFromCents is the single cents→dollars conversion', () => {
    expect(dollarsFromCents(1050)).toBe(10.5);
    expect(formatDollars(1000)).toBe('$10');
    expect(formatDollars(1050)).toBe('$10.50');
    expect(formatDollars(0)).toBe('$0');
  });
});

describe('MON-5 formatCreditCount renders an integer count with thousands separators', () => {
  it('MON-5 formats the canvas numbers: 900, 1,200, 3,000, 9,000, 192', () => {
    expect(formatCreditCount(centsFromCredits(900))).toBe('900');
    expect(formatCreditCount(centsFromCredits(1200))).toBe('1,200');
    expect(formatCreditCount(centsFromCredits(3000))).toBe('3,000');
    expect(formatCreditCount(centsFromCredits(9000))).toBe('9,000');
    expect(formatCreditCount(centsFromCredits(192))).toBe('192');
    expect(formatCreditCount(0)).toBe('0');
  });

  it('MON-5 never shows decimals: fractional credits round to the nearest whole credit', () => {
    // 0.4 credits → "0"; 0.6 → "1"; 1,499.5 → "1,500" (half away from zero).
    expect(formatCreditCount(0.4)).toBe('0');
    expect(formatCreditCount(0.6)).toBe('1');
    expect(formatCreditCount(149950 / 100)).toBe('1,500');
    for (const cents of [0.4, 1, 150, 149950 / 100, 1234567]) {
      expect(formatCreditCount(cents)).not.toMatch(/\./);
    }
  });

  it('UI-12 never carries a dollar sign and negatives (overage) carry a leading minus', () => {
    expect(formatCreditCount(-5000)).toBe('-5,000');
    expect(formatCreditCount(-0.2)).toBe('0');
    for (const cents of [-5000, -1, 0, 1, 99, 100, 123456789]) {
      expect(formatCreditCount(cents)).not.toContain('$');
    }
  });
});

describe('MON-4 top-ups buy credits at CREDITS_PER_DOLLAR with no ratio; packs are credit counts', () => {
  it('MON-4 packs are defined as credit counts 1,000 / 2,500 / 5,000 and priced from the rate', () => {
    const packs = Object.values(CREDIT_PACKS).sort((a, b) => a.credits - b.credits);
    expect(packs.map((p) => p.credits)).toEqual([1000, 2500, 5000]);
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
    expect(CREDIT_TOPUP_MIN_CREDITS).toBe(500);
    expect(CREDIT_TOPUP_MAX_CREDITS).toBe(50_000);
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

  it('MON-4 a dollar amount buys credits at the full rate: $12.34 → 1,234 credits → 1234¢ charged', () => {
    expect(creditsFromDollars(12.34)).toBe(1234);
    expect(creditsFromDollars(10)).toBe(1000);
    expect(centsFromCredits(creditsFromDollars(12.34))).toBe(1234);
  });
});

describe('D-OW-17 no client-visible mirror, and no env var, of the flag (single source of truth: a code constant)', () => {
  it('exports no display/browser variant of the flag or the derivation — that whole mechanism is superseded by the constant', async () => {
    const mod: Record<string, unknown> = await import('../money-model');
    expect(mod.isMoneyModelV2EnabledForDisplay).toBeUndefined();
    expect(mod.tierAllowanceCentsForDisplay).toBeUndefined();
  });

  it('this module never reads process.env.MONEY_MODEL_V2 — the seam guard in __tests__/seams/credit-conversion.seam.test.ts enforces this repo-wide', () => {
    // A weaker, local echo of the seam: with the env var explicitly set to something
    // that would flip legacy env-based behavior, production's own call shape (no
    // active argument) must still return the FALSE-constant figures.
    const original = process.env.MONEY_MODEL_V2;
    process.env.MONEY_MODEL_V2 = 'true';
    try {
      expect(tierAllowanceCents('pro')).toBe(1500);
      expect(isMoneyModelV2Enabled()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.MONEY_MODEL_V2;
      else process.env.MONEY_MODEL_V2 = original;
    }
  });
});

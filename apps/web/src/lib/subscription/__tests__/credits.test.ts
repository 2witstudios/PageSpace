import { describe, it, expect } from 'vitest';
import {
  toDisplayCredits,
  formatCreditUnits,
  formatCreditUnitsSigned,
  formatCreditDollars,
  formatCreditDollarsSigned,
  centsToCredits,
  formatCreditCount,
  formatCreditCountSigned,
  MONTHLY_CREDITS,
  monthlyCreditsPhrase,
} from '../credits';

describe('toDisplayCredits', () => {
  it('returns 100 when cents equals allowance', () => {
    expect(toDisplayCredits(1500, 1500)).toBe(100);
  });

  it('returns 50 when cents is half the allowance', () => {
    expect(toDisplayCredits(750, 1500)).toBe(50);
  });

  it('returns 0 when cents is 0', () => {
    expect(toDisplayCredits(0, 1500)).toBe(0);
  });

  it('returns value greater than 100 when top-up pushes balance above allowance', () => {
    expect(toDisplayCredits(2500, 1500)).toBeCloseTo(166.67, 1);
  });

  it('returns negative value when spendable is negative (in debt)', () => {
    expect(toDisplayCredits(-300, 1500)).toBeCloseTo(-20, 1);
  });

  it('returns cents directly when allowanceCents is 0 (no monthly plan)', () => {
    expect(toDisplayCredits(500, 0)).toBe(500);
  });

  it('returns 0 when both cents and allowanceCents are 0', () => {
    expect(toDisplayCredits(0, 0)).toBe(0);
  });
});

describe('formatCreditUnits', () => {
  it('formats a full balance as "100.00"', () => {
    expect(formatCreditUnits(1500, 1500)).toBe('100.00');
  });

  it('formats a partial balance with 2 decimal places', () => {
    expect(formatCreditUnits(1493, 1500)).toBe('99.53');
  });

  it('formats zero as "0.00"', () => {
    expect(formatCreditUnits(0, 1500)).toBe('0.00');
  });

  it('formats a top-up overflow above 100', () => {
    expect(formatCreditUnits(3000, 1500)).toBe('200.00');
  });

  it('formats negative balances as negative strings', () => {
    expect(formatCreditUnits(-150, 1500)).toBe('-10.00');
  });

  it('returns "500.00" when allowanceCents is 0', () => {
    expect(formatCreditUnits(500, 0)).toBe('500.00');
  });
});

describe('formatCreditUnitsSigned', () => {
  it('formats a positive balance without a sign prefix', () => {
    expect(formatCreditUnitsSigned(1500, 1500)).toBe('100.00');
  });

  it('prefixes negative balance with a minus sign', () => {
    expect(formatCreditUnitsSigned(-300, 1500)).toBe('-20.00');
  });

  it('formats zero as "0.00" without a sign', () => {
    expect(formatCreditUnitsSigned(0, 1500)).toBe('0.00');
  });

  it('returns "500.00" when allowanceCents is 0', () => {
    expect(formatCreditUnitsSigned(500, 0)).toBe('500.00');
  });
});

describe('formatCreditDollars (existing helper — regression guard)', () => {
  it('formats whole dollars without decimals', () => {
    expect(formatCreditDollars(1000)).toBe('$10');
  });

  it('formats fractional dollars with 2 decimal places', () => {
    expect(formatCreditDollars(1050)).toBe('$10.50');
  });

  it('formats zero as "$0"', () => {
    expect(formatCreditDollars(0)).toBe('$0');
  });
});

describe('formatCreditDollarsSigned (existing helper — regression guard)', () => {
  it('formats negative cents with leading minus before the dollar sign', () => {
    expect(formatCreditDollarsSigned(-500)).toBe('-$5');
  });

  it('formats positive cents without a sign', () => {
    expect(formatCreditDollarsSigned(500)).toBe('$5');
  });
});

describe('centsToCredits', () => {
  it('converts free tier allowance to 5 credits', () => {
    expect(centsToCredits(500)).toBe(5);
  });

  it('converts pro tier allowance to 15 credits', () => {
    expect(centsToCredits(1500)).toBe(15);
  });

  it('converts zero cents to 0', () => {
    expect(centsToCredits(0)).toBe(0);
  });

  it('converts fractional credits', () => {
    expect(centsToCredits(50)).toBe(0.5);
  });
});

describe('formatCreditCount', () => {
  it('formats whole credit amounts as integers', () => {
    expect(formatCreditCount(500)).toBe('5');
    expect(formatCreditCount(1500)).toBe('15');
    expect(formatCreditCount(10000)).toBe('100');
  });

  it('formats fractional amounts to 1 decimal place', () => {
    expect(formatCreditCount(470)).toBe('4.7');
    expect(formatCreditCount(1493)).toBe('14.9');
  });

  it('formats zero as "0"', () => {
    expect(formatCreditCount(0)).toBe('0');
  });

  it('formats negative values as negative strings', () => {
    expect(formatCreditCount(-500)).toBe('-5');
  });
});

describe('formatCreditCountSigned', () => {
  it('formats positive values without a sign prefix', () => {
    expect(formatCreditCountSigned(500)).toBe('5');
    expect(formatCreditCountSigned(1493)).toBe('14.9');
  });

  it('prefixes negative values with a minus sign', () => {
    expect(formatCreditCountSigned(-500)).toBe('-5');
    expect(formatCreditCountSigned(-150)).toBe('-1.5');
  });

  it('formats zero without a sign', () => {
    expect(formatCreditCountSigned(0)).toBe('0');
  });
});

describe('MONTHLY_CREDITS (credit unit strings — regression guard)', () => {
  it('free tier shows 5 credits', () => {
    expect(MONTHLY_CREDITS.free).toBe('5');
  });

  it('pro tier shows 15 credits', () => {
    expect(MONTHLY_CREDITS.pro).toBe('15');
  });

  it('founder tier shows 50 credits', () => {
    expect(MONTHLY_CREDITS.founder).toBe('50');
  });

  it('business tier shows 100 credits', () => {
    expect(MONTHLY_CREDITS.business).toBe('100');
  });
});

describe('monthlyCreditsPhrase', () => {
  it('free tier phrase contains the credit count and the word "credits"', () => {
    expect(monthlyCreditsPhrase('free')).toContain(MONTHLY_CREDITS.free);
    expect(monthlyCreditsPhrase('free')).toContain('credits');
  });

  it('pro tier phrase contains the credit count and the word "credits"', () => {
    expect(monthlyCreditsPhrase('pro')).toContain(MONTHLY_CREDITS.pro);
    expect(monthlyCreditsPhrase('pro')).toContain('credits');
  });

  it('founder tier phrase contains the credit count and the word "credits"', () => {
    expect(monthlyCreditsPhrase('founder')).toContain(MONTHLY_CREDITS.founder);
    expect(monthlyCreditsPhrase('founder')).toContain('credits');
  });

  it('business tier phrase contains the credit count and the word "credits"', () => {
    expect(monthlyCreditsPhrase('business')).toContain(MONTHLY_CREDITS.business);
    expect(monthlyCreditsPhrase('business')).toContain('credits');
  });

  it('all non-free tiers produce a phrase with a multi-digit credit count', () => {
    for (const tier of ['pro', 'founder', 'business'] as const) {
      const phrase = monthlyCreditsPhrase(tier);
      const count = Number(MONTHLY_CREDITS[tier]);
      expect(count).toBeGreaterThan(1);
      expect(phrase).toContain(String(count));
    }
  });
});

import { describe, it, expect } from 'vitest';
import {
  toDisplayCredits,
  formatCreditUnits,
  formatCreditUnitsSigned,
  formatCreditDollars,
  formatCreditDollarsSigned,
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

  it('returns 0 when allowanceCents is 0 (guard against division by zero)', () => {
    expect(toDisplayCredits(500, 0)).toBe(0);
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

  it('returns "0.00" when allowanceCents is 0', () => {
    expect(formatCreditUnits(500, 0)).toBe('0.00');
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

  it('returns "0.00" when allowanceCents is 0', () => {
    expect(formatCreditUnitsSigned(500, 0)).toBe('0.00');
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

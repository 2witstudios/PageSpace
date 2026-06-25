import { describe, it, expect } from 'vitest';
import { DEFAULT_MINIMUM_AGE, computeAge, meetsMinimumAge } from '../age-gate';

describe('age-gate: computeAge', () => {
  it('does not count the current year birthday until it has passed', () => {
    // born 2008-06-25, reference 2026-06-24 → birthday not yet reached → 17
    expect(computeAge('2008-06-25', '2026-06-24')).toBe(17);
    // one day later, birthday reached → 18
    expect(computeAge('2008-06-25', '2026-06-25')).toBe(18);
  });

  it('returns null for a malformed/absent date of birth', () => {
    expect(computeAge('not-a-date', '2026-06-24')).toBeNull();
    expect(computeAge(undefined, '2026-06-24')).toBeNull();
    expect(computeAge('', '2026-06-24')).toBeNull();
  });
});

describe('age-gate: meetsMinimumAge', () => {
  it('uses Art 8 default minimum of 16', () => {
    expect(DEFAULT_MINIMUM_AGE).toBe(16);
  });

  it('rejects an age below the configured minimum', () => {
    // born 2011-01-01, reference 2026-06-24 → 15 → below 16
    expect(meetsMinimumAge('2011-01-01', '2026-06-24')).toBe(false);
    // exactly 16 → allowed
    expect(meetsMinimumAge('2010-01-01', '2026-06-24')).toBe(true);
  });

  it('fails closed for a malformed/absent date of birth', () => {
    expect(meetsMinimumAge(undefined, '2026-06-24')).toBe(false);
    expect(meetsMinimumAge('garbage', '2026-06-24')).toBe(false);
  });
});

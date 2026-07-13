import { describe, it, expect } from 'vitest';
import { deriveBadgeCount } from '../derive-badge-count';

describe('deriveBadgeCount', () => {
  it('returns 0 for 0', () => {
    expect(deriveBadgeCount(0)).toBe(0);
  });

  it('returns the same value for positive integers', () => {
    expect(deriveBadgeCount(5)).toBe(5);
    expect(deriveBadgeCount(1)).toBe(1);
  });

  it('clamps negative values to 0', () => {
    expect(deriveBadgeCount(-1)).toBe(0);
    expect(deriveBadgeCount(-100)).toBe(0);
  });

  it('truncates non-integer values toward 0', () => {
    expect(deriveBadgeCount(3.7)).toBe(3);
    expect(deriveBadgeCount(3.2)).toBe(3);
    expect(deriveBadgeCount(-3.7)).toBe(0);
  });
});

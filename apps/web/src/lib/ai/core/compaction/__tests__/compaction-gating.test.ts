import { describe, it, expect } from 'vitest';
import { canUseCompaction } from '../compaction-gating';

describe('canUseCompaction', () => {
  it('grants any authenticated user regardless of role', () => {
    expect(canUseCompaction({ role: 'admin' })).toBe(true);
    expect(canUseCompaction({ role: 'user' })).toBe(true);
    expect(canUseCompaction({ role: null })).toBe(true);
    expect(canUseCompaction({})).toBe(true);
  });

  it('denies unauthenticated callers (null or undefined)', () => {
    expect(canUseCompaction(null)).toBe(false);
    expect(canUseCompaction(undefined)).toBe(false);
  });
});

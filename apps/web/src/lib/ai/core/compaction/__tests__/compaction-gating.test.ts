import { describe, it, expect } from 'vitest';
import { canUseCompaction } from '../compaction-gating';

describe('canUseCompaction', () => {
  it('grants admin accounts', () => {
    expect(canUseCompaction({ role: 'admin' })).toBe(true);
  });

  it('denies regular users', () => {
    expect(canUseCompaction({ role: 'user' })).toBe(false);
  });

  it('denies when role is missing, null, or user is absent', () => {
    expect(canUseCompaction({})).toBe(false);
    expect(canUseCompaction({ role: null })).toBe(false);
    expect(canUseCompaction(null)).toBe(false);
    expect(canUseCompaction(undefined)).toBe(false);
  });

  it('is case-sensitive — only the exact "admin" slug widens the gate', () => {
    expect(canUseCompaction({ role: 'Admin' })).toBe(false);
    expect(canUseCompaction({ role: 'ADMIN' })).toBe(false);
  });
});

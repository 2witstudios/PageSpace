import { describe, it, expect } from 'vitest';
import { canUseAskUser } from '../ask-user-gating';

describe('canUseAskUser', () => {
  it('grants app admins only', () => {
    expect(canUseAskUser({ role: 'admin' })).toBe(true);
  });

  it('denies non-admin roles', () => {
    expect(canUseAskUser({ role: 'user' })).toBe(false);
    expect(canUseAskUser({ role: 'member' })).toBe(false);
  });

  it('denies missing/null role or user', () => {
    expect(canUseAskUser({ role: null })).toBe(false);
    expect(canUseAskUser({})).toBe(false);
    expect(canUseAskUser(null)).toBe(false);
    expect(canUseAskUser(undefined)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { canUseAskUser } from '../ask-user-gating';

describe('canUseAskUser', () => {
  it('grants any authenticated user regardless of role', () => {
    expect(canUseAskUser({ role: 'admin' })).toBe(true);
    expect(canUseAskUser({ role: 'user' })).toBe(true);
    expect(canUseAskUser({ role: 'member' })).toBe(true);
    expect(canUseAskUser({ role: null })).toBe(true);
    expect(canUseAskUser({})).toBe(true);
  });

  it('denies missing user', () => {
    expect(canUseAskUser(null)).toBe(false);
    expect(canUseAskUser(undefined)).toBe(false);
  });
});

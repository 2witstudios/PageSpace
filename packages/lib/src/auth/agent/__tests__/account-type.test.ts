/** ADR 0007 Decision 1 — the one discriminator between humans and agents. */
import { describe, it, expect } from 'vitest';
import { ACCOUNT_TYPES, isAccountType, type AccountType } from '../account-type';

describe('AccountType', () => {
  it('is exactly human and agent, human first (the pgEnum order and default)', () => {
    expect(ACCOUNT_TYPES).toEqual(['human', 'agent']);
  });

  it('isAccountType narrows unknown values', () => {
    expect(isAccountType('human')).toBe(true);
    expect(isAccountType('agent')).toBe(true);
    expect(isAccountType('bot')).toBe(false);
    expect(isAccountType('')).toBe(false);
    expect(isAccountType(null)).toBe(false);
    expect(isAccountType(undefined)).toBe(false);
    expect(isAccountType(1)).toBe(false);
    const narrowed: unknown = 'agent';
    if (isAccountType(narrowed)) {
      const t: AccountType = narrowed;
      expect(t).toBe('agent');
    }
  });
});

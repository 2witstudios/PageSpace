import { describe, it, expect } from 'vitest';
import { canUseCommands } from '../command-gating';

describe('canUseCommands', () => {
  it('given an admin user, should expose the command UI', () => {
    expect(canUseCommands({ role: 'admin' })).toBe(true);
  });

  it('given a non-admin user, should hide the command UI (/ is plain text)', () => {
    expect(canUseCommands({ role: 'user' })).toBe(false);
  });

  it('given a user with no role, should hide the command UI', () => {
    expect(canUseCommands({})).toBe(false);
  });

  it('given no user (logged out / loading), should hide the command UI', () => {
    expect(canUseCommands(null)).toBe(false);
    expect(canUseCommands(undefined)).toBe(false);
  });
});

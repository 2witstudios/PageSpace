import { describe, it, expect } from 'vitest';
import { canUseCommands, canManageDriveCommands } from '../command-gating';

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

describe('canManageDriveCommands (spec §4.1, same predicate as the drive hub)', () => {
  it('is true for the drive owner', () => {
    expect(canManageDriveCommands({ isOwned: true, role: null })).toBe(true);
  });

  it('is true for a drive ADMIN', () => {
    expect(canManageDriveCommands({ isOwned: false, role: 'ADMIN' })).toBe(true);
  });

  it('is false for plain members', () => {
    expect(canManageDriveCommands({ isOwned: false, role: 'MEMBER' })).toBe(false);
  });

  it('is false when the drive is unknown', () => {
    expect(canManageDriveCommands(null)).toBe(false);
    expect(canManageDriveCommands(undefined)).toBe(false);
  });
});

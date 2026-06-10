import { describe, it, expect } from 'vitest';
import { canSeeCommandSettings, canManageDriveCommands } from '../command-gating';

describe('canSeeCommandSettings (launch exposure gate, spec §0)', () => {
  it('is true only for admin accounts', () => {
    expect(canSeeCommandSettings({ role: 'admin' })).toBe(true);
  });

  it('is false for regular users', () => {
    expect(canSeeCommandSettings({ role: 'user' })).toBe(false);
  });

  it('is false for missing/unknown users', () => {
    expect(canSeeCommandSettings(null)).toBe(false);
    expect(canSeeCommandSettings(undefined)).toBe(false);
    expect(canSeeCommandSettings({})).toBe(false);
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

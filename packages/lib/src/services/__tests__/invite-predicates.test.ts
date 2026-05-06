import { describe, it, expect } from 'vitest';
import {
  isInviteExpired,
  isInviteConsumed,
  isEmailMatchingInvite,
} from '../invite-predicates';

describe('isInviteExpired', () => {
  it('returns false when expiresAt is one ms after now', () => {
    const now = new Date('2026-05-06T00:00:00.000Z');
    const expiresAt = new Date('2026-05-06T00:00:00.001Z');
    expect(isInviteExpired({ expiresAt, now })).toBe(false);
  });

  it('returns true when expiresAt equals now (boundary expired)', () => {
    const now = new Date('2026-05-06T00:00:00.000Z');
    const expiresAt = new Date('2026-05-06T00:00:00.000Z');
    expect(isInviteExpired({ expiresAt, now })).toBe(true);
  });

  it('returns true when expiresAt is one ms before now', () => {
    const now = new Date('2026-05-06T00:00:00.001Z');
    const expiresAt = new Date('2026-05-06T00:00:00.000Z');
    expect(isInviteExpired({ expiresAt, now })).toBe(true);
  });
});

describe('isInviteConsumed', () => {
  it('returns false when consumedAt is null', () => {
    expect(isInviteConsumed({ consumedAt: null })).toBe(false);
  });

  it('returns true when consumedAt is a Date', () => {
    expect(isInviteConsumed({ consumedAt: new Date('2026-05-06T00:00:00.000Z') })).toBe(true);
  });
});

describe('isEmailMatchingInvite', () => {
  it('returns true when emails are exactly equal', () => {
    expect(
      isEmailMatchingInvite({
        inviteEmail: 'jane@example.com',
        userEmail: 'jane@example.com',
      })
    ).toBe(true);
  });

  it('returns true when emails differ only by case', () => {
    expect(
      isEmailMatchingInvite({
        inviteEmail: 'Jane@Example.com',
        userEmail: 'jane@example.com',
      })
    ).toBe(true);
  });

  it('returns true when emails differ only by surrounding whitespace', () => {
    expect(
      isEmailMatchingInvite({
        inviteEmail: '  jane@example.com  ',
        userEmail: 'jane@example.com',
      })
    ).toBe(true);
  });

  it('returns true when emails differ by both case and whitespace', () => {
    expect(
      isEmailMatchingInvite({
        inviteEmail: '  Jane@Example.com\n',
        userEmail: 'jane@example.com',
      })
    ).toBe(true);
  });

  it('returns false when local part differs', () => {
    expect(
      isEmailMatchingInvite({
        inviteEmail: 'jane@example.com',
        userEmail: 'bob@example.com',
      })
    ).toBe(false);
  });

  it('returns false when domain differs', () => {
    expect(
      isEmailMatchingInvite({
        inviteEmail: 'jane@example.com',
        userEmail: 'jane@other.com',
      })
    ).toBe(false);
  });
});

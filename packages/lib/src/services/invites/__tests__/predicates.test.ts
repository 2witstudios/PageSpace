import { describe, it, expect } from 'vitest';
import {
  isInviteExpired,
  isInviteConsumed,
  isEmailMatch,
  isAccountSuspended,
} from '../predicates';

describe('isInviteExpired', () => {
  const now = new Date('2026-05-06T12:00:00.000Z');

  it('given now equals expiresAt, should return true (boundary)', () => {
    expect(isInviteExpired({ expiresAt: new Date(now.getTime()), now })).toBe(true);
  });

  it('given now is one millisecond before expiresAt, should return false', () => {
    expect(isInviteExpired({ expiresAt: new Date(now.getTime() + 1), now })).toBe(false);
  });

  it('given now is one millisecond after expiresAt, should return true', () => {
    expect(isInviteExpired({ expiresAt: new Date(now.getTime() - 1), now })).toBe(true);
  });

  it('given expiresAt is far in the future, should return false', () => {
    expect(
      isInviteExpired({ expiresAt: new Date('2099-01-01T00:00:00.000Z'), now }),
    ).toBe(false);
  });

  it('given expiresAt is far in the past, should return true', () => {
    expect(
      isInviteExpired({ expiresAt: new Date('2000-01-01T00:00:00.000Z'), now }),
    ).toBe(true);
  });
});

describe('isInviteConsumed', () => {
  it('given consumedAt is null, should return false', () => {
    expect(isInviteConsumed({ consumedAt: null })).toBe(false);
  });

  it('given consumedAt is a Date, should return true', () => {
    expect(isInviteConsumed({ consumedAt: new Date() })).toBe(true);
  });

  it('given consumedAt is the unix epoch, should still return true', () => {
    expect(isInviteConsumed({ consumedAt: new Date(0) })).toBe(true);
  });
});

describe('isEmailMatch', () => {
  it('given identical lowercase emails, should return true', () => {
    expect(
      isEmailMatch({ inviteEmail: 'invitee@example.com', userEmail: 'invitee@example.com' }),
    ).toBe(true);
  });

  it('given emails differing only by case, should return true', () => {
    expect(
      isEmailMatch({ inviteEmail: 'Invitee@Example.com', userEmail: 'invitee@example.COM' }),
    ).toBe(true);
  });

  it('given emails with leading/trailing whitespace, should return true', () => {
    expect(
      isEmailMatch({ inviteEmail: '  invitee@example.com  ', userEmail: '\tinvitee@example.com\n' }),
    ).toBe(true);
  });

  it('given case + whitespace differences combined, should return true', () => {
    expect(
      isEmailMatch({ inviteEmail: '  INVITEE@EXAMPLE.COM ', userEmail: 'invitee@example.com' }),
    ).toBe(true);
  });

  it('given different local-parts, should return false', () => {
    expect(
      isEmailMatch({ inviteEmail: 'invitee@example.com', userEmail: 'someone-else@example.com' }),
    ).toBe(false);
  });

  it('given different domains, should return false', () => {
    expect(
      isEmailMatch({ inviteEmail: 'invitee@example.com', userEmail: 'invitee@other.com' }),
    ).toBe(false);
  });

  it('given empty strings on both sides, should return true', () => {
    expect(isEmailMatch({ inviteEmail: '', userEmail: '' })).toBe(true);
  });
});

describe('isAccountSuspended', () => {
  it('given suspendedAt is null, should return false', () => {
    expect(isAccountSuspended({ suspendedAt: null })).toBe(false);
  });

  it('given suspendedAt is a Date, should return true', () => {
    expect(isAccountSuspended({ suspendedAt: new Date() })).toBe(true);
  });

  it('given suspendedAt is the unix epoch, should still return true (suspension is binary on presence)', () => {
    expect(isAccountSuspended({ suspendedAt: new Date(0) })).toBe(true);
  });
});

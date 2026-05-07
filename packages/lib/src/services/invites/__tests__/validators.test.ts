import { describe, it, expect } from 'vitest';
import {
  validateInviteForUser,
  validateMagicLinkRequest,
  validateRevokeRequest,
} from '../validators';
import type { Invite, UserAccount } from '../types';

const baseInvite = (overrides: Partial<Invite> = {}): Invite => ({
  id: 'inv_1',
  email: 'invitee@example.com',
  driveId: 'drive_1',
  driveName: 'Acme',
  role: 'MEMBER',
  invitedBy: 'user_inviter',
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  consumedAt: null,
  ...overrides,
});

describe('validateInviteForUser', () => {
  const now = new Date('2026-05-06T12:00:00.000Z');
  const userEmail = 'invitee@example.com';

  it('given a fresh invite for the same email and an active user, should return ok with the invite', () => {
    expect(
      validateInviteForUser({ invite: baseInvite(), userEmail, suspendedAt: null, now }),
    ).toEqual({ ok: true, data: baseInvite() });
  });

  it('given a suspended user, should return ACCOUNT_SUSPENDED before any other check', () => {
    const result = validateInviteForUser({
      invite: baseInvite({ consumedAt: now, expiresAt: new Date(0) }),
      userEmail: 'wrong@example.com',
      suspendedAt: new Date('2026-01-01'),
      now,
    });
    expect(result).toEqual({ ok: false, error: 'ACCOUNT_SUSPENDED' });
  });

  it('given a consumed invite, should return TOKEN_CONSUMED', () => {
    const result = validateInviteForUser({
      invite: baseInvite({ consumedAt: new Date('2026-04-01') }),
      userEmail,
      suspendedAt: null,
      now,
    });
    expect(result).toEqual({ ok: false, error: 'TOKEN_CONSUMED' });
  });

  it('given an expired invite, should return TOKEN_EXPIRED', () => {
    const result = validateInviteForUser({
      invite: baseInvite({ expiresAt: new Date('2026-01-01') }),
      userEmail,
      suspendedAt: null,
      now,
    });
    expect(result).toEqual({ ok: false, error: 'TOKEN_EXPIRED' });
  });

  it('given an email mismatch, should return EMAIL_MISMATCH', () => {
    const result = validateInviteForUser({
      invite: baseInvite(),
      userEmail: 'someone-else@example.com',
      suspendedAt: null,
      now,
    });
    expect(result).toEqual({ ok: false, error: 'EMAIL_MISMATCH' });
  });

  it('given consumed AND expired, should return TOKEN_CONSUMED (consumed wins)', () => {
    const result = validateInviteForUser({
      invite: baseInvite({ consumedAt: now, expiresAt: new Date(0) }),
      userEmail,
      suspendedAt: null,
      now,
    });
    expect(result).toEqual({ ok: false, error: 'TOKEN_CONSUMED' });
  });

  it('given expired AND email mismatch, should return TOKEN_EXPIRED (expiry wins)', () => {
    const result = validateInviteForUser({
      invite: baseInvite({ expiresAt: new Date(0) }),
      userEmail: 'wrong@example.com',
      suspendedAt: null,
      now,
    });
    expect(result).toEqual({ ok: false, error: 'TOKEN_EXPIRED' });
  });
});

describe('validateMagicLinkRequest', () => {
  it('given user is null, should return NO_ACCOUNT_FOUND', () => {
    expect(validateMagicLinkRequest({ user: null })).toEqual({
      ok: false,
      error: 'NO_ACCOUNT_FOUND',
    });
  });

  it('given a suspended user, should return ACCOUNT_SUSPENDED', () => {
    const user: UserAccount = { id: 'u_1', suspendedAt: new Date('2026-04-01') };
    expect(validateMagicLinkRequest({ user })).toEqual({
      ok: false,
      error: 'ACCOUNT_SUSPENDED',
    });
  });

  it('given an active user (suspendedAt null), should return ok with the user', () => {
    const user: UserAccount = { id: 'u_1', suspendedAt: null };
    expect(validateMagicLinkRequest({ user })).toEqual({ ok: true, data: user });
  });
});

describe('validateRevokeRequest', () => {
  const requestedDriveId = 'drive_1';
  const inviteRow = {
    id: 'inv_1',
    email: 'pending@example.com',
    role: 'MEMBER' as const,
    driveId: 'drive_1',
  };

  it('given invite is null, should return NOT_FOUND', () => {
    expect(
      validateRevokeRequest({
        invite: null,
        requestedDriveId,
        actorMembership: { role: 'OWNER', acceptedAt: new Date() },
      }),
    ).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('given invite belongs to a different drive than requested, should return NOT_FOUND', () => {
    expect(
      validateRevokeRequest({
        invite: { ...inviteRow, driveId: 'drive_other' },
        requestedDriveId,
        actorMembership: { role: 'OWNER', acceptedAt: new Date() },
      }),
    ).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('given actor has no membership on the drive, should return FORBIDDEN', () => {
    expect(
      validateRevokeRequest({
        invite: inviteRow,
        requestedDriveId,
        actorMembership: null,
      }),
    ).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('given an accepted MEMBER actor, should return FORBIDDEN (only OWNER/ADMIN can revoke)', () => {
    expect(
      validateRevokeRequest({
        invite: inviteRow,
        requestedDriveId,
        actorMembership: { role: 'MEMBER', acceptedAt: new Date() },
      }),
    ).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('given an ADMIN actor with acceptedAt null (pending), should return FORBIDDEN', () => {
    expect(
      validateRevokeRequest({
        invite: inviteRow,
        requestedDriveId,
        actorMembership: { role: 'ADMIN', acceptedAt: null },
      }),
    ).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('given an OWNER with acceptedAt null, should return FORBIDDEN (strict gate, matches drive-member-gate-coverage)', () => {
    expect(
      validateRevokeRequest({
        invite: inviteRow,
        requestedDriveId,
        actorMembership: { role: 'OWNER', acceptedAt: null },
      }),
    ).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('given an accepted OWNER, should return ok with the invite', () => {
    expect(
      validateRevokeRequest({
        invite: inviteRow,
        requestedDriveId,
        actorMembership: { role: 'OWNER', acceptedAt: new Date() },
      }),
    ).toEqual({ ok: true, data: inviteRow });
  });

  it('given an accepted ADMIN, should return ok with the invite', () => {
    expect(
      validateRevokeRequest({
        invite: inviteRow,
        requestedDriveId,
        actorMembership: { role: 'ADMIN', acceptedAt: new Date() },
      }),
    ).toEqual({ ok: true, data: inviteRow });
  });
});

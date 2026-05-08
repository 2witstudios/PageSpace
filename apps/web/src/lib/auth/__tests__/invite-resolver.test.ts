import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findPendingInviteByTokenHash: vi.fn(),
    loadUserAccountByEmail: vi.fn(),
  },
}));

vi.mock('@/lib/repositories/connection-invite-repository', () => ({
  connectionInviteRepository: {
    findPendingInviteByTokenHash: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/auth/token-utils', () => ({
  hashToken: vi.fn((t: string) => `hash(${t})`),
}));

import { resolveInviteContext } from '../invite-resolver';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { connectionInviteRepository } from '@/lib/repositories/connection-invite-repository';

const now = new Date('2026-05-06T12:00:00.000Z');

const baseDriveInvite = {
  id: 'inv_1',
  email: 'invitee@example.com',
  driveId: 'drive_1',
  role: 'MEMBER' as const,
  invitedBy: 'inviter_1',
  expiresAt: new Date('2026-05-08T12:00:00.000Z'),
  consumedAt: null as Date | null,
  driveName: 'Alpha',
  inviterName: 'Jane',
};

const baseConnectionInvite = {
  id: 'cinv_1',
  email: 'invitee@example.com',
  invitedBy: 'inviter_1',
  inviterName: 'Bob',
  requestMessage: null as string | null,
  expiresAt: new Date('2026-05-08T12:00:00.000Z'),
  consumedAt: null as Date | null,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: both repos return null (no invite found)
  vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(null);
  vi.mocked(connectionInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(null);
});

describe('resolveInviteContext', () => {
  it('given a token that does not match any pending row, returns NOT_FOUND', async () => {
    const result = await resolveInviteContext({ token: 'garbage', now });

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('given a drive row whose consumedAt is set, returns CONSUMED', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue({
      ...baseDriveInvite,
      consumedAt: new Date('2026-05-06T11:00:00.000Z'),
    });

    const result = await resolveInviteContext({ token: 'tok', now });

    expect(result).toEqual({ ok: false, error: 'CONSUMED' });
  });

  it('given a drive row whose expiresAt is in the past, returns EXPIRED', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue({
      ...baseDriveInvite,
      expiresAt: new Date('2026-05-06T11:00:00.000Z'),
    });

    const result = await resolveInviteContext({ token: 'tok', now });

    expect(result).toEqual({ ok: false, error: 'EXPIRED' });
  });

  it('given an active drive row + existing user, returns ok drive context with isExistingUser=true', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseDriveInvite);
    vi.mocked(driveInviteRepository.loadUserAccountByEmail).mockResolvedValue({
      id: 'user_1',
      suspendedAt: null,
    });

    const result = await resolveInviteContext({ token: 'tok', now });

    expect(result).toEqual({
      ok: true,
      data: {
        kind: 'drive',
        driveName: 'Alpha',
        inviterName: 'Jane',
        role: 'MEMBER',
        email: 'invitee@example.com',
        isExistingUser: true,
      },
    });
  });

  it('given an active drive row + a user record exists with tosAcceptedAt null (OAuth / magic-link user), returns ok with isExistingUser=true', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseDriveInvite);
    vi.mocked(driveInviteRepository.loadUserAccountByEmail).mockResolvedValue({
      id: 'user_oauth',
      suspendedAt: null,
    });

    const result = await resolveInviteContext({ token: 'tok', now });

    // Classification is by account presence, not ToS state — OAuth/magic-link
    // users have null tosAcceptedAt yet must be routed through the existing-
    // user CTA, otherwise signup returns EMAIL_EXISTS and the invite becomes
    // unclaimable.
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ isExistingUser: true }),
    });
  });

  it('given an active drive row + no user mapped to that email, returns ok with isExistingUser=false', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseDriveInvite);
    vi.mocked(driveInviteRepository.loadUserAccountByEmail).mockResolvedValue(null);

    const result = await resolveInviteContext({ token: 'tok', now });

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ isExistingUser: false }),
    });
  });

  it('given a token, looks up by SHA3 hash (never plaintext)', async () => {
    await resolveInviteContext({ token: 'ps_invite_abc', now });

    expect(driveInviteRepository.findPendingInviteByTokenHash).toHaveBeenCalledWith(
      'hash(ps_invite_abc)'
    );
    expect(connectionInviteRepository.findPendingInviteByTokenHash).toHaveBeenCalledWith(
      'hash(ps_invite_abc)'
    );
  });

  describe('connection invite tokens', () => {
    it('given an active connection row + no existing user, returns ok connection context with isExistingUser=false', async () => {
      vi.mocked(connectionInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(
        baseConnectionInvite
      );
      vi.mocked(driveInviteRepository.loadUserAccountByEmail).mockResolvedValue(null);

      const result = await resolveInviteContext({ token: 'tok', now });

      expect(result).toEqual({
        ok: true,
        data: {
          kind: 'connection',
          inviterName: 'Bob',
          email: 'invitee@example.com',
          isExistingUser: false,
          message: null,
        },
      });
    });

    it('given an active connection row + existing user, returns ok connection context with isExistingUser=true', async () => {
      vi.mocked(connectionInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(
        baseConnectionInvite
      );
      vi.mocked(driveInviteRepository.loadUserAccountByEmail).mockResolvedValue({
        id: 'user_1',
        suspendedAt: null,
      });

      const result = await resolveInviteContext({ token: 'tok', now });

      expect(result).toEqual({
        ok: true,
        data: expect.objectContaining({ kind: 'connection', isExistingUser: true }),
      });
    });

    it('includes the optional requestMessage in connection context', async () => {
      vi.mocked(connectionInviteRepository.findPendingInviteByTokenHash).mockResolvedValue({
        ...baseConnectionInvite,
        requestMessage: 'Hey, let\'s connect!',
      });
      vi.mocked(driveInviteRepository.loadUserAccountByEmail).mockResolvedValue(null);

      const result = await resolveInviteContext({ token: 'tok', now });

      expect(result).toEqual({
        ok: true,
        data: expect.objectContaining({ message: 'Hey, let\'s connect!' }),
      });
    });

    it('given a connection row whose consumedAt is set, returns CONSUMED', async () => {
      vi.mocked(connectionInviteRepository.findPendingInviteByTokenHash).mockResolvedValue({
        ...baseConnectionInvite,
        consumedAt: new Date('2026-05-06T11:00:00.000Z'),
      });

      const result = await resolveInviteContext({ token: 'tok', now });

      expect(result).toEqual({ ok: false, error: 'CONSUMED' });
    });

    it('given a connection row whose expiresAt is in the past, returns EXPIRED', async () => {
      vi.mocked(connectionInviteRepository.findPendingInviteByTokenHash).mockResolvedValue({
        ...baseConnectionInvite,
        expiresAt: new Date('2026-05-06T11:00:00.000Z'),
      });

      const result = await resolveInviteContext({ token: 'tok', now });

      expect(result).toEqual({ ok: false, error: 'EXPIRED' });
    });
  });
});

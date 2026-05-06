import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findPendingInviteByTokenHash: vi.fn(),
    consumeInviteAndCreateMembership: vi.fn(),
    findExistingMember: vi.fn(),
  },
}));

import { acceptInviteForExistingUser } from '../invite-acceptance';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

const NOW = new Date('2026-05-06T00:00:00.000Z');
const FUTURE = new Date('2026-05-08T00:00:00.000Z');

const baseInvite = {
  id: 'inv_1',
  driveId: 'drive_1',
  email: 'jane@example.com',
  role: 'MEMBER' as const,
  expiresAt: FUTURE,
  consumedAt: null as Date | null,
  invitedBy: 'user_alice',
  driveName: 'Acme',
  inviterName: 'Alice',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null as never);
  vi.mocked(driveInviteRepository.consumeInviteAndCreateMembership).mockResolvedValue({
    memberId: 'mem_new',
  });
});

describe('acceptInviteForExistingUser', () => {
  it('returns EMAIL_MISMATCH when authenticated user email differs from invite email', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseInvite);
    const result = await acceptInviteForExistingUser({
      token: 'ps_invite_x',
      userId: 'user_eve',
      userEmail: 'eve@example.com',
      now: NOW,
    });
    expect(result).toEqual({ ok: false, error: 'EMAIL_MISMATCH' });
    expect(driveInviteRepository.consumeInviteAndCreateMembership).not.toHaveBeenCalled();
  });

  it('returns ALREADY_MEMBER when the user is already an accepted member of the drive', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseInvite);
    vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue({
      id: 'mem_existing',
      acceptedAt: new Date('2025-01-01'),
    } as never);
    const result = await acceptInviteForExistingUser({
      token: 'ps_invite_x',
      userId: 'user_jane',
      userEmail: 'jane@example.com',
      now: NOW,
    });
    expect(result).toEqual({ ok: false, error: 'ALREADY_MEMBER' });
    expect(driveInviteRepository.consumeInviteAndCreateMembership).not.toHaveBeenCalled();
  });

  it('consumes the invite and inserts driveMembers transactionally on the happy path', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseInvite);
    const result = await acceptInviteForExistingUser({
      token: 'ps_invite_x',
      userId: 'user_jane',
      userEmail: 'jane@example.com',
      now: NOW,
    });
    expect(result).toEqual({
      ok: true,
      data: { driveId: 'drive_1', driveName: 'Acme', memberId: 'mem_new' },
    });
    expect(driveInviteRepository.consumeInviteAndCreateMembership).toHaveBeenCalledWith({
      inviteId: 'inv_1',
      legacyMemberId: null,
      driveId: 'drive_1',
      userId: 'user_jane',
      role: 'MEMBER',
      invitedBy: 'user_alice',
      acceptedAt: NOW,
    });
  });

  it('passes legacy pending drive_members id (acceptedAt=null) so the helper deletes it inside the transaction', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseInvite);
    vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue({
      id: 'mem_legacy_pending',
      acceptedAt: null,
    } as never);

    const result = await acceptInviteForExistingUser({
      token: 'ps_invite_x',
      userId: 'user_jane',
      userEmail: 'jane@example.com',
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(driveInviteRepository.consumeInviteAndCreateMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteId: 'inv_1',
        legacyMemberId: 'mem_legacy_pending',
        driveId: 'drive_1',
        userId: 'user_jane',
        acceptedAt: NOW,
      })
    );
  });

  it('returns TOKEN_NOT_FOUND when no invite matches the hash', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(null);
    const result = await acceptInviteForExistingUser({
      token: 'ps_invite_x',
      userId: 'user_jane',
      userEmail: 'jane@example.com',
      now: NOW,
    });
    expect(result).toEqual({ ok: false, error: 'TOKEN_NOT_FOUND' });
  });
});

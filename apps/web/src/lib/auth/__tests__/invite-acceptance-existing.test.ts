import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findPendingInviteByTokenHash: vi.fn(),
    markInviteConsumed: vi.fn(),
    createDriveMember: vi.fn(),
    findUserVerificationStatusById: vi.fn(),
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
  vi.mocked(driveInviteRepository.markInviteConsumed).mockResolvedValue(true);
  vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null as never);
  vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue({
    id: 'mem_new',
    driveId: 'drive_1',
    userId: 'user_jane',
    role: 'MEMBER',
    customRoleId: null,
    invitedBy: 'user_alice',
    invitedAt: NOW,
    acceptedAt: NOW,
    lastAccessedAt: null,
  } as never);
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
    expect(driveInviteRepository.markInviteConsumed).not.toHaveBeenCalled();
    expect(driveInviteRepository.createDriveMember).not.toHaveBeenCalled();
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
    expect(driveInviteRepository.markInviteConsumed).not.toHaveBeenCalled();
    expect(driveInviteRepository.createDriveMember).not.toHaveBeenCalled();
  });

  it('consumes the invite and inserts driveMembers with acceptedAt=now on the happy path', async () => {
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
    expect(driveInviteRepository.markInviteConsumed).toHaveBeenCalledWith('inv_1');
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

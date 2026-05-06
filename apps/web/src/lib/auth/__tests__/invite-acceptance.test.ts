import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findPendingInviteByTokenHash: vi.fn(),
    consumeInviteAndCreateMembership: vi.fn(),
    findExistingMember: vi.fn(),
  },
}));

import { acceptInviteForNewUser } from '../invite-acceptance';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

const NOW = new Date('2026-05-06T00:00:00.000Z');
const FUTURE = new Date('2026-05-08T00:00:00.000Z');
const PAST = new Date('2026-05-05T00:00:00.000Z');

const baseInvite = {
  id: 'inv_1',
  driveId: 'drive_1',
  email: 'jane@example.com',
  role: 'MEMBER' as const,
  expiresAt: FUTURE,
  consumedAt: null,
  invitedBy: 'user_alice',
  driveName: 'Acme',
  inviterName: 'Alice',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(driveInviteRepository.consumeInviteAndCreateMembership).mockResolvedValue({
    memberId: 'mem_new',
  });
});

describe('acceptInviteForNewUser', () => {
  it('returns TOKEN_NOT_FOUND when no invite matches the hash', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(null);
    const result = await acceptInviteForNewUser({
      token: 'ps_invite_x',
      userId: 'user_jane',
      userEmail: 'jane@example.com',
      now: NOW,
    });
    expect(result).toEqual({ ok: false, error: 'TOKEN_NOT_FOUND' });
    expect(driveInviteRepository.consumeInviteAndCreateMembership).not.toHaveBeenCalled();
  });

  it('returns TOKEN_CONSUMED when consumedAt is non-null at lookup time', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue({
      ...baseInvite,
      consumedAt: new Date('2026-05-05T12:00:00.000Z'),
    });
    const result = await acceptInviteForNewUser({
      token: 'ps_invite_x',
      userId: 'user_jane',
      userEmail: 'jane@example.com',
      now: NOW,
    });
    expect(result).toEqual({ ok: false, error: 'TOKEN_CONSUMED' });
    expect(driveInviteRepository.consumeInviteAndCreateMembership).not.toHaveBeenCalled();
  });

  it('returns TOKEN_EXPIRED when expiresAt is in the past', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue({
      ...baseInvite,
      expiresAt: PAST,
    });
    const result = await acceptInviteForNewUser({
      token: 'ps_invite_x',
      userId: 'user_jane',
      userEmail: 'jane@example.com',
      now: NOW,
    });
    expect(result).toEqual({ ok: false, error: 'TOKEN_EXPIRED' });
    expect(driveInviteRepository.consumeInviteAndCreateMembership).not.toHaveBeenCalled();
  });

  it('returns EMAIL_MISMATCH when signed-up email differs from invite email', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseInvite);
    const result = await acceptInviteForNewUser({
      token: 'ps_invite_x',
      userId: 'user_eve',
      userEmail: 'eve@example.com',
      now: NOW,
    });
    expect(result).toEqual({ ok: false, error: 'EMAIL_MISMATCH' });
    expect(driveInviteRepository.consumeInviteAndCreateMembership).not.toHaveBeenCalled();
  });

  it('returns TOKEN_CONSUMED when consumeInviteAndCreateMembership loses the race (zero rows updated)', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseInvite);
    vi.mocked(driveInviteRepository.consumeInviteAndCreateMembership).mockResolvedValue({
      reason: 'TOKEN_CONSUMED',
    });
    const result = await acceptInviteForNewUser({
      token: 'ps_invite_x',
      userId: 'user_jane',
      userEmail: 'jane@example.com',
      now: NOW,
    });
    expect(result).toEqual({ ok: false, error: 'TOKEN_CONSUMED' });
  });

  it('consumes the invite and inserts driveMembers transactionally on the happy path', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseInvite);
    const result = await acceptInviteForNewUser({
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

  it('normalizes email comparison case- and whitespace-insensitively (matches isEmailMatchingInvite contract)', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseInvite);
    const result = await acceptInviteForNewUser({
      token: 'ps_invite_x',
      userId: 'user_jane',
      userEmail: '  Jane@Example.COM  ',
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });
});

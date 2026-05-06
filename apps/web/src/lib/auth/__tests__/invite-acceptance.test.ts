import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findPendingInviteByTokenHash: vi.fn(),
    findExistingMember: vi.fn(),
    consumeInviteAndCreateMembership: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/auth/token-utils', () => ({
  hashToken: vi.fn((t: string) => `hash(${t})`),
}));

import {
  acceptInviteForExistingUser,
  acceptInviteForNewUser,
} from '../invite-acceptance';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

const now = new Date('2026-05-06T12:00:00.000Z');

const validInvite = {
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

beforeEach(() => vi.clearAllMocks());

describe('acceptInviteForExistingUser', () => {
  const userInput = {
    token: 'ps_invite_xyz',
    userId: 'user_existing',
    userEmail: 'invitee@example.com',
    now,
  };

  it('given an unknown token, returns TOKEN_NOT_FOUND', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(null);

    const result = await acceptInviteForExistingUser(userInput);

    expect(result).toEqual({ ok: false, error: 'TOKEN_NOT_FOUND' });
    expect(driveInviteRepository.consumeInviteAndCreateMembership).not.toHaveBeenCalled();
  });

  it('given an already-consumed invite, returns TOKEN_CONSUMED', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue({
      ...validInvite,
      consumedAt: new Date('2026-05-06T11:00:00.000Z'),
    });

    const result = await acceptInviteForExistingUser(userInput);
    expect(result).toEqual({ ok: false, error: 'TOKEN_CONSUMED' });
  });

  it('given an expired invite, returns TOKEN_EXPIRED', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue({
      ...validInvite,
      expiresAt: new Date('2026-05-06T11:00:00.000Z'),
    });

    const result = await acceptInviteForExistingUser(userInput);
    expect(result).toEqual({ ok: false, error: 'TOKEN_EXPIRED' });
  });

  it('given the authenticated email differs from the invite email (case + whitespace insensitive miss), returns EMAIL_MISMATCH and does not consume', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(validInvite);

    const result = await acceptInviteForExistingUser({
      ...userInput,
      userEmail: 'someone-else@example.com',
    });

    expect(result).toEqual({ ok: false, error: 'EMAIL_MISMATCH' });
    expect(driveInviteRepository.consumeInviteAndCreateMembership).not.toHaveBeenCalled();
  });

  it('given the authenticated user is already an accepted member, returns ALREADY_MEMBER and does not consume', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(validInvite);
    vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue({
      id: 'mem_existing',
      acceptedAt: new Date('2025-01-01'),
    } as never);

    const result = await acceptInviteForExistingUser(userInput);

    expect(result).toEqual({ ok: false, error: 'ALREADY_MEMBER' });
    expect(driveInviteRepository.consumeInviteAndCreateMembership).not.toHaveBeenCalled();
  });

  it('given a valid invite, consumes the token and returns ok with driveId + memberId', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(validInvite);
    vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null as never);
    vi.mocked(driveInviteRepository.consumeInviteAndCreateMembership).mockResolvedValue({
      ok: true,
      memberId: 'mem_new',
    });

    const result = await acceptInviteForExistingUser(userInput);

    expect(result).toEqual({
      ok: true,
      data: { driveId: 'drive_1', driveName: 'Alpha', memberId: 'mem_new' },
    });
    expect(driveInviteRepository.consumeInviteAndCreateMembership).toHaveBeenCalledWith({
      inviteId: 'inv_1',
      driveId: 'drive_1',
      userId: 'user_existing',
      role: 'MEMBER',
      invitedBy: 'inviter_1',
      acceptedAt: now,
    });
  });

  it('given consumeInviteAndCreateMembership returns TOKEN_CONSUMED (race), surfaces TOKEN_CONSUMED', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(validInvite);
    vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null as never);
    vi.mocked(driveInviteRepository.consumeInviteAndCreateMembership).mockResolvedValue({
      ok: false,
      reason: 'TOKEN_CONSUMED',
    });

    const result = await acceptInviteForExistingUser(userInput);
    expect(result).toEqual({ ok: false, error: 'TOKEN_CONSUMED' });
  });

  it('given consumeInviteAndCreateMembership returns ALREADY_MEMBER (race), surfaces ALREADY_MEMBER', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(validInvite);
    vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null as never);
    vi.mocked(driveInviteRepository.consumeInviteAndCreateMembership).mockResolvedValue({
      ok: false,
      reason: 'ALREADY_MEMBER',
    });

    const result = await acceptInviteForExistingUser(userInput);
    expect(result).toEqual({ ok: false, error: 'ALREADY_MEMBER' });
  });
});

describe('acceptInviteForNewUser', () => {
  const newUserInput = {
    token: 'ps_invite_xyz',
    userId: 'user_just_created',
    userEmail: 'invitee@example.com',
    now,
  };

  it('given an unknown token, returns TOKEN_NOT_FOUND and does not consume', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(null);

    const result = await acceptInviteForNewUser(newUserInput);

    expect(result).toEqual({ ok: false, error: 'TOKEN_NOT_FOUND' });
    expect(driveInviteRepository.consumeInviteAndCreateMembership).not.toHaveBeenCalled();
  });

  it('given a valid invite, consumes and returns ok with driveId + memberId', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(validInvite);
    vi.mocked(driveInviteRepository.consumeInviteAndCreateMembership).mockResolvedValue({
      ok: true,
      memberId: 'mem_new',
    });

    const result = await acceptInviteForNewUser(newUserInput);

    expect(result).toEqual({
      ok: true,
      data: { driveId: 'drive_1', driveName: 'Alpha', memberId: 'mem_new' },
    });
    // No findExistingMember check on the new-user path — the user was just
    // created and definitionally has no prior membership.
    expect(driveInviteRepository.findExistingMember).not.toHaveBeenCalled();
  });

  it('given the authenticated email differs from the invite email, returns EMAIL_MISMATCH and does not consume', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(validInvite);

    const result = await acceptInviteForNewUser({
      ...newUserInput,
      userEmail: 'mismatch@example.com',
    });

    expect(result).toEqual({ ok: false, error: 'EMAIL_MISMATCH' });
    expect(driveInviteRepository.consumeInviteAndCreateMembership).not.toHaveBeenCalled();
  });

  it('given a race-condition unique violation on driveMembers, surfaces ALREADY_MEMBER', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(validInvite);
    vi.mocked(driveInviteRepository.consumeInviteAndCreateMembership).mockResolvedValue({
      ok: false,
      reason: 'ALREADY_MEMBER',
    });

    const result = await acceptInviteForNewUser(newUserInput);
    expect(result).toEqual({ ok: false, error: 'ALREADY_MEMBER' });
  });
});

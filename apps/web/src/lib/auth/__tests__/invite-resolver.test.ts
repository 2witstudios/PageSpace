import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findPendingInviteByTokenHash: vi.fn(),
    findUserToSStatusByEmail: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/auth/token-utils', () => ({
  hashToken: vi.fn((t: string) => `hash(${t})`),
}));

import { resolveInviteContext } from '../invite-resolver';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

const now = new Date('2026-05-06T12:00:00.000Z');

const baseInvite = {
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

describe('resolveInviteContext', () => {
  it('given a token that does not match any pending row, returns NOT_FOUND', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(null);

    const result = await resolveInviteContext({ token: 'garbage', now });

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('given a row whose consumedAt is set, returns CONSUMED', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue({
      ...baseInvite,
      consumedAt: new Date('2026-05-06T11:00:00.000Z'),
    });

    const result = await resolveInviteContext({ token: 'tok', now });

    expect(result).toEqual({ ok: false, error: 'CONSUMED' });
  });

  it('given a row whose expiresAt is in the past, returns EXPIRED', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue({
      ...baseInvite,
      expiresAt: new Date('2026-05-06T11:00:00.000Z'),
    });

    const result = await resolveInviteContext({ token: 'tok', now });

    expect(result).toEqual({ ok: false, error: 'EXPIRED' });
  });

  it('given an active row + a user with tosAcceptedAt set, returns ok with isExistingUser=true', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseInvite);
    vi.mocked(driveInviteRepository.findUserToSStatusByEmail).mockResolvedValue({
      id: 'user_1',
      tosAcceptedAt: new Date('2025-01-01'),
    });

    const result = await resolveInviteContext({ token: 'tok', now });

    expect(result).toEqual({
      ok: true,
      data: {
        driveName: 'Alpha',
        inviterName: 'Jane',
        role: 'MEMBER',
        email: 'invitee@example.com',
        isExistingUser: true,
      },
    });
  });

  it('given an active row + a user record exists with tosAcceptedAt null (OAuth / magic-link user), returns ok with isExistingUser=true', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseInvite);
    vi.mocked(driveInviteRepository.findUserToSStatusByEmail).mockResolvedValue({
      id: 'user_oauth',
      tosAcceptedAt: null,
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

  it('given an active row + no user mapped to that email, returns ok with isExistingUser=false', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseInvite);
    vi.mocked(driveInviteRepository.findUserToSStatusByEmail).mockResolvedValue(null);

    const result = await resolveInviteContext({ token: 'tok', now });

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ isExistingUser: false }),
    });
  });

  it('given a token, looks up by SHA3 hash (never plaintext)', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(null);

    await resolveInviteContext({ token: 'ps_invite_abc', now });

    expect(driveInviteRepository.findPendingInviteByTokenHash).toHaveBeenCalledWith(
      'hash(ps_invite_abc)'
    );
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findPendingInviteByTokenHash: vi.fn(),
    findUserToSStatusByEmail: vi.fn(),
  },
}));

import { resolveInviteContext } from '../invite-resolver';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { hashToken } from '@pagespace/lib/auth/token-utils';

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
  driveName: 'Acme',
  inviterName: 'Alice',
};

beforeEach(() => vi.clearAllMocks());

describe('resolveInviteContext', () => {
  it('returns NOT_FOUND when no invite matches the token hash', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(null);
    const result = await resolveInviteContext({ token: 'ps_invite_x', now: NOW });
    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('hashes the raw token before lookup (raw token never queried directly)', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(null);
    await resolveInviteContext({ token: 'ps_invite_abc', now: NOW });
    expect(driveInviteRepository.findPendingInviteByTokenHash).toHaveBeenCalledWith(
      hashToken('ps_invite_abc')
    );
  });

  it('returns CONSUMED when the invite has a non-null consumedAt', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue({
      ...baseInvite,
      consumedAt: new Date('2026-05-05T12:00:00.000Z'),
    });
    const result = await resolveInviteContext({ token: 'ps_invite_x', now: NOW });
    expect(result).toEqual({ ok: false, error: 'CONSUMED' });
  });

  it('returns EXPIRED when expiresAt is in the past', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue({
      ...baseInvite,
      expiresAt: PAST,
    });
    const result = await resolveInviteContext({ token: 'ps_invite_x', now: NOW });
    expect(result).toEqual({ ok: false, error: 'EXPIRED' });
  });

  it('returns ok with isExistingUser=true when email maps to a user with tosAcceptedAt set', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseInvite);
    vi.mocked(driveInviteRepository.findUserToSStatusByEmail).mockResolvedValue({
      tosAcceptedAt: new Date('2026-04-01T00:00:00.000Z'),
    });
    const result = await resolveInviteContext({ token: 'ps_invite_x', now: NOW });
    expect(result).toEqual({
      ok: true,
      data: {
        driveName: 'Acme',
        inviterName: 'Alice',
        role: 'MEMBER',
        email: 'jane@example.com',
        isExistingUser: true,
      },
    });
  });

  it('returns ok with isExistingUser=false when email maps to no user', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseInvite);
    vi.mocked(driveInviteRepository.findUserToSStatusByEmail).mockResolvedValue(null);
    const result = await resolveInviteContext({ token: 'ps_invite_x', now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.isExistingUser).toBe(false);
  });

  it('returns ok with isExistingUser=false when user exists but tosAcceptedAt is null (pre-consent orphan)', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(baseInvite);
    vi.mocked(driveInviteRepository.findUserToSStatusByEmail).mockResolvedValue({
      tosAcceptedAt: null,
    });
    const result = await resolveInviteContext({ token: 'ps_invite_x', now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.isExistingUser).toBe(false);
  });
});

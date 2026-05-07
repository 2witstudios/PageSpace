import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/auth/invite-acceptance-adapters', () => ({
  buildAcceptancePorts: vi.fn(() => ({})),
}));

const acceptForNewPipe = vi.fn();
const acceptForExistingPipe = vi.fn();

vi.mock('@pagespace/lib/services/invites', () => ({
  acceptInviteForNewUser: vi.fn(() => acceptForNewPipe),
  acceptInviteForExistingUser: vi.fn(() => acceptForExistingPipe),
}));

import { consumeInviteIfPresent } from '../native-invite-acceptance';
import { acceptInviteForNewUser, acceptInviteForExistingUser } from '@pagespace/lib/services/invites';
import { loggers } from '@pagespace/lib/logging/logger-config';

const dummyRequest = new Request('http://localhost/test', { method: 'POST' });
const dummyUser = { id: 'user-1', suspendedAt: null };

describe('consumeInviteIfPresent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acceptForNewPipe.mockReset();
    acceptForExistingPipe.mockReset();
    vi.mocked(acceptInviteForNewUser).mockImplementation(() => acceptForNewPipe);
    vi.mocked(acceptInviteForExistingUser).mockImplementation(() => acceptForExistingPipe);
  });

  it('returns invitedDriveId: null and skips pipes when no inviteToken', async () => {
    const result = await consumeInviteIfPresent({
      request: dummyRequest,
      inviteToken: undefined,
      user: dummyUser,
      isNewUser: false,
      email: 'a@b.com',
    });
    expect(result).toEqual({ invitedDriveId: null });
    expect(acceptInviteForNewUser).not.toHaveBeenCalled();
    expect(acceptInviteForExistingUser).not.toHaveBeenCalled();
  });

  it('routes new users through acceptInviteForNewUser with suspendedAt: null', async () => {
    acceptForNewPipe.mockResolvedValueOnce({
      ok: true,
      data: { driveId: 'drive-new', memberId: 'm', driveName: 'D', role: 'MEMBER', invitedUserId: 'user-1', inviterUserId: 'i' },
    });

    const result = await consumeInviteIfPresent({
      request: dummyRequest,
      inviteToken: 'ps_invite_t',
      user: { id: 'user-1', suspendedAt: new Date() },
      isNewUser: true,
      email: 'A@B.COM',
    });

    expect(acceptForNewPipe).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'ps_invite_t',
        userId: 'user-1',
        userEmail: 'a@b.com',
        suspendedAt: null,
      }),
    );
    expect(result.invitedDriveId).toBe('drive-new');
  });

  it('routes existing users through acceptInviteForExistingUser with their suspendedAt', async () => {
    const suspendedAt = new Date('2024-01-01');
    acceptForExistingPipe.mockResolvedValueOnce({
      ok: true,
      data: { driveId: 'drive-exist', memberId: 'm', driveName: 'D', role: 'ADMIN', invitedUserId: 'user-1', inviterUserId: 'i' },
    });

    const result = await consumeInviteIfPresent({
      request: dummyRequest,
      inviteToken: 'ps_invite_t',
      user: { id: 'user-1', suspendedAt },
      isNewUser: false,
      email: 'a@b.com',
    });

    expect(acceptForExistingPipe).toHaveBeenCalledWith(
      expect.objectContaining({ suspendedAt }),
    );
    expect(result.invitedDriveId).toBe('drive-exist');
  });

  it('surfaces inviteError on EMAIL_MISMATCH without throwing', async () => {
    acceptForNewPipe.mockResolvedValueOnce({ ok: false, error: 'EMAIL_MISMATCH' });

    const result = await consumeInviteIfPresent({
      request: dummyRequest,
      inviteToken: 'ps_invite_t',
      user: dummyUser,
      isNewUser: true,
      email: 'a@b.com',
    });

    expect(result).toEqual({ invitedDriveId: null, inviteError: 'EMAIL_MISMATCH' });
  });

  it('returns invitedDriveId: null and logs when pipe throws', async () => {
    acceptForNewPipe.mockRejectedValueOnce(new Error('pipe blew up'));

    const result = await consumeInviteIfPresent({
      request: dummyRequest,
      inviteToken: 'ps_invite_t',
      user: dummyUser,
      isNewUser: true,
      email: 'a@b.com',
    });

    expect(result).toEqual({ invitedDriveId: null });
    expect(loggers.auth.error).toHaveBeenCalledWith(
      'Invite acceptance pipe threw',
      expect.any(Error),
    );
  });

  it('lowercases userEmail before passing to pipe', async () => {
    acceptForNewPipe.mockResolvedValueOnce({
      ok: true,
      data: { driveId: 'd', memberId: 'm', driveName: 'D', role: 'MEMBER', invitedUserId: 'u', inviterUserId: 'i' },
    });

    await consumeInviteIfPresent({
      request: dummyRequest,
      inviteToken: 'ps_invite_t',
      user: dummyUser,
      isNewUser: true,
      email: 'MiXeD@CaSe.COM',
    });

    expect(acceptForNewPipe).toHaveBeenCalledWith(
      expect.objectContaining({ userEmail: 'mixed@case.com' }),
    );
  });
});

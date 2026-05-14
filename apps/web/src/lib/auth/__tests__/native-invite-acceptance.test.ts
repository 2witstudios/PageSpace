import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    api: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/auth/token-utils', () => ({
  hashToken: vi.fn((token: string) => `hash:${token}`),
}));

vi.mock('@/lib/auth/invite-acceptance-adapters', () => ({
  buildAcceptancePorts: vi.fn(() => ({})),
}));
vi.mock('@/lib/auth/page-invite-acceptance-adapters', () => ({
  buildPageAcceptancePorts: vi.fn(() => ({})),
}));
vi.mock('@/lib/auth/connection-invite-acceptance-adapters', () => ({
  buildConnectionAcceptancePorts: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findPendingInviteByTokenHash: vi.fn(),
    findUnconsumedActiveInvitesByEmail: vi.fn().mockResolvedValue([]),
    consumeInviteAndCreateMembership: vi.fn(),
  },
}));
vi.mock('@/lib/repositories/page-invite-repository', () => ({
  pageInviteRepository: {
    findPendingInviteByTokenHash: vi.fn(),
    findUnconsumedActiveInvitesByEmail: vi.fn().mockResolvedValue([]),
    consumeInviteAndGrantPage: vi.fn(),
  },
}));
vi.mock('@/lib/repositories/connection-invite-repository', () => ({
  connectionInviteRepository: {
    findPendingInviteByTokenHash: vi.fn(),
    findUnconsumedActiveInvitesByEmail: vi.fn().mockResolvedValue([]),
    consumeInviteAndCreateConnection: vi.fn(),
  },
}));

const acceptForNewPipe = vi.fn();
const acceptForExistingPipe = vi.fn();
const acceptPageForNewPipe = vi.fn();
const acceptPageForExistingPipe = vi.fn();
const acceptConnectionForNewPipe = vi.fn();
const acceptConnectionForExistingPipe = vi.fn();

vi.mock('@pagespace/lib/services/invites', () => ({
  acceptInviteForNewUser: vi.fn(() => acceptForNewPipe),
  acceptInviteForExistingUser: vi.fn(() => acceptForExistingPipe),
  acceptPageInviteForNewUser: vi.fn(() => acceptPageForNewPipe),
  acceptPageInviteForExistingUser: vi.fn(() => acceptPageForExistingPipe),
  acceptConnectionInviteForNewUser: vi.fn(() => acceptConnectionForNewPipe),
  acceptConnectionInviteForExistingUser: vi.fn(() => acceptConnectionForExistingPipe),
  emitAcceptanceSideEffects: vi.fn().mockResolvedValue(undefined),
  emitPageAcceptanceSideEffects: vi.fn().mockResolvedValue(undefined),
  emitConnectionAcceptanceSideEffects: vi.fn().mockResolvedValue(undefined),
}));

import {
  consumeAnyInviteIfPresent,
  consumeAllInvitesForEmail,
} from '../native-invite-acceptance';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { pageInviteRepository } from '@/lib/repositories/page-invite-repository';
import { connectionInviteRepository } from '@/lib/repositories/connection-invite-repository';

const dummyRequest = new Request('http://localhost/test', { method: 'POST' });
const dummyUser = { id: 'user-1', suspendedAt: null };

const driveRow = (overrides = {}) => ({
  id: 'drv_inv_1',
  email: 'invitee@example.com',
  driveId: 'drive_1',
  role: 'MEMBER' as const,
  customRoleId: null as string | null,
  invitedBy: 'user_inviter',
  expiresAt: new Date('2099-01-01') as Date | null,
  consumedAt: null as Date | null,
  driveName: 'Acme',
  inviterName: 'Jane',
  ...overrides,
});

const pageRow = (overrides = {}) => ({
  id: 'pg_inv_1',
  email: 'invitee@example.com',
  pageId: 'page_1',
  pageTitle: 'Q3 Plan',
  driveId: 'drive_1',
  driveName: 'Acme',
  permissions: ['VIEW' as const],
  invitedBy: 'user_inviter',
  inviterName: 'Jane',
  expiresAt: new Date('2099-01-01'),
  consumedAt: null,
  ...overrides,
});

const connectionRow = (overrides = {}) => ({
  id: 'cn_inv_1',
  email: 'invitee@example.com',
  invitedBy: 'user_inviter',
  inviterName: 'Jane',
  requestMessage: null,
  expiresAt: new Date('2099-01-01'),
  consumedAt: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(null);
  vi.mocked(pageInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(null);
  vi.mocked(connectionInviteRepository.findPendingInviteByTokenHash).mockResolvedValue(null);
  vi.mocked(driveInviteRepository.findUnconsumedActiveInvitesByEmail).mockResolvedValue([]);
  vi.mocked(pageInviteRepository.findUnconsumedActiveInvitesByEmail).mockResolvedValue([]);
  vi.mocked(connectionInviteRepository.findUnconsumedActiveInvitesByEmail).mockResolvedValue([]);
});

describe('consumeAnyInviteIfPresent', () => {
  it('returns null kind / null ids and skips repos when no token is supplied', async () => {
    const result = await consumeAnyInviteIfPresent({
      request: dummyRequest,
      inviteToken: undefined,
      user: dummyUser,
      isNewUser: false,
      email: 'a@b.com',
    });
    expect(result).toEqual({
      kind: null,
      invitedDriveId: null,
      invitedPageId: null,
      connectionId: null,
    });
    expect(driveInviteRepository.findPendingInviteByTokenHash).not.toHaveBeenCalled();
    expect(pageInviteRepository.findPendingInviteByTokenHash).not.toHaveBeenCalled();
    expect(connectionInviteRepository.findPendingInviteByTokenHash).not.toHaveBeenCalled();
  });

  it('given a drive-token match, dispatches to the drive pipe and returns kind=drive', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValueOnce(driveRow());
    acceptForNewPipe.mockResolvedValueOnce({
      ok: true,
      data: {
        driveId: 'drive_1',
        memberId: 'mem_1',
        driveName: 'Acme',
        role: 'MEMBER',
        invitedUserId: 'user-1',
        inviterUserId: 'user_inviter',
      },
    });

    const result = await consumeAnyInviteIfPresent({
      request: dummyRequest,
      inviteToken: 'ps_invite_d',
      user: dummyUser,
      isNewUser: true,
      email: 'a@b.com',
    });

    expect(result).toEqual({
      kind: 'drive',
      invitedDriveId: 'drive_1',
      invitedPageId: null,
      connectionId: null,
    });
    expect(acceptForNewPipe).toHaveBeenCalledOnce();
    expect(acceptPageForNewPipe).not.toHaveBeenCalled();
    expect(acceptConnectionForNewPipe).not.toHaveBeenCalled();
  });

  it('given a page-token match, dispatches to the page pipe and returns kind=page with pageId+driveId', async () => {
    vi.mocked(pageInviteRepository.findPendingInviteByTokenHash).mockResolvedValueOnce(pageRow());
    acceptPageForNewPipe.mockResolvedValueOnce({
      ok: true,
      data: {
        inviteId: 'pg_inv_1',
        inviteEmail: 'invitee@example.com',
        pageId: 'page_1',
        pageTitle: 'Q3 Plan',
        driveId: 'drive_1',
        driveName: 'Acme',
        permissions: ['VIEW'],
        memberId: 'mem_1',
        invitedUserId: 'user-1',
        inviterUserId: 'user_inviter',
      },
    });

    const result = await consumeAnyInviteIfPresent({
      request: dummyRequest,
      inviteToken: 'ps_invite_p',
      user: dummyUser,
      isNewUser: true,
      email: 'a@b.com',
    });

    expect(result).toEqual({
      kind: 'page',
      invitedDriveId: 'drive_1',
      invitedPageId: 'page_1',
      connectionId: null,
    });
    expect(acceptPageForNewPipe).toHaveBeenCalledOnce();
    expect(acceptForNewPipe).not.toHaveBeenCalled();
  });

  it('given a connection-token match, dispatches to the connection pipe and returns kind=connection', async () => {
    vi.mocked(connectionInviteRepository.findPendingInviteByTokenHash).mockResolvedValueOnce(connectionRow());
    acceptConnectionForNewPipe.mockResolvedValueOnce({
      ok: true,
      data: {
        inviteId: 'cn_inv_1',
        inviteEmail: 'invitee@example.com',
        connectionId: 'conn_1',
        status: 'PENDING',
        invitedUserId: 'user-1',
        inviterUserId: 'user_inviter',
      },
    });

    const result = await consumeAnyInviteIfPresent({
      request: dummyRequest,
      inviteToken: 'ps_invite_c',
      user: dummyUser,
      isNewUser: true,
      email: 'a@b.com',
    });

    expect(result).toEqual({
      kind: 'connection',
      invitedDriveId: null,
      invitedPageId: null,
      connectionId: 'conn_1',
    });
  });

  it('given no row in any of the three repositories, returns inviteError=TOKEN_NOT_FOUND', async () => {
    const result = await consumeAnyInviteIfPresent({
      request: dummyRequest,
      inviteToken: 'ps_invite_unknown',
      user: dummyUser,
      isNewUser: false,
      email: 'a@b.com',
    });
    expect(result.inviteError).toBe('TOKEN_NOT_FOUND');
    expect(result.kind).toBeNull();
  });

  it('given pipe returns EMAIL_MISMATCH, propagates inviteError', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValueOnce(driveRow());
    acceptForExistingPipe.mockResolvedValueOnce({ ok: false, error: 'EMAIL_MISMATCH' });

    const result = await consumeAnyInviteIfPresent({
      request: dummyRequest,
      inviteToken: 'ps_invite_d',
      user: dummyUser,
      isNewUser: false,
      email: 'a@b.com',
    });

    expect(result.kind).toBeNull();
    expect(result.invitedDriveId).toBeNull();
    expect(result.inviteError).toBe('EMAIL_MISMATCH');
  });

  it('given pipe returns ALREADY_HAS_PERMISSION on a page invite, propagates inviteError', async () => {
    vi.mocked(pageInviteRepository.findPendingInviteByTokenHash).mockResolvedValueOnce(pageRow());
    acceptPageForExistingPipe.mockResolvedValueOnce({ ok: false, error: 'ALREADY_HAS_PERMISSION' });

    const result = await consumeAnyInviteIfPresent({
      request: dummyRequest,
      inviteToken: 'ps_invite_p',
      user: dummyUser,
      isNewUser: false,
      email: 'a@b.com',
    });

    expect(result.inviteError).toBe('ALREADY_HAS_PERMISSION');
  });

  it('lowercases email before passing to pipes', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValueOnce(driveRow());
    acceptForNewPipe.mockResolvedValueOnce({
      ok: true,
      data: {
        driveId: 'drive_1',
        memberId: 'mem_1',
        driveName: 'Acme',
        role: 'MEMBER',
        invitedUserId: 'user-1',
        inviterUserId: 'user_inviter',
      },
    });

    await consumeAnyInviteIfPresent({
      request: dummyRequest,
      inviteToken: 'ps_invite_d',
      user: dummyUser,
      isNewUser: true,
      email: 'MIXED@CASE.COM',
    });

    expect(acceptForNewPipe).toHaveBeenCalledWith(
      expect.objectContaining({ userEmail: 'mixed@case.com' }),
    );
  });

  it('overrides suspendedAt to null for new users to avoid tripping the suspended-account gate on a fresh row', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValueOnce(driveRow());
    acceptForNewPipe.mockResolvedValueOnce({
      ok: true,
      data: {
        driveId: 'drive_1',
        memberId: 'mem_1',
        driveName: 'Acme',
        role: 'MEMBER',
        invitedUserId: 'user-1',
        inviterUserId: 'user_inviter',
      },
    });

    await consumeAnyInviteIfPresent({
      request: dummyRequest,
      inviteToken: 'ps_invite_d',
      user: { id: 'user-1', suspendedAt: new Date('2024-01-01') },
      isNewUser: true,
      email: 'a@b.com',
    });

    expect(acceptForNewPipe).toHaveBeenCalledWith(
      expect.objectContaining({ suspendedAt: null }),
    );
  });

  it('forwards the existing user suspendedAt when isNewUser=false', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockResolvedValueOnce(driveRow());
    const suspended = new Date('2024-01-01');
    acceptForExistingPipe.mockResolvedValueOnce({
      ok: false,
      error: 'ACCOUNT_SUSPENDED',
    });

    await consumeAnyInviteIfPresent({
      request: dummyRequest,
      inviteToken: 'ps_invite_d',
      user: { id: 'user-1', suspendedAt: suspended },
      isNewUser: false,
      email: 'a@b.com',
    });

    expect(acceptForExistingPipe).toHaveBeenCalledWith(
      expect.objectContaining({ suspendedAt: suspended }),
    );
  });

  it('returns empty result when a repo throws', async () => {
    vi.mocked(driveInviteRepository.findPendingInviteByTokenHash).mockRejectedValueOnce(new Error('db down'));

    const result = await consumeAnyInviteIfPresent({
      request: dummyRequest,
      inviteToken: 'ps_invite_d',
      user: dummyUser,
      isNewUser: false,
      email: 'a@b.com',
    });

    expect(result).toEqual({
      kind: null,
      invitedDriveId: null,
      invitedPageId: null,
      connectionId: null,
    });
  });
});

describe('consumeAllInvitesForEmail', () => {
  it('returns zeros and runs no pipes when the user is suspended', async () => {
    const summary = await consumeAllInvitesForEmail({
      request: dummyRequest,
      email: 'invitee@example.com',
      user: { id: 'user-1', suspendedAt: new Date('2024-01-01') },
      now: new Date('2026-05-06'),
    });
    expect(summary).toEqual({ drivesAccepted: 0, pagesAccepted: 0, connectionsCreated: 0 });
    expect(driveInviteRepository.findUnconsumedActiveInvitesByEmail).not.toHaveBeenCalled();
  });

  it('returns zeros when there are no pending invites for this email', async () => {
    const summary = await consumeAllInvitesForEmail({
      request: dummyRequest,
      email: 'invitee@example.com',
      user: dummyUser,
      now: new Date('2026-05-06'),
    });
    expect(summary).toEqual({ drivesAccepted: 0, pagesAccepted: 0, connectionsCreated: 0 });
  });

  it('does not auto-accept connection invites as ACCEPTED — connections row is created in PENDING and the helper increments connectionsCreated only', async () => {
    vi.mocked(connectionInviteRepository.findUnconsumedActiveInvitesByEmail).mockResolvedValueOnce([
      { id: 'cn_inv_1', invitedBy: 'user_inviter', requestMessage: null },
    ]);
    vi.mocked(connectionInviteRepository.consumeInviteAndCreateConnection).mockResolvedValueOnce({
      ok: true,
      connectionId: 'conn_1',
      status: 'PENDING',
    });

    const summary = await consumeAllInvitesForEmail({
      request: dummyRequest,
      email: 'invitee@example.com',
      user: dummyUser,
      now: new Date('2026-05-06'),
    });

    expect(summary.connectionsCreated).toBe(1);
    expect(summary.drivesAccepted).toBe(0);
    expect(summary.pagesAccepted).toBe(0);
    expect(connectionInviteRepository.consumeInviteAndCreateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteId: 'cn_inv_1',
        invitedBy: 'user_inviter',
        userId: 'user-1',
      }),
    );
  });

  it('lowercases the email before dispatching repository lookups', async () => {
    await consumeAllInvitesForEmail({
      request: dummyRequest,
      email: 'MIXED@Case.com',
      user: dummyUser,
      now: new Date('2026-05-06'),
    });
    expect(driveInviteRepository.findUnconsumedActiveInvitesByEmail).toHaveBeenCalledWith(
      'mixed@case.com',
      expect.any(Date),
    );
  });

  it('accepts drive and page invites in the same call and returns correct per-kind counts', async () => {
    vi.mocked(driveInviteRepository.findUnconsumedActiveInvitesByEmail).mockResolvedValueOnce([
      { id: 'drv_inv_1', driveId: 'drive_1', driveName: 'Acme', role: 'MEMBER' as const, customRoleId: null, invitedBy: 'user_inviter' },
    ]);
    vi.mocked(driveInviteRepository.consumeInviteAndCreateMembership).mockResolvedValueOnce({
      ok: true,
      memberId: 'mem_1',
    });
    vi.mocked(pageInviteRepository.findUnconsumedActiveInvitesByEmail).mockResolvedValueOnce([
      {
        id: 'pg_inv_1',
        pageId: 'page_1',
        pageTitle: 'Q3 Plan',
        driveId: 'drive_1',
        driveName: 'Acme',
        invitedBy: 'user_inviter',
        permissions: ['VIEW' as const],
      },
    ]);
    vi.mocked(pageInviteRepository.consumeInviteAndGrantPage).mockResolvedValueOnce({
      ok: true,
      memberId: null,
    });

    const summary = await consumeAllInvitesForEmail({
      request: dummyRequest,
      email: 'invitee@example.com',
      user: dummyUser,
      now: new Date('2026-05-06'),
    });

    expect(summary.drivesAccepted).toBe(1);
    expect(summary.pagesAccepted).toBe(1);
    expect(summary.connectionsCreated).toBe(0);
  });

  it('continues processing remaining invites when one drive invite consumption fails', async () => {
    vi.mocked(driveInviteRepository.findUnconsumedActiveInvitesByEmail).mockResolvedValueOnce([
      { id: 'drv_inv_fail', driveId: 'drive_1', driveName: 'Acme', role: 'MEMBER' as const, customRoleId: null, invitedBy: 'user_a' },
      { id: 'drv_inv_ok', driveId: 'drive_2', driveName: 'Beta', role: 'MEMBER' as const, customRoleId: null, invitedBy: 'user_b' },
    ]);
    vi.mocked(driveInviteRepository.consumeInviteAndCreateMembership)
      .mockResolvedValueOnce({ ok: false, reason: 'TOKEN_CONSUMED' })
      .mockResolvedValueOnce({ ok: true, memberId: 'mem_2' });

    const summary = await consumeAllInvitesForEmail({
      request: dummyRequest,
      email: 'invitee@example.com',
      user: dummyUser,
      now: new Date('2026-05-06'),
    });

    expect(summary.drivesAccepted).toBe(1);
    expect(driveInviteRepository.consumeInviteAndCreateMembership).toHaveBeenCalledTimes(2);
  });
});

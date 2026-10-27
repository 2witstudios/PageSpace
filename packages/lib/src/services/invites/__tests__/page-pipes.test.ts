import { describe, it, expect, vi } from 'vitest';
import {
  acceptPageInviteForExistingUser,
  acceptPageInviteForNewUser,
} from '../pipes';
import type { PageAcceptancePorts } from '../ports';
import type { AcceptInviteInput, PageInvite } from '../types';

const basePageInvite = (overrides: Partial<PageInvite> = {}): PageInvite => ({
  id: 'pinv_1',
  email: 'invitee@example.com',
  pageId: 'page_1',
  pageTitle: 'Q3 Planning',
  driveId: 'drive_1',
  driveName: 'Acme',
  permissions: ['VIEW', 'EDIT'],
  invitedBy: 'user_inviter',
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  consumedAt: null,
  ...overrides,
});

const baseInput = (overrides: Partial<AcceptInviteInput> = {}): AcceptInviteInput => ({
  token: 'ps_invite_xyz',
  userId: 'user_invitee',
  userEmail: 'invitee@example.com',
  now: new Date('2026-05-06T12:00:00.000Z'),
  suspendedAt: null,
  ...overrides,
});

const buildStubPorts = (
  overrides: Partial<PageAcceptancePorts> = {},
): PageAcceptancePorts => ({
  loadInvite: vi.fn().mockResolvedValue(basePageInvite()),
  findExistingPagePermission: vi.fn().mockResolvedValue(null),
  consumeInviteAndGrantPage: vi
    .fn()
    .mockResolvedValue({ ok: true, memberId: 'mem_1' }),
  broadcastPagePermissionGranted: vi.fn().mockResolvedValue(undefined),
  notifyPagePermissionGranted: vi.fn().mockResolvedValue(undefined),
  auditPagePermissionGranted: vi.fn(),
  ...overrides,
});

describe('acceptPageInviteForExistingUser', () => {
  it('given loadInvite returns null, should return TOKEN_NOT_FOUND and fire no side effects', async () => {
    const ports = buildStubPorts({ loadInvite: vi.fn().mockResolvedValue(null) });
    const result = await acceptPageInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_NOT_FOUND' });
    expect(ports.consumeInviteAndGrantPage).not.toHaveBeenCalled();
    expect(ports.broadcastPagePermissionGranted).not.toHaveBeenCalled();
  });

  it('given a suspended user, should return ACCOUNT_SUSPENDED before any other port', async () => {
    const ports = buildStubPorts();
    const result = await acceptPageInviteForExistingUser(ports)(
      baseInput({ suspendedAt: new Date('2026-04-01') }),
    );
    expect(result).toEqual({ ok: false, error: 'ACCOUNT_SUSPENDED' });
    expect(ports.findExistingPagePermission).not.toHaveBeenCalled();
    expect(ports.consumeInviteAndGrantPage).not.toHaveBeenCalled();
  });

  it('given a consumed invite, should return TOKEN_CONSUMED and skip consume', async () => {
    const ports = buildStubPorts({
      loadInvite: vi
        .fn()
        .mockResolvedValue(basePageInvite({ consumedAt: new Date() })),
    });
    const result = await acceptPageInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_CONSUMED' });
    expect(ports.consumeInviteAndGrantPage).not.toHaveBeenCalled();
  });

  it('given an expired invite, should return TOKEN_EXPIRED', async () => {
    const ports = buildStubPorts({
      loadInvite: vi
        .fn()
        .mockResolvedValue(basePageInvite({ expiresAt: new Date('2026-01-01') })),
    });
    const result = await acceptPageInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_EXPIRED' });
    expect(ports.consumeInviteAndGrantPage).not.toHaveBeenCalled();
  });

  it('given an email mismatch, should return EMAIL_MISMATCH', async () => {
    const ports = buildStubPorts();
    const result = await acceptPageInviteForExistingUser(ports)(
      baseInput({ userEmail: 'different@example.com' }),
    );
    expect(result).toEqual({ ok: false, error: 'EMAIL_MISMATCH' });
  });

  it('given the user already has a permissions row on the page, should return ALREADY_HAS_PERMISSION', async () => {
    const ports = buildStubPorts({
      findExistingPagePermission: vi
        .fn()
        .mockResolvedValue({ id: 'perm_1' }),
    });
    const result = await acceptPageInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'ALREADY_HAS_PERMISSION' });
    expect(ports.consumeInviteAndGrantPage).not.toHaveBeenCalled();
  });

  it('given a valid invite, should fire the 3 page side-effect ports and return AcceptedPageInviteData with memberId', async () => {
    const ports = buildStubPorts();
    const result = await acceptPageInviteForExistingUser(ports)(baseInput());

    expect(result).toEqual({
      ok: true,
      data: {
        inviteId: 'pinv_1',
        inviteEmail: 'invitee@example.com',
        pageId: 'page_1',
        pageTitle: 'Q3 Planning',
        driveId: 'drive_1',
        driveName: 'Acme',
        permissions: ['VIEW', 'EDIT'],
        memberId: 'mem_1',
        invitedUserId: 'user_invitee',
        inviterUserId: 'user_inviter',
      },
    });
    expect(ports.broadcastPagePermissionGranted).toHaveBeenCalledOnce();
    expect(ports.notifyPagePermissionGranted).toHaveBeenCalledOnce();
    expect(ports.auditPagePermissionGranted).toHaveBeenCalledOnce();
  });

  it('given the consume port returns reason TOKEN_CONSUMED (race), should propagate without firing side effects', async () => {
    const ports = buildStubPorts({
      consumeInviteAndGrantPage: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'TOKEN_CONSUMED' }),
    });
    const result = await acceptPageInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_CONSUMED' });
    expect(ports.broadcastPagePermissionGranted).not.toHaveBeenCalled();
  });

  it('given the consume port returns reason ALREADY_HAS_PERMISSION (race), should propagate without firing side effects', async () => {
    const ports = buildStubPorts({
      consumeInviteAndGrantPage: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'ALREADY_HAS_PERMISSION' }),
    });
    const result = await acceptPageInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'ALREADY_HAS_PERMISSION' });
    expect(ports.broadcastPagePermissionGranted).not.toHaveBeenCalled();
  });

  it('given a side-effect port that throws, should still return ok (the writes are committed)', async () => {
    const ports = buildStubPorts({
      broadcastPagePermissionGranted: vi.fn().mockRejectedValue(new Error('ws down')),
    });
    const result = await acceptPageInviteForExistingUser(ports)(baseInput());
    expect(result.ok).toBe(true);
    expect(ports.notifyPagePermissionGranted).toHaveBeenCalledOnce();
    expect(ports.auditPagePermissionGranted).toHaveBeenCalledOnce();
  });
});

describe('acceptPageInviteForNewUser', () => {
  it('given loadInvite returns null, should return TOKEN_NOT_FOUND', async () => {
    const ports = buildStubPorts({ loadInvite: vi.fn().mockResolvedValue(null) });
    const result = await acceptPageInviteForNewUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_NOT_FOUND' });
    expect(ports.consumeInviteAndGrantPage).not.toHaveBeenCalled();
  });

  it('given an expired invite, should return TOKEN_EXPIRED without side effects', async () => {
    const ports = buildStubPorts({
      loadInvite: vi
        .fn()
        .mockResolvedValue(basePageInvite({ expiresAt: new Date('2026-01-01') })),
    });
    const result = await acceptPageInviteForNewUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_EXPIRED' });
  });

  it('given an email mismatch, should return EMAIL_MISMATCH', async () => {
    const ports = buildStubPorts();
    const result = await acceptPageInviteForNewUser(ports)(
      baseInput({ userEmail: 'different@example.com' }),
    );
    expect(result).toEqual({ ok: false, error: 'EMAIL_MISMATCH' });
  });

  it('given a successful new-user acceptance, should NOT call findExistingPagePermission and SHOULD fire all 3 side-effect ports', async () => {
    const ports = buildStubPorts();
    const result = await acceptPageInviteForNewUser(ports)(baseInput());
    expect(result.ok).toBe(true);
    expect(ports.findExistingPagePermission).not.toHaveBeenCalled();
    expect(ports.consumeInviteAndGrantPage).toHaveBeenCalledOnce();
    expect(ports.broadcastPagePermissionGranted).toHaveBeenCalledOnce();
    expect(ports.notifyPagePermissionGranted).toHaveBeenCalledOnce();
    expect(ports.auditPagePermissionGranted).toHaveBeenCalledOnce();
  });

  it('given consume returns ALREADY_HAS_PERMISSION (concurrent grant race), should propagate', async () => {
    const ports = buildStubPorts({
      consumeInviteAndGrantPage: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'ALREADY_HAS_PERMISSION' }),
    });
    const result = await acceptPageInviteForNewUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'ALREADY_HAS_PERMISSION' });
  });

  it('given consume returns memberId: null (caller already had drive membership), should still return ok with null memberId', async () => {
    const ports = buildStubPorts({
      consumeInviteAndGrantPage: vi
        .fn()
        .mockResolvedValue({ ok: true, memberId: null }),
    });
    const result = await acceptPageInviteForNewUser(ports)(baseInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.memberId).toBeNull();
    }
  });
});

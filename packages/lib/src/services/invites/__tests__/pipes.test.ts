import { describe, it, expect, vi } from 'vitest';
import { acceptInviteForExistingUser } from '../pipes';
import type { AcceptancePorts } from '../ports';
import type { AcceptInviteInput, Invite } from '../types';

const baseInvite = (overrides: Partial<Invite> = {}): Invite => ({
  id: 'inv_1',
  email: 'invitee@example.com',
  driveId: 'drive_1',
  driveName: 'Acme',
  role: 'MEMBER',
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

const buildStubPorts = (overrides: Partial<AcceptancePorts> = {}): AcceptancePorts => ({
  loadInvite: vi.fn().mockResolvedValue(baseInvite()),
  findExistingMembership: vi.fn().mockResolvedValue(null),
  consumeInviteAndCreateMember: vi
    .fn()
    .mockResolvedValue({ ok: true, memberId: 'mem_1' }),
  broadcastMemberAdded: vi.fn().mockResolvedValue(undefined),
  notifyMemberAdded: vi.fn().mockResolvedValue(undefined),
  trackInviteMember: vi.fn(),
  auditPermissionGranted: vi.fn(),
  ...overrides,
});

describe('acceptInviteForExistingUser', () => {
  it('given loadInvite returns null, should return TOKEN_NOT_FOUND and fire no side effects', async () => {
    const ports = buildStubPorts({ loadInvite: vi.fn().mockResolvedValue(null) });
    const result = await acceptInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_NOT_FOUND' });
    expect(ports.broadcastMemberAdded).not.toHaveBeenCalled();
    expect(ports.notifyMemberAdded).not.toHaveBeenCalled();
    expect(ports.trackInviteMember).not.toHaveBeenCalled();
    expect(ports.auditPermissionGranted).not.toHaveBeenCalled();
    expect(ports.consumeInviteAndCreateMember).not.toHaveBeenCalled();
  });

  it('given a suspended user, should return ACCOUNT_SUSPENDED before checking membership and not consume', async () => {
    const ports = buildStubPorts();
    const result = await acceptInviteForExistingUser(ports)(
      baseInput({ suspendedAt: new Date('2026-04-01') }),
    );
    expect(result).toEqual({ ok: false, error: 'ACCOUNT_SUSPENDED' });
    expect(ports.findExistingMembership).not.toHaveBeenCalled();
    expect(ports.consumeInviteAndCreateMember).not.toHaveBeenCalled();
    expect(ports.broadcastMemberAdded).not.toHaveBeenCalled();
  });

  it('given a consumed invite, should return TOKEN_CONSUMED and not call any other port', async () => {
    const ports = buildStubPorts({
      loadInvite: vi.fn().mockResolvedValue(baseInvite({ consumedAt: new Date() })),
    });
    const result = await acceptInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_CONSUMED' });
    expect(ports.consumeInviteAndCreateMember).not.toHaveBeenCalled();
  });

  it('given an expired invite, should return TOKEN_EXPIRED', async () => {
    const ports = buildStubPorts({
      loadInvite: vi
        .fn()
        .mockResolvedValue(baseInvite({ expiresAt: new Date('2026-01-01') })),
    });
    const result = await acceptInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_EXPIRED' });
    expect(ports.consumeInviteAndCreateMember).not.toHaveBeenCalled();
  });

  it('given an email mismatch, should return EMAIL_MISMATCH', async () => {
    const ports = buildStubPorts();
    const result = await acceptInviteForExistingUser(ports)(
      baseInput({ userEmail: 'different@example.com' }),
    );
    expect(result).toEqual({ ok: false, error: 'EMAIL_MISMATCH' });
    expect(ports.consumeInviteAndCreateMember).not.toHaveBeenCalled();
  });

  it('given the user is already an accepted member, should return ALREADY_MEMBER without consuming the invite', async () => {
    const ports = buildStubPorts({
      findExistingMembership: vi
        .fn()
        .mockResolvedValue({ acceptedAt: new Date('2026-04-01') }),
    });
    const result = await acceptInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'ALREADY_MEMBER' });
    expect(ports.consumeInviteAndCreateMember).not.toHaveBeenCalled();
    expect(ports.broadcastMemberAdded).not.toHaveBeenCalled();
  });

  it('given the user has a pending (unaccepted) membership, should still proceed to consume', async () => {
    const ports = buildStubPorts({
      findExistingMembership: vi.fn().mockResolvedValue({ acceptedAt: null }),
    });
    const result = await acceptInviteForExistingUser(ports)(baseInput());
    expect(result.ok).toBe(true);
    expect(ports.consumeInviteAndCreateMember).toHaveBeenCalledOnce();
  });

  it('given consume returns reason ALREADY_MEMBER (race), should propagate as ALREADY_MEMBER without firing side effects', async () => {
    const ports = buildStubPorts({
      consumeInviteAndCreateMember: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'ALREADY_MEMBER' }),
    });
    const result = await acceptInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'ALREADY_MEMBER' });
    expect(ports.broadcastMemberAdded).not.toHaveBeenCalled();
  });

  it('given consume returns reason TOKEN_CONSUMED (race), should propagate as TOKEN_CONSUMED without firing side effects', async () => {
    const ports = buildStubPorts({
      consumeInviteAndCreateMember: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'TOKEN_CONSUMED' }),
    });
    const result = await acceptInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_CONSUMED' });
    expect(ports.broadcastMemberAdded).not.toHaveBeenCalled();
  });

  it('given a valid invite for a non-suspended new member, should consume + fire all 4 side-effect ports exactly once and return AcceptedInviteData', async () => {
    const ports = buildStubPorts();
    const result = await acceptInviteForExistingUser(ports)(baseInput());

    expect(result).toEqual({
      ok: true,
      data: {
        inviteId: 'inv_1',
        inviteEmail: 'invitee@example.com',
        memberId: 'mem_1',
        driveId: 'drive_1',
        driveName: 'Acme',
        role: 'MEMBER',
        invitedUserId: 'user_invitee',
        inviterUserId: 'user_inviter',
      },
    });

    const expectedPayload = {
      inviteId: 'inv_1',
      inviteEmail: 'invitee@example.com',
      memberId: 'mem_1',
      driveId: 'drive_1',
      driveName: 'Acme',
      role: 'MEMBER',
      invitedUserId: 'user_invitee',
      inviterUserId: 'user_inviter',
    };
    expect(ports.broadcastMemberAdded).toHaveBeenCalledOnce();
    expect(ports.broadcastMemberAdded).toHaveBeenCalledWith(expectedPayload);
    expect(ports.notifyMemberAdded).toHaveBeenCalledOnce();
    expect(ports.notifyMemberAdded).toHaveBeenCalledWith(expectedPayload);
    expect(ports.trackInviteMember).toHaveBeenCalledOnce();
    expect(ports.trackInviteMember).toHaveBeenCalledWith({
      ...expectedPayload,
      permissionsGranted: 0,
    });
    expect(ports.auditPermissionGranted).toHaveBeenCalledOnce();
    expect(ports.auditPermissionGranted).toHaveBeenCalledWith(expectedPayload);
  });
});

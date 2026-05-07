import { describe, it, expect, vi } from 'vitest';
import {
  acceptInviteForExistingUser,
  acceptInviteForNewUser,
  requestMagicLink,
  revokePendingInvite,
} from '../pipes';
import type { AcceptancePorts, MagicLinkPorts, RevokePorts } from '../ports';
import type {
  AcceptInviteInput,
  Invite,
  RequestMagicLinkInput,
  RevokePendingInviteInput,
} from '../types';

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

describe('acceptInviteForNewUser', () => {
  it('given loadInvite returns null, should return TOKEN_NOT_FOUND with no side effects', async () => {
    const ports = buildStubPorts({ loadInvite: vi.fn().mockResolvedValue(null) });
    const result = await acceptInviteForNewUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_NOT_FOUND' });
    expect(ports.broadcastMemberAdded).not.toHaveBeenCalled();
    expect(ports.consumeInviteAndCreateMember).not.toHaveBeenCalled();
  });

  it('given an expired invite, should return TOKEN_EXPIRED without side effects', async () => {
    const ports = buildStubPorts({
      loadInvite: vi
        .fn()
        .mockResolvedValue(baseInvite({ expiresAt: new Date('2026-01-01') })),
    });
    const result = await acceptInviteForNewUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_EXPIRED' });
    expect(ports.consumeInviteAndCreateMember).not.toHaveBeenCalled();
  });

  it('given an email mismatch, should return EMAIL_MISMATCH', async () => {
    const ports = buildStubPorts();
    const result = await acceptInviteForNewUser(ports)(
      baseInput({ userEmail: 'different@example.com' }),
    );
    expect(result).toEqual({ ok: false, error: 'EMAIL_MISMATCH' });
    expect(ports.consumeInviteAndCreateMember).not.toHaveBeenCalled();
  });

  it('given a successful new-user acceptance, should NOT call findExistingMembership and SHOULD fire all 4 side-effect ports', async () => {
    const ports = buildStubPorts();
    const result = await acceptInviteForNewUser(ports)(baseInput());

    expect(result.ok).toBe(true);
    expect(ports.findExistingMembership).not.toHaveBeenCalled();
    expect(ports.consumeInviteAndCreateMember).toHaveBeenCalledOnce();
    expect(ports.broadcastMemberAdded).toHaveBeenCalledOnce();
    expect(ports.notifyMemberAdded).toHaveBeenCalledOnce();
    expect(ports.trackInviteMember).toHaveBeenCalledOnce();
    expect(ports.auditPermissionGranted).toHaveBeenCalledOnce();
  });

  it('given consume returns reason ALREADY_MEMBER (concurrent-create race), should propagate without firing side effects', async () => {
    const ports = buildStubPorts({
      consumeInviteAndCreateMember: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'ALREADY_MEMBER' }),
    });
    const result = await acceptInviteForNewUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'ALREADY_MEMBER' });
    expect(ports.broadcastMemberAdded).not.toHaveBeenCalled();
  });
});

const baseRevokeInput = (
  overrides: Partial<RevokePendingInviteInput> = {},
): RevokePendingInviteInput => ({
  inviteId: 'inv_1',
  driveId: 'drive_1',
  actorId: 'user_actor',
  now: new Date('2026-05-06T12:00:00.000Z'),
  ...overrides,
});

const baseRevokeRow = () => ({
  id: 'inv_1',
  email: 'pending@example.com',
  role: 'MEMBER' as const,
  driveId: 'drive_1',
});

const buildRevokePorts = (overrides: Partial<RevokePorts> = {}): RevokePorts => ({
  loadPendingInviteForDrive: vi.fn().mockResolvedValue(baseRevokeRow()),
  findActorMembership: vi
    .fn()
    .mockResolvedValue({ role: 'OWNER', acceptedAt: new Date('2026-01-01') }),
  deletePendingInviteForDrive: vi.fn().mockResolvedValue({ rowsDeleted: 1 }),
  auditPermissionRevoked: vi.fn(),
  ...overrides,
});

describe('revokePendingInvite', () => {
  it('given the invite does not exist, should return NOT_FOUND and not delete or audit', async () => {
    const ports = buildRevokePorts({
      loadPendingInviteForDrive: vi.fn().mockResolvedValue(null),
    });
    const result = await revokePendingInvite(ports)(baseRevokeInput());
    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(ports.deletePendingInviteForDrive).not.toHaveBeenCalled();
    expect(ports.auditPermissionRevoked).not.toHaveBeenCalled();
  });

  it('given the invite belongs to a different drive than the request, should return NOT_FOUND', async () => {
    const ports = buildRevokePorts({
      loadPendingInviteForDrive: vi
        .fn()
        .mockResolvedValue({ ...baseRevokeRow(), driveId: 'drive_other' }),
    });
    const result = await revokePendingInvite(ports)(baseRevokeInput());
    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(ports.deletePendingInviteForDrive).not.toHaveBeenCalled();
    expect(ports.auditPermissionRevoked).not.toHaveBeenCalled();
  });

  it('given the actor has no membership on the drive, should return FORBIDDEN', async () => {
    const ports = buildRevokePorts({
      findActorMembership: vi.fn().mockResolvedValue(null),
    });
    const result = await revokePendingInvite(ports)(baseRevokeInput());
    expect(result).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(ports.deletePendingInviteForDrive).not.toHaveBeenCalled();
  });

  it('given the actor is an accepted MEMBER (not OWNER/ADMIN), should return FORBIDDEN', async () => {
    const ports = buildRevokePorts({
      findActorMembership: vi
        .fn()
        .mockResolvedValue({ role: 'MEMBER', acceptedAt: new Date() }),
    });
    const result = await revokePendingInvite(ports)(baseRevokeInput());
    expect(result).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('given the actor is an ADMIN with acceptedAt null (pending), should return FORBIDDEN', async () => {
    const ports = buildRevokePorts({
      findActorMembership: vi
        .fn()
        .mockResolvedValue({ role: 'ADMIN', acceptedAt: null }),
    });
    const result = await revokePendingInvite(ports)(baseRevokeInput());
    expect(result).toEqual({ ok: false, error: 'FORBIDDEN' });
  });

  it('given an accepted OWNER, should delete the row, fire audit with targetEmail, and return RevokedInviteData', async () => {
    const ports = buildRevokePorts();
    const result = await revokePendingInvite(ports)(baseRevokeInput());

    expect(result).toEqual({
      ok: true,
      data: {
        inviteId: 'inv_1',
        driveId: 'drive_1',
        email: 'pending@example.com',
        role: 'MEMBER',
      },
    });
    expect(ports.deletePendingInviteForDrive).toHaveBeenCalledOnce();
    expect(ports.deletePendingInviteForDrive).toHaveBeenCalledWith({
      inviteId: 'inv_1',
      driveId: 'drive_1',
    });
    expect(ports.auditPermissionRevoked).toHaveBeenCalledOnce();
    expect(ports.auditPermissionRevoked).toHaveBeenCalledWith({
      inviteId: 'inv_1',
      driveId: 'drive_1',
      actorId: 'user_actor',
      targetEmail: 'pending@example.com',
      role: 'MEMBER',
    });
  });

  it('given an accepted ADMIN, should authorize the revoke', async () => {
    const ports = buildRevokePorts({
      findActorMembership: vi
        .fn()
        .mockResolvedValue({ role: 'ADMIN', acceptedAt: new Date() }),
    });
    const result = await revokePendingInvite(ports)(baseRevokeInput());
    expect(result.ok).toBe(true);
    expect(ports.deletePendingInviteForDrive).toHaveBeenCalledOnce();
  });
});

const baseMagicLinkInput = (
  overrides: Partial<RequestMagicLinkInput> = {},
): RequestMagicLinkInput => ({
  email: 'user@example.com',
  now: new Date('2026-05-06T12:00:00.000Z'),
  expiryMinutes: 5,
  ...overrides,
});

const buildMagicLinkPorts = (
  overrides: Partial<MagicLinkPorts> = {},
): MagicLinkPorts => ({
  loadUserByEmail: vi.fn().mockResolvedValue({ id: 'u_1', suspendedAt: null }),
  createTokenAndPersist: vi.fn().mockResolvedValue({ token: 'ps_magic_xyz' }),
  sendMagicLinkEmail: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('requestMagicLink', () => {
  it('given the email is unknown, should return NO_ACCOUNT_FOUND and never create a token or send email', async () => {
    const ports = buildMagicLinkPorts({
      loadUserByEmail: vi.fn().mockResolvedValue(null),
    });
    const result = await requestMagicLink(ports)(baseMagicLinkInput());
    expect(result).toEqual({ ok: false, error: 'NO_ACCOUNT_FOUND' });
    expect(ports.createTokenAndPersist).not.toHaveBeenCalled();
    expect(ports.sendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it('given the user is suspended, should return ACCOUNT_SUSPENDED', async () => {
    const ports = buildMagicLinkPorts({
      loadUserByEmail: vi
        .fn()
        .mockResolvedValue({ id: 'u_1', suspendedAt: new Date('2026-04-01') }),
    });
    const result = await requestMagicLink(ports)(baseMagicLinkInput());
    expect(result).toEqual({ ok: false, error: 'ACCOUNT_SUSPENDED' });
    expect(ports.createTokenAndPersist).not.toHaveBeenCalled();
    expect(ports.sendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it('given a valid user, should create a token with an expiry derived from now + expiryMinutes and send the email', async () => {
    const ports = buildMagicLinkPorts();
    const now = new Date('2026-05-06T12:00:00.000Z');
    const result = await requestMagicLink(ports)(
      baseMagicLinkInput({ now, expiryMinutes: 30 }),
    );

    expect(result).toEqual({ ok: true });
    expect(ports.createTokenAndPersist).toHaveBeenCalledOnce();
    expect(ports.createTokenAndPersist).toHaveBeenCalledWith({
      userId: 'u_1',
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      now,
    });
    expect(ports.sendMagicLinkEmail).toHaveBeenCalledOnce();
    expect(ports.sendMagicLinkEmail).toHaveBeenCalledWith({
      email: 'user@example.com',
      token: 'ps_magic_xyz',
    });
  });

  it('given platform/deviceId/deviceName, should forward them to the token-persist port', async () => {
    const ports = buildMagicLinkPorts();
    await requestMagicLink(ports)(
      baseMagicLinkInput({
        platform: 'ios',
        deviceId: 'dev_1',
        deviceName: "Jono's iPhone",
      }),
    );
    expect(ports.createTokenAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'ios',
        deviceId: 'dev_1',
        deviceName: "Jono's iPhone",
      }),
    );
  });
});

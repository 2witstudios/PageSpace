import { describe, it, expect, vi } from 'vitest';
import {
  acceptConnectionInviteForExistingUser,
  acceptConnectionInviteForNewUser,
} from '../pipes';
import type { ConnectionAcceptancePorts } from '../ports';
import type { AcceptInviteInput, ConnectionInvite } from '../types';

const baseConnectionInvite = (
  overrides: Partial<ConnectionInvite> = {},
): ConnectionInvite => ({
  id: 'cinv_1',
  email: 'invitee@example.com',
  invitedBy: 'user_inviter',
  inviterName: 'Jane Inviter',
  requestMessage: "Let's connect on PageSpace!",
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
  overrides: Partial<ConnectionAcceptancePorts> = {},
): ConnectionAcceptancePorts => ({
  loadInvite: vi.fn().mockResolvedValue(baseConnectionInvite()),
  findExistingConnection: vi.fn().mockResolvedValue(null),
  consumeInviteAndCreateConnection: vi
    .fn()
    .mockResolvedValue({ ok: true, connectionId: 'conn_1', status: 'PENDING' }),
  broadcastConnectionRequested: vi.fn().mockResolvedValue(undefined),
  notifyConnectionRequested: vi.fn().mockResolvedValue(undefined),
  auditConnectionRequested: vi.fn(),
  ...overrides,
});

describe('acceptConnectionInviteForExistingUser', () => {
  it('given loadInvite returns null, should return TOKEN_NOT_FOUND with no side effects', async () => {
    const ports = buildStubPorts({ loadInvite: vi.fn().mockResolvedValue(null) });
    const result = await acceptConnectionInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_NOT_FOUND' });
    expect(ports.consumeInviteAndCreateConnection).not.toHaveBeenCalled();
  });

  it('given a suspended user, should return ACCOUNT_SUSPENDED before lookup or consume', async () => {
    const ports = buildStubPorts();
    const result = await acceptConnectionInviteForExistingUser(ports)(
      baseInput({ suspendedAt: new Date('2026-04-01') }),
    );
    expect(result).toEqual({ ok: false, error: 'ACCOUNT_SUSPENDED' });
    expect(ports.findExistingConnection).not.toHaveBeenCalled();
    expect(ports.consumeInviteAndCreateConnection).not.toHaveBeenCalled();
  });

  it('given a consumed invite, should return TOKEN_CONSUMED', async () => {
    const ports = buildStubPorts({
      loadInvite: vi
        .fn()
        .mockResolvedValue(baseConnectionInvite({ consumedAt: new Date() })),
    });
    const result = await acceptConnectionInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_CONSUMED' });
  });

  it('given an expired invite, should return TOKEN_EXPIRED', async () => {
    const ports = buildStubPorts({
      loadInvite: vi
        .fn()
        .mockResolvedValue(baseConnectionInvite({ expiresAt: new Date('2026-01-01') })),
    });
    const result = await acceptConnectionInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_EXPIRED' });
  });

  it('given email mismatch, should return EMAIL_MISMATCH', async () => {
    const ports = buildStubPorts();
    const result = await acceptConnectionInviteForExistingUser(ports)(
      baseInput({ userEmail: 'someone-else@example.com' }),
    );
    expect(result).toEqual({ ok: false, error: 'EMAIL_MISMATCH' });
  });

  it('given an existing connection between inviter and invitee, should return ALREADY_CONNECTED without consuming', async () => {
    const ports = buildStubPorts({
      findExistingConnection: vi
        .fn()
        .mockResolvedValue({ id: 'conn_existing', status: 'ACCEPTED' }),
    });
    const result = await acceptConnectionInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'ALREADY_CONNECTED' });
    expect(ports.consumeInviteAndCreateConnection).not.toHaveBeenCalled();
  });

  it('given a valid invite, should fire 3 connection side-effect ports and return AcceptedConnectionData with PENDING status', async () => {
    const ports = buildStubPorts();
    const result = await acceptConnectionInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({
      ok: true,
      data: {
        inviteId: 'cinv_1',
        inviteEmail: 'invitee@example.com',
        connectionId: 'conn_1',
        status: 'PENDING',
        invitedUserId: 'user_invitee',
        inviterUserId: 'user_inviter',
      },
    });
    expect(ports.broadcastConnectionRequested).toHaveBeenCalledOnce();
    expect(ports.notifyConnectionRequested).toHaveBeenCalledOnce();
    expect(ports.auditConnectionRequested).toHaveBeenCalledOnce();
  });

  it('given consume returns ALREADY_CONNECTED (race), should propagate without firing side effects', async () => {
    const ports = buildStubPorts({
      consumeInviteAndCreateConnection: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'ALREADY_CONNECTED' }),
    });
    const result = await acceptConnectionInviteForExistingUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'ALREADY_CONNECTED' });
    expect(ports.broadcastConnectionRequested).not.toHaveBeenCalled();
  });

  it('given a side-effect port that throws, should still return ok', async () => {
    const ports = buildStubPorts({
      broadcastConnectionRequested: vi.fn().mockRejectedValue(new Error('ws down')),
    });
    const result = await acceptConnectionInviteForExistingUser(ports)(baseInput());
    expect(result.ok).toBe(true);
    expect(ports.notifyConnectionRequested).toHaveBeenCalledOnce();
  });
});

describe('acceptConnectionInviteForNewUser', () => {
  it('given loadInvite returns null, should return TOKEN_NOT_FOUND', async () => {
    const ports = buildStubPorts({ loadInvite: vi.fn().mockResolvedValue(null) });
    const result = await acceptConnectionInviteForNewUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_NOT_FOUND' });
  });

  it('given a successful new-user acceptance, should NOT call findExistingConnection and SHOULD fire all 3 side-effect ports', async () => {
    const ports = buildStubPorts();
    const result = await acceptConnectionInviteForNewUser(ports)(baseInput());
    expect(result.ok).toBe(true);
    expect(ports.findExistingConnection).not.toHaveBeenCalled();
    expect(ports.consumeInviteAndCreateConnection).toHaveBeenCalledOnce();
    expect(ports.broadcastConnectionRequested).toHaveBeenCalledOnce();
    expect(ports.notifyConnectionRequested).toHaveBeenCalledOnce();
    expect(ports.auditConnectionRequested).toHaveBeenCalledOnce();
  });

  it('given an email mismatch, should return EMAIL_MISMATCH and not consume', async () => {
    const ports = buildStubPorts();
    const result = await acceptConnectionInviteForNewUser(ports)(
      baseInput({ userEmail: 'different@example.com' }),
    );
    expect(result).toEqual({ ok: false, error: 'EMAIL_MISMATCH' });
    expect(ports.consumeInviteAndCreateConnection).not.toHaveBeenCalled();
  });

  it('given consume returns reason TOKEN_CONSUMED (race), should propagate without firing side effects', async () => {
    const ports = buildStubPorts({
      consumeInviteAndCreateConnection: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'TOKEN_CONSUMED' }),
    });
    const result = await acceptConnectionInviteForNewUser(ports)(baseInput());
    expect(result).toEqual({ ok: false, error: 'TOKEN_CONSUMED' });
    expect(ports.broadcastConnectionRequested).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests for the force-logout (revoke all sessions) admin route.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  withAdminAuth: <T>(handler: (admin: { id: string }, req: Request, ctx: T) => Promise<Response>) =>
    (req: Request, ctx: T) => handler({ id: 'admin-1' }, req, ctx),
}));

const { dbSelectMock, revokeAllUserSessionsMock, notifyUserSessionsRevokedMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  revokeAllUserSessionsMock: vi.fn().mockResolvedValue(2),
  notifyUserSessionsRevokedMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { select: dbSelectMock },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id' },
}));

vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: { revokeAllUserSessions: revokeAllUserSessionsMock },
}));

vi.mock('@pagespace/lib/auth/session-revocation-notify', () => ({
  notifyUserSessionsRevoked: notifyUserSessionsRevokedMock,
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

import { DELETE } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const selectResult = (rows: unknown[]) => ({
  from: () => ({ where: () => Promise.resolve(rows) }),
});

function request(body?: unknown) {
  return new NextRequest('http://localhost/api/admin/users/user-1/sessions', {
    method: 'DELETE',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const ctx = (userId = 'user-1') => ({ params: Promise.resolve({ userId }) });

describe('/api/admin/users/[userId]/sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockReset();
    revokeAllUserSessionsMock.mockResolvedValue(2);
    notifyUserSessionsRevokedMock.mockResolvedValue(undefined);
  });

  it('revokes every session for the target user and audits', async () => {
    dbSelectMock.mockReturnValueOnce(selectResult([{ id: 'user-1' }]));

    const res = await DELETE(request({ reason: 'compromised device' }), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.revokedSessions).toBe(2);
    expect(revokeAllUserSessionsMock).toHaveBeenCalledWith('user-1', 'admin_force_logout');
    expect(notifyUserSessionsRevokedMock).toHaveBeenCalledWith('user-1', 'admin_force_logout');

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        eventType: 'auth.session.revoked',
        userId: 'admin-1',
        resourceType: 'user',
        resourceId: 'user-1',
        details: expect.objectContaining({
          action: 'force_logout',
          reason: 'compromised device',
          revokedSessions: 2,
        }),
      })
    );
  });

  it('works without a body (default reason)', async () => {
    dbSelectMock.mockReturnValueOnce(selectResult([{ id: 'user-1' }]));

    const res = await DELETE(request(), ctx());
    expect(res.status).toBe(200);

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'Admin force logout' }),
      })
    );
  });

  it('reports zero revoked sessions gracefully', async () => {
    dbSelectMock.mockReturnValueOnce(selectResult([{ id: 'user-1' }]));
    revokeAllUserSessionsMock.mockResolvedValue(0);

    const res = await DELETE(request(), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.revokedSessions).toBe(0);
    expect(body.message).toContain('no active sessions');
    expect(notifyUserSessionsRevokedMock).not.toHaveBeenCalled();
  });

  it('blocks revoking your own sessions', async () => {
    const res = await DELETE(request(), ctx('admin-1'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('your own sessions');
    expect(revokeAllUserSessionsMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown user', async () => {
    dbSelectMock.mockReturnValueOnce(selectResult([]));
    const res = await DELETE(request(), ctx());
    expect(res.status).toBe(404);
    expect(revokeAllUserSessionsMock).not.toHaveBeenCalled();
  });
});

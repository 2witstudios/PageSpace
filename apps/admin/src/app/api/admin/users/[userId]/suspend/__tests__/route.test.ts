/**
 * Unit tests for the suspend/unsuspend admin route.
 * Mock-DB style mirroring the gift-subscription unit suite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/auth', () => ({
  withAdminAuth: <T>(handler: (admin: { id: string }, req: Request, ctx: T) => Promise<Response>) =>
    (req: Request, ctx: T) => handler({ id: 'admin-1' }, req, ctx),
}));

const { dbSelectMock, dbUpdateMock, setSpy, revokeAllUserSessionsMock } = vi.hoisted(() => {
  const setSpy = vi.fn((_values: Record<string, unknown>) => ({ where: () => Promise.resolve() }));
  return {
    dbSelectMock: vi.fn(),
    dbUpdateMock: vi.fn(() => ({ set: setSpy })),
    setSpy,
    revokeAllUserSessionsMock: vi.fn().mockResolvedValue(3),
  };
});

vi.mock('@pagespace/db/db', () => ({
  db: { select: dbSelectMock, update: dbUpdateMock },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', suspendedAt: 'suspendedAt' },
}));

vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: { revokeAllUserSessions: revokeAllUserSessionsMock },
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

import { POST, DELETE } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const selectResult = (rows: unknown[]) => ({
  from: () => ({ where: () => Promise.resolve(rows) }),
});

function request(method: 'POST' | 'DELETE', body?: unknown) {
  return new NextRequest('http://localhost/api/admin/users/user-1/suspend', {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const ctx = (userId = 'user-1') => ({ params: Promise.resolve({ userId }) });

describe('/api/admin/users/[userId]/suspend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockReset();
    revokeAllUserSessionsMock.mockResolvedValue(3);
  });

  describe('POST (suspend)', () => {
    it('suspends the user, revokes all sessions, and audits reason + count', async () => {
      dbSelectMock.mockReturnValueOnce(selectResult([{ id: 'user-1', suspendedAt: null }]));

      const res = await POST(request('POST', { reason: 'ToS violation' }), ctx());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.revokedSessions).toBe(3);

      const setArgs = setSpy.mock.calls[0][0] as unknown as { suspendedAt: Date; suspendedReason: string };
      expect(setArgs.suspendedAt).toBeInstanceOf(Date);
      expect(setArgs.suspendedReason).toBe('ToS violation');

      expect(revokeAllUserSessionsMock).toHaveBeenCalledWith('user-1', 'admin_suspension');

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'admin.user.suspended',
          userId: 'admin-1',
          resourceType: 'user',
          resourceId: 'user-1',
          details: expect.objectContaining({
            action: 'suspend',
            reason: 'ToS violation',
            revokedSessions: 3,
          }),
        })
      );
    });

    it('requires a non-empty reason', async () => {
      for (const body of [undefined, {}, { reason: '   ' }]) {
        const res = await POST(request('POST', body), ctx());
        expect(res.status).toBe(400);
      }
      expect(dbUpdateMock).not.toHaveBeenCalled();
      expect(revokeAllUserSessionsMock).not.toHaveBeenCalled();
    });

    it('blocks self-suspension', async () => {
      const res = await POST(request('POST', { reason: 'oops' }), ctx('admin-1'));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain('your own account');
      expect(dbUpdateMock).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown user', async () => {
      dbSelectMock.mockReturnValueOnce(selectResult([]));
      const res = await POST(request('POST', { reason: 'spam' }), ctx());
      expect(res.status).toBe(404);
    });

    it('returns 409 when the user is already suspended', async () => {
      dbSelectMock.mockReturnValueOnce(selectResult([{ id: 'user-1', suspendedAt: new Date() }]));
      const res = await POST(request('POST', { reason: 'again' }), ctx());
      expect(res.status).toBe(409);
      expect(dbUpdateMock).not.toHaveBeenCalled();
    });
  });

  describe('DELETE (unsuspend)', () => {
    it('clears suspension fields and audits', async () => {
      dbSelectMock.mockReturnValueOnce(selectResult([{ id: 'user-1', suspendedAt: new Date() }]));

      const res = await DELETE(request('DELETE', { reason: 'appeal accepted' }), ctx());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);

      expect(setSpy).toHaveBeenCalledWith({ suspendedAt: null, suspendedReason: null });

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'admin.user.reactivated',
          resourceId: 'user-1',
          details: expect.objectContaining({
            action: 'unsuspend',
            reason: 'appeal accepted',
          }),
        })
      );
    });

    it('works without a reason (defaults)', async () => {
      dbSelectMock.mockReturnValueOnce(selectResult([{ id: 'user-1', suspendedAt: new Date() }]));
      const res = await DELETE(request('DELETE'), ctx());
      expect(res.status).toBe(200);
    });

    it('returns 409 when the user is not suspended', async () => {
      dbSelectMock.mockReturnValueOnce(selectResult([{ id: 'user-1', suspendedAt: null }]));
      const res = await DELETE(request('DELETE'), ctx());
      expect(res.status).toBe(409);
      expect(dbUpdateMock).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown user', async () => {
      dbSelectMock.mockReturnValueOnce(selectResult([]));
      const res = await DELETE(request('DELETE'), ctx());
      expect(res.status).toBe(404);
    });
  });
});

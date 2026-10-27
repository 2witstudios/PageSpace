/**
 * Unit tests for the change-role admin route.
 * Critical guard: an admin must never be able to change their OWN role.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  withAdminAuth: <T>(handler: (admin: { id: string }, req: Request, ctx: T) => Promise<Response>) =>
    (req: Request, ctx: T) => handler({ id: 'admin-1' }, req, ctx),
}));

const { dbSelectMock, updateUserRoleMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  updateUserRoleMock: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { select: dbSelectMock },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', role: 'role' },
}));

vi.mock('@/lib/auth/admin-role', () => ({
  updateUserRole: updateUserRoleMock,
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

import { PATCH } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const selectResult = (rows: unknown[]) => ({
  from: () => ({ where: () => Promise.resolve(rows) }),
});

function request(body?: unknown) {
  return new NextRequest('http://localhost/api/admin/users/user-1/role', {
    method: 'PATCH',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const ctx = (userId = 'user-1') => ({ params: Promise.resolve({ userId }) });

describe('/api/admin/users/[userId]/role', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockReset();
    updateUserRoleMock.mockResolvedValue({ id: 'user-1', role: 'admin', adminRoleVersion: 1 });
  });

  it('promotes a user to admin via updateUserRole and audits role + reason', async () => {
    dbSelectMock.mockReturnValueOnce(selectResult([{ id: 'user-1', role: 'user' }]));

    const res = await PATCH(request({ role: 'admin', reason: 'new hire' }), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.role).toBe('admin');
    expect(updateUserRoleMock).toHaveBeenCalledWith('user-1', 'admin');

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        eventType: 'authz.role.assigned',
        userId: 'admin-1',
        resourceType: 'user',
        resourceId: 'user-1',
        details: expect.objectContaining({
          action: 'change_role',
          previousRole: 'user',
          newRole: 'admin',
          reason: 'new hire',
        }),
      })
    );
  });

  it('demotes an admin and audits authz.role.removed', async () => {
    dbSelectMock.mockReturnValueOnce(selectResult([{ id: 'user-1', role: 'admin' }]));
    updateUserRoleMock.mockResolvedValue({ id: 'user-1', role: 'user', adminRoleVersion: 2 });

    const res = await PATCH(request({ role: 'user', reason: 'offboarding' }), ctx());

    expect(res.status).toBe(200);
    expect(updateUserRoleMock).toHaveBeenCalledWith('user-1', 'user');
    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        eventType: 'authz.role.removed',
        details: expect.objectContaining({ newRole: 'user', reason: 'offboarding' }),
      })
    );
  });

  it('blocks admins from changing their OWN role', async () => {
    const res = await PATCH(request({ role: 'user', reason: 'self-demotion attempt' }), ctx('admin-1'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('your own role');
    expect(updateUserRoleMock).not.toHaveBeenCalled();
  });

  it('requires a valid role and a non-empty reason', async () => {
    for (const body of [undefined, {}, { role: 'superadmin', reason: 'x' }, { role: 'admin' }, { role: 'admin', reason: '  ' }]) {
      const res = await PATCH(request(body), ctx());
      expect(res.status).toBe(400);
    }
    expect(updateUserRoleMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown user', async () => {
    dbSelectMock.mockReturnValueOnce(selectResult([]));
    const res = await PATCH(request({ role: 'admin', reason: 'promote' }), ctx());
    expect(res.status).toBe(404);
    expect(updateUserRoleMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the user already has the requested role (no pointless version bump)', async () => {
    dbSelectMock.mockReturnValueOnce(selectResult([{ id: 'user-1', role: 'admin' }]));
    const res = await PATCH(request({ role: 'admin', reason: 'promote' }), ctx());
    expect(res.status).toBe(409);
    expect(updateUserRoleMock).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests for the suspend/unsuspend admin route.
 *
 * The suspension itself lives in @pagespace/lib/auth/suspend-user (shared with
 * content takedowns, and tested against Postgres there); this file covers what
 * the route owns: validation, the self-suspension guard, status mapping, audit,
 * and the "also unpublish this user's published sites" option.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  withAdminAuth: <T>(handler: (admin: { id: string }, req: Request, ctx: T) => Promise<Response>) =>
    (req: Request, ctx: T) => handler({ id: 'admin-1' }, req, ctx),
}));

const { suspendUserMock, unsuspendUserMock, callWebTakedownMock, holdRowsMock } = vi.hoisted(() => ({
  suspendUserMock: vi.fn(),
  unsuspendUserMock: vi.fn(),
  callWebTakedownMock: vi.fn(),
  holdRowsMock: vi.fn(),
}));

vi.mock('@pagespace/lib/auth/suspend-user', () => ({
  suspendUser: suspendUserMock,
  unsuspendUser: unsuspendUserMock,
}));
vi.mock('@/lib/content/web-takedown', () => ({ callWebTakedown: callWebTakedownMock }));

vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => holdRowsMock() }) }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/content-safety', () => ({
  contentSiteHolds: { driveId: 'driveId', holder: 'holder' },
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
    suspendUserMock.mockResolvedValue({ status: 'suspended', revokedSessions: 3 });
    unsuspendUserMock.mockResolvedValue({ status: 'reactivated' });
    holdRowsMock.mockResolvedValue([]);
    callWebTakedownMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: { action: 'park_user_sites', caseId: 'case-1', status: 'actioned', parkedDriveIds: ['drive-1'], skippedDrives: [] },
    });
  });

  describe('POST (suspend)', () => {
    it('suspends the user through the shared function, and audits reason + revoked session count', async () => {
      const res = await POST(request('POST', { reason: 'ToS violation' }), ctx());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.revokedSessions).toBe(3);
      expect(suspendUserMock).toHaveBeenCalledWith({ userId: 'user-1', reason: 'ToS violation' });

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

    it('leaves published sites alone unless asked to park them', async () => {
      const res = await POST(request('POST', { reason: 'ToS violation' }), ctx());

      expect(callWebTakedownMock).not.toHaveBeenCalled();
      expect((await res.json()).sites).toBeUndefined();
    });

    it('requires a non-empty reason', async () => {
      for (const body of [undefined, {}, { reason: '   ' }]) {
        const res = await POST(request('POST', body), ctx());
        expect(res.status).toBe(400);
      }
      expect(suspendUserMock).not.toHaveBeenCalled();
    });

    it('blocks self-suspension', async () => {
      const res = await POST(request('POST', { reason: 'oops' }), ctx('admin-1'));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toContain('your own account');
      expect(suspendUserMock).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown user', async () => {
      suspendUserMock.mockResolvedValue({ status: 'not_found' });
      const res = await POST(request('POST', { reason: 'spam' }), ctx());
      expect(res.status).toBe(404);
    });

    it('returns 409 when the user is already suspended, and parks nothing', async () => {
      suspendUserMock.mockResolvedValue({ status: 'already_suspended' });
      const res = await POST(request('POST', { reason: 'again', parkSites: true }), ctx());

      expect(res.status).toBe(409);
      expect(callWebTakedownMock).not.toHaveBeenCalled();
      expect(auditRequest).not.toHaveBeenCalled();
    });

    describe('with parkSites', () => {
      it('parks the user\'s sites through the web app and reports what was parked', async () => {
        const res = await POST(request('POST', { reason: 'abuse', parkSites: true }), ctx());
        const body = await res.json();

        expect(callWebTakedownMock).toHaveBeenCalledWith({ action: 'park_user_sites', userId: 'user-1', reason: 'abuse' }, 'admin-1');
        expect(body.sites).toEqual({ caseId: 'case-1', parkedDriveIds: ['drive-1'], skippedDrives: [] });
        expect(body.message).toContain('1 drive(s) had their published sites parked');
      });

      it('reports org drives with other members as skipped, for an admin to decide', async () => {
        callWebTakedownMock.mockResolvedValue({
          ok: true,
          status: 200,
          body: {
            action: 'park_user_sites',
            caseId: 'case-1',
            status: 'actioned',
            parkedDriveIds: [],
            skippedDrives: [{ driveId: 'drive-9', reason: 'org_drive_with_other_members' }],
          },
        });

        const body = await (await POST(request('POST', { reason: 'abuse', parkSites: true }), ctx())).json();

        expect(body.sites.skippedDrives).toEqual([{ driveId: 'drive-9', reason: 'org_drive_with_other_members' }]);
        expect(body.message).toContain('need a decision');
      });

      it('audits the parking as its own event, separate from the suspension', async () => {
        await POST(request('POST', { reason: 'abuse', parkSites: true }), ctx());

        expect(auditRequest).toHaveBeenCalledWith(
          expect.any(Request),
          expect.objectContaining({
            eventType: 'content.takedown.sites_parked',
            userId: 'admin-1',
            resourceType: 'user',
            resourceId: 'user-1',
            details: expect.objectContaining({ caseId: 'case-1', parkedDriveIds: ['drive-1'], outcome: 'completed' }),
          }),
        );
      });

      it('keeps the suspension and says so plainly when the sites could not be parked', async () => {
        callWebTakedownMock.mockResolvedValue({ ok: false, status: 503, error: 'Content takedown is not configured on this host.' });

        const res = await POST(request('POST', { reason: 'abuse', parkSites: true }), ctx());
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.sites.error).toContain('not configured');
        expect(body.message).toContain('could NOT be parked');
        expect(auditRequest).toHaveBeenCalledWith(
          expect.any(Request),
          expect.objectContaining({ eventType: 'content.takedown.sites_parked', details: expect.objectContaining({ outcome: 'not_configured' }) }),
        );
      });

      it('stores a code in the audit log, never the raw error with its hostnames and storage text', async () => {
        callWebTakedownMock.mockResolvedValue({
          ok: true,
          status: 200,
          body: { action: 'park_user_sites', caseId: 'case-1', status: 'open', failedStep: 'park_sites', error: 'Could not park acme.example.com: SlowDown at s3://bucket' },
        });

        await POST(request('POST', { reason: 'abuse', parkSites: true }), ctx());

        const audited = JSON.stringify(vi.mocked(auditRequest).mock.calls.map(([, event]) => event));
        expect(audited).not.toContain('acme.example.com');
        expect(audited).not.toContain('SlowDown');
        expect(audited).toContain('"sitesError":"step_failed"');
        expect(audited).toContain('"outcome":"step_failed"');
      });

      it('reports a parking step that failed part-way', async () => {
        callWebTakedownMock.mockResolvedValue({
          ok: true,
          status: 200,
          body: { action: 'park_user_sites', caseId: 'case-1', status: 'open', failedStep: 'park_sites', error: 'Could not park acme' },
        });

        const body = await (await POST(request('POST', { reason: 'abuse', parkSites: true }), ctx())).json();
        expect(body.sites).toMatchObject({ caseId: 'case-1', error: 'Could not park acme' });
      });
    });
  });

  describe('DELETE (unsuspend)', () => {
    it('lifts the suspension through the shared function and audits', async () => {
      const res = await DELETE(request('DELETE', { reason: 'appeal accepted' }), ctx());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(unsuspendUserMock).toHaveBeenCalledWith('user-1');

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
      const res = await DELETE(request('DELETE'), ctx());
      expect(res.status).toBe(200);
    });

    it('returns 409 when the user is not suspended', async () => {
      unsuspendUserMock.mockResolvedValue({ status: 'not_suspended' });
      const res = await DELETE(request('DELETE'), ctx());
      expect(res.status).toBe(409);
    });

    it('returns 404 for an unknown user', async () => {
      unsuspendUserMock.mockResolvedValue({ status: 'not_found' });
      const res = await DELETE(request('DELETE'), ctx());
      expect(res.status).toBe(404);
    });

    it('does not call the web app when the suspension parked nothing', async () => {
      await DELETE(request('DELETE'), ctx());
      expect(callWebTakedownMock).not.toHaveBeenCalled();
    });

    it('restores the sites the suspension parked, and audits it', async () => {
      holdRowsMock.mockResolvedValue([{ driveId: 'drive-1' }]);
      callWebTakedownMock.mockResolvedValue({ ok: true, status: 200, body: { action: 'restore_user_sites', restoredDriveIds: ['drive-1'] } });

      const body = await (await DELETE(request('DELETE'), ctx())).json();

      expect(callWebTakedownMock).toHaveBeenCalledWith({ action: 'restore_user_sites', userId: 'user-1' }, 'admin-1');
      expect(body.sites).toEqual({ restoredDriveIds: ['drive-1'], stillHeldDriveIds: [] });
      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({ eventType: 'content.takedown.sites_restored', resourceId: 'user-1' }),
      );
    });

    it('says so when a takedown still holds one of the drives', async () => {
      holdRowsMock.mockResolvedValue([{ driveId: 'drive-1' }]);
      callWebTakedownMock.mockResolvedValue({
        ok: true,
        status: 200,
        body: { action: 'restore_user_sites', restoredDriveIds: [], stillHeldDriveIds: ['drive-1'] },
      });

      const body = await (await DELETE(request('DELETE'), ctx())).json();
      expect(body.message).toContain('stay parked');
    });

    it('still lifts the suspension, and says so, when the sites could not be restored', async () => {
      holdRowsMock.mockResolvedValue([{ driveId: 'drive-1' }]);
      callWebTakedownMock.mockResolvedValue({ ok: false, status: 502, error: 'Failed to reach the web app.' });

      const res = await DELETE(request('DELETE'), ctx());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.message).toContain('could not be restored');
    });
  });
});

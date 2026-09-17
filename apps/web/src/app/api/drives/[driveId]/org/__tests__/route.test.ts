import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult } from '@/lib/auth';

const { orgsFlag } = vi.hoisted(() => ({ orgsFlag: { enabled: true } }));

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return orgsFlag.enabled;
  },
}));

vi.mock('@pagespace/lib/services/org-drive-service', () => ({
  moveDriveToOrg: vi.fn(),
  moveDriveOutOfOrg: vi.fn(),
}));

vi.mock('@pagespace/lib/services/org-drive-service-deps', () => ({
  orgDriveServiceDeps: { marker: 'production-deps' },
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue(['user-marcus', 'user-lena']),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn().mockResolvedValue(undefined),
  createDriveEventPayload: vi.fn((driveId: string, operation: string, options: object) => ({ driveId, operation, ...options })),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { PUT, DELETE } from '../route';
import { moveDriveToOrg, moveDriveOutOfOrg } from '@pagespace/lib/services/org-drive-service';
import { orgDriveServiceDeps } from '@pagespace/lib/services/org-drive-service-deps';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { broadcastDriveEvent } from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const MARCUS = 'user-marcus';
const PRIYA = 'user-priya';
const DRIVE = 'drive-product';
const NORTHWIND = 'org-northwind';

const session = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'session-1',
  role: 'user',
  adminRoleVersion: 0,
});

const context = { params: Promise.resolve({ driveId: DRIVE }) };

const request = (method: 'PUT' | 'DELETE', body: unknown) =>
  new Request(`https://example.com/api/drives/${DRIVE}/org`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const product = { id: DRIVE, name: 'Product', slug: 'product' };
const deferred = { status: 'deferred' as const, leafId: 't1759m6mfxrj5hyaleu1mdqs' as const };

describe('/api/drives/[driveId]/org', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgsFlag.enabled = true;
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(MARCUS));
  });

  describe('PUT (move in)', () => {
    it('DRV-2 (partial) moves the drive in with the caller, body and production deps, then audits and broadcasts', async () => {
      vi.mocked(moveDriveToOrg).mockResolvedValue({
        ok: true,
        drive: { ...product, orgId: NORTHWIND } as never,
        orgId: NORTHWIND,
        storageReattribution: deferred,
      });

      const response = await PUT(request('PUT', { orgId: NORTHWIND }), context);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ drive: { id: DRIVE, orgId: NORTHWIND }, storageReattribution: deferred });
      expect(moveDriveToOrg).toHaveBeenCalledWith(MARCUS, DRIVE, { orgId: NORTHWIND }, orgDriveServiceDeps);
      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          userId: MARCUS,
          resourceType: 'drive',
          resourceId: DRIVE,
          details: { operation: 'org_move_in', orgId: NORTHWIND, storageReattribution: 'deferred' },
        })
      );
      expect(broadcastDriveEvent).toHaveBeenCalledWith(
        expect.objectContaining({ driveId: DRIVE, operation: 'updated' }),
        ['user-marcus', 'user-lena']
      );
    });

    it('DRV-2 (partial) a committed move still answers 200 when the post-commit recipient lookup fails', async () => {
      vi.mocked(moveDriveToOrg).mockResolvedValue({
        ok: true,
        drive: { ...product, orgId: NORTHWIND } as never,
        orgId: NORTHWIND,
        storageReattribution: deferred,
      });
      vi.mocked(getDriveRecipientUserIds).mockRejectedValueOnce(new Error('connection reset'));

      const response = await PUT(request('PUT', { orgId: NORTHWIND }), context);

      expect(response.status).toBe(200);
      expect(auditRequest).toHaveBeenCalled();
      expect(broadcastDriveEvent).not.toHaveBeenCalled();
    });

    it('DRV-1 (partial) a refusal from the service returns its status, message and code, and nothing is audited', async () => {
      vi.mocked(moveDriveToOrg).mockResolvedValue({
        ok: false,
        code: 'HOME_DRIVE',
        status: 403,
        message: 'Your Home drive is your own space and cannot be moved into an organization.',
      });

      const response = await PUT(request('PUT', { orgId: NORTHWIND }), context);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Your Home drive is your own space and cannot be moved into an organization.',
        code: 'HOME_DRIVE',
      });
      expect(auditRequest).not.toHaveBeenCalled();
      expect(broadcastDriveEvent).not.toHaveBeenCalled();
    });

    it('DRV-4 (partial) passes a chosen visibility through and rejects an unknown one', async () => {
      vi.mocked(moveDriveToOrg).mockResolvedValue({
        ok: true,
        drive: product as never,
        orgId: NORTHWIND,
        storageReattribution: deferred,
      });

      await PUT(request('PUT', { orgId: NORTHWIND, orgVisibility: 'RESTRICTED' }), context);
      expect(moveDriveToOrg).toHaveBeenCalledWith(MARCUS, DRIVE, { orgId: NORTHWIND, orgVisibility: 'RESTRICTED' }, orgDriveServiceDeps);

      const bad = await PUT(request('PUT', { orgId: NORTHWIND, orgVisibility: 'PUBLIC' }), context);
      expect(bad.status).toBe(400);
      expect(moveDriveToOrg).toHaveBeenCalledTimes(1);
    });

    it('DRV-2 (partial) an unauthenticated caller is refused before the service runs', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
        error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      });

      const response = await PUT(request('PUT', { orgId: NORTHWIND }), context);

      expect(response.status).toBe(401);
      expect(moveDriveToOrg).not.toHaveBeenCalled();
    });

    it('is session-only with CSRF', async () => {
      vi.mocked(moveDriveToOrg).mockResolvedValue({ ok: false, code: 'NOT_DRIVE_OWNER', status: 403, message: 'no' });

      await PUT(request('PUT', { orgId: NORTHWIND }), context);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(expect.any(Request), { allow: ['session'], requireCSRF: true });
    });
  });

  describe('DELETE (move out)', () => {
    it.each(['keep', 'remove'] as const)(
      'D-OW-10 passes the "%s" choice to the service and audits the org the drive left',
      async (implicitMembers) => {
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(PRIYA));
        vi.mocked(moveDriveOutOfOrg).mockResolvedValue({
          ok: true,
          drive: { ...product, orgId: null } as never,
          orgId: NORTHWIND,
          storageReattribution: deferred,
        });

        const response = await DELETE(request('DELETE', { implicitMembers }), context);

        expect(response.status).toBe(200);
        expect(moveDriveOutOfOrg).toHaveBeenCalledWith(PRIYA, DRIVE, { implicitMembers }, orgDriveServiceDeps);
        expect(auditRequest).toHaveBeenCalledWith(
          expect.any(Request),
          expect.objectContaining({ details: { operation: 'org_move_out', orgId: NORTHWIND, storageReattribution: 'deferred' } })
        );
      }
    );

    it('D-OW-10 a move-out without the keep-or-remove choice is a 400 and never reaches the service', async () => {
      const response = await DELETE(request('DELETE', {}), context);

      expect(response.status).toBe(400);
      expect(moveDriveOutOfOrg).not.toHaveBeenCalled();
    });

    it('DRV-2 (partial) an org Member is refused with the service verdict', async () => {
      vi.mocked(moveDriveOutOfOrg).mockResolvedValue({
        ok: false,
        code: 'NOT_ORG_ADMIN',
        status: 403,
        message: 'Only an organization Owner or Admin can move a drive out.',
      });

      const response = await DELETE(request('DELETE', { implicitMembers: 'remove' }), context);

      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('NOT_ORG_ADMIN');
    });
  });

  it.each([
    ['PUT', { orgId: NORTHWIND }],
    ['DELETE', { implicitMembers: 'keep' }],
  ] as const)('%s answers 404 and does nothing while ORGS_ENABLED is false', async (method, body) => {
    orgsFlag.enabled = false;
    const handler = method === 'PUT' ? PUT : DELETE;

    const response = await handler(request(method, body), context);

    expect(response.status).toBe(404);
    expect(authenticateRequestWithOptions).not.toHaveBeenCalled();
    expect(moveDriveToOrg).not.toHaveBeenCalled();
    expect(moveDriveOutOfOrg).not.toHaveBeenCalled();
  });
});

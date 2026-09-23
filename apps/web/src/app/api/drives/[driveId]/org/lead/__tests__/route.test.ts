import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

const { orgsFlag } = vi.hoisted(() => ({ orgsFlag: { enabled: true } }));

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return orgsFlag.enabled;
  },
}));
vi.mock('@pagespace/lib/services/org-drive-service', () => ({ changeOrgDriveLead: vi.fn() }));
vi.mock('@pagespace/lib/services/org-drive-service-deps', () => ({ orgDriveServiceDeps: { marker: 'production-deps' } }));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue(['user-lena', 'user-priya']),
}));
vi.mock('@pagespace/lib/permissions/drive-relationship-loader', () => ({
  recordOrgPowerDriveAction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
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

import { PUT } from '../route';
import { changeOrgDriveLead } from '@pagespace/lib/services/org-drive-service';
import { orgDriveServiceDeps } from '@pagespace/lib/services/org-drive-service-deps';
import { recordOrgPowerDriveAction } from '@pagespace/lib/permissions/drive-relationship-loader';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { broadcastDriveEvent } from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const PRIYA = 'user-priya';
const MARCUS = 'user-marcus';
const LENA = 'user-lena';
const DRIVE = 'drive-product';
const NORTHWIND = 'org-northwind';

const session = (userId: string): SessionAuthResult => ({
  userId, tokenVersion: 0, tokenType: 'session', sessionId: 'session-1', role: 'user', adminRoleVersion: 0,
});
const context = { params: Promise.resolve({ driveId: DRIVE }) };
const put = (body: unknown) =>
  new Request(`https://example.com/api/drives/${DRIVE}/org/lead`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
const handedOver = { id: DRIVE, name: 'Product', slug: 'product', ownerId: LENA, orgId: NORTHWIND, orgVisibility: 'OPEN' };

describe('PUT /api/drives/[driveId]/org/lead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgsFlag.enabled = true;
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(PRIYA));
  });

  it('DRV-1 (partial) hands the drive over as the caller with production deps, audits both people, records org power on the drive as it was, and broadcasts', async () => {
    vi.mocked(changeOrgDriveLead).mockResolvedValue({ ok: true, changed: true, drive: handedOver as never, fromUserId: MARCUS, toUserId: LENA });

    const response = await PUT(put({ userId: LENA }), context);

    expect(response.status).toBe(200);
    expect(changeOrgDriveLead).toHaveBeenCalledWith(PRIYA, DRIVE, { newLeadId: LENA }, orgDriveServiceDeps);
    expect(authenticateRequestWithOptions).toHaveBeenCalledWith(expect.any(Request), { allow: ['session'], requireCSRF: true });
    expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({
      userId: PRIYA,
      resourceId: DRIVE,
      details: { operation: 'org_drive_lead_change', orgId: NORTHWIND, fromUserId: MARCUS, toUserId: LENA },
    }));
    expect(recordOrgPowerDriveAction).toHaveBeenCalledWith(PRIYA, { ...handedOver, ownerId: MARCUS }, 'change_lead');
    expect(broadcastDriveEvent).toHaveBeenCalledWith(expect.objectContaining({ driveId: DRIVE, operation: 'updated' }), ['user-lena', 'user-priya']);
  });

  it('D-OW-7 a target outside the org is refused with the service verdict and nothing is audited', async () => {
    vi.mocked(changeOrgDriveLead).mockResolvedValue({ ok: false, code: 'TARGET_NOT_ORG_MEMBER', status: 409, message: 'no' });

    const response = await PUT(put({ userId: 'user-chris' }), context);

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('TARGET_NOT_ORG_MEMBER');
    expect(auditRequest).not.toHaveBeenCalled();
    expect(broadcastDriveEvent).not.toHaveBeenCalled();
  });

  it('DRV-1 (partial) a body without a target is rejected before the service runs', async () => {
    expect((await PUT(put({}), context)).status).toBe(400);
    expect(changeOrgDriveLead).not.toHaveBeenCalled();
  });

  it('answers 404 and does nothing while ORGS_ENABLED is false', async () => {
    orgsFlag.enabled = false;

    expect((await PUT(put({ userId: LENA }), context)).status).toBe(404);
    expect(authenticateRequestWithOptions).not.toHaveBeenCalled();
    expect(changeOrgDriveLead).not.toHaveBeenCalled();
  });
});

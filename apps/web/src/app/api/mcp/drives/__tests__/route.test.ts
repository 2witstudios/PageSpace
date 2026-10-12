import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => {
  const driveRow = { id: 'drv-1', name: 'New', slug: 'new', ownerId: 'u1', kind: 'STANDARD', isTrashed: false, trashedAt: null, drivePrompt: null, createdAt: new Date(), updatedAt: new Date() };
  const makeInsert = () => vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([driveRow]) })) }));
  return {
    db: {
      insert: makeInsert(),
      query: { drives: { findFirst: vi.fn() } },
      // POST /api/mcp/drives wraps insert + allocatePublishSubdomain in a transaction.
      transaction: vi.fn(async (cb: (tx: { insert: ReturnType<typeof makeInsert> }) => Promise<unknown>) => cb({ insert: makeInsert() })),
    },
  };
});

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'id', name: 'name', slug: 'slug', ownerId: 'ownerId', isTrashed: 'isTrashed' },
}));

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('@pagespace/lib/organizations/authentication-policy', () => ({
  checkOrgAuthentication: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@pagespace/lib/services/org-drive-service', () => ({ createOrgDrive: vi.fn() }));
vi.mock('@pagespace/lib/services/org-drive-service-deps', () => ({ orgDriveServiceDeps: { production: true } }));

vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn().mockResolvedValue(undefined),
  createDriveEventPayload: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({}),
  logDriveActivity: vi.fn(),
}));

const personalDrive = { id: 'drv-1', name: 'My Project', slug: 'my-project', ownerId: 'user-1', orgId: null, isOwned: true, role: 'OWNER', canCreatePages: true, lastAccessedAt: null };
vi.mock('@pagespace/lib/services/drive-service', () => ({
  listAccessibleDrives: vi.fn().mockResolvedValue([]),
  createDrive: vi.fn(async () => personalDrive),
}));

vi.mock('@pagespace/lib/permissions/app-permissions', () => ({
  getAppDriveMembership: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateMCPRequest: vi.fn(),
  isAuthError: vi.fn(() => false),
  isMCPAuthResult: vi.fn(() => false),
}));

import { POST } from '../route';
import { authenticateMCPRequest, isAuthError, isMCPAuthResult } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { createDrive } from '@pagespace/lib/services/drive-service';
import { createOrgDrive } from '@pagespace/lib/services/org-drive-service';
import { orgDriveServiceDeps } from '@pagespace/lib/services/org-drive-service-deps';

const post = (body: unknown) =>
  POST(new Request('https://example.com/api/mcp/drives', { method: 'POST', body: JSON.stringify(body) }) as Parameters<typeof POST>[0]);

const mockSessionAuth = (userId = 'user-1') => ({
  userId,
  tokenType: 'mcp' as const,
  tokenVersion: 0,
  sessionId: 's1',
  role: 'user' as const,
  adminRoleVersion: 0,
  tokenId: 'tok-1',
  allowedDriveIds: [],
});

describe('POST /api/mcp/drives — reserved name guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateMCPRequest).mockResolvedValue(mockSessionAuth());
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('rejects "Home" drive name with 400', async () => {
    const req = new Request('https://example.com/api/mcp/drives', {
      method: 'POST',
      body: JSON.stringify({ name: 'Home' }),
    });
    const res = await POST(req as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it('rejects "home" drive name (case-insensitive) with 400', async () => {
    const req = new Request('https://example.com/api/mcp/drives', {
      method: 'POST',
      body: JSON.stringify({ name: 'home' }),
    });
    const res = await POST(req as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it('rejects "Personal" drive name with 400', async () => {
    const req = new Request('https://example.com/api/mcp/drives', {
      method: 'POST',
      body: JSON.stringify({ name: 'Personal' }),
    });
    const res = await POST(req as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it('allows normal drive names', async () => {
    const req = new Request('https://example.com/api/mcp/drives', {
      method: 'POST',
      body: JSON.stringify({ name: 'My Project' }),
    });
    const res = await POST(req as Parameters<typeof POST>[0]);
    expect(res.status).toBe(201);
  });
});

describe('POST /api/mcp/drives — DRV-3 creates through the drive service, personal or in an org', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateMCPRequest).mockResolvedValue(mockSessionAuth());
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isMCPAuthResult).mockReturnValue(true);
  });

  it('DRV-3 (partial) with no orgId the drive is personal and created by the drive service, never inserted here', async () => {
    const res = await post({ name: 'My Project' });
    expect(res.status).toBe(201);
    expect(createDrive).toHaveBeenCalledWith('user-1', expect.objectContaining({ name: 'My Project' }));
    expect(createOrgDrive).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('DRV-3 (partial) an orgId creates the drive org-owned through createOrgDrive with the production deps, and its refusal is relayed', async () => {
    vi.mocked(createOrgDrive).mockResolvedValueOnce({ ok: true, drive: { ...personalDrive, orgId: 'org_nw' } as never });
    const res = await post({ name: 'Engineering', orgId: 'org_nw' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ orgId: 'org_nw', isOwned: true, role: 'OWNER' });
    expect(createOrgDrive).toHaveBeenCalledWith('user-1', expect.objectContaining({ name: 'Engineering', orgId: 'org_nw' }), orgDriveServiceDeps);
    expect(createDrive).not.toHaveBeenCalled();

    vi.mocked(createOrgDrive).mockResolvedValueOnce({ ok: false, code: 'POLICY_FORBIDS_CREATE', status: 403, message: 'Only organization Owners and Admins can create drives in this organization.' });
    const refused = await post({ name: 'Engineering', orgId: 'org_nw' });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'POLICY_FORBIDS_CREATE' });
  });

  it('DRV-3 (partial) a drive-scoped token creates nothing, in an org or not', async () => {
    vi.mocked(authenticateMCPRequest).mockResolvedValue({ ...mockSessionAuth(), allowedDriveIds: ['d1'] });
    expect((await post({ name: 'Engineering', orgId: 'org_nw' })).status).toBe(403);
    expect(createOrgDrive).not.toHaveBeenCalled();
    expect(createDrive).not.toHaveBeenCalled();
  });
});

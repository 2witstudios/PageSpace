/**
 * Contract tests for DELETE /api/drives/[driveId]/domains/[domainId]
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DELETE } from '../route';

vi.mock('server-only', () => ({}));

const authenticateRequestWithOptions = vi.fn();
const checkMCPDriveScope = vi.fn();
const isPrincipalDriveOwnerOrAdmin = vi.fn();
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => authenticateRequestWithOptions(...args),
  isAuthError: (result: unknown) => typeof result === 'object' && result !== null && 'error' in result,
  checkMCPDriveScope: (...args: unknown[]) => checkMCPDriveScope(...args),
  isPrincipalDriveOwnerOrAdmin: (...args: unknown[]) => isPrincipalDriveOwnerOrAdmin(...args),
}));

const auditRequest = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => auditRequest(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

const dbDelete = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    delete: (...args: unknown[]) => dbDelete(...args),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
}));
vi.mock('@pagespace/db/schema/custom-domains', () => ({
  customDomains: {
    id: 'col_id',
    driveId: 'col_driveId',
    hostname: 'col_hostname',
    status: 'col_status',
    createdAt: 'col_createdAt',
  },
}));

const DRIVE_ID = 'drive-1';
const DOMAIN_ID = 'dom-1';
const USER_ID = 'user-1';
const mockAuth = { userId: USER_ID };
const makeReq = (): Request => ({} as unknown as Request);
const ctx = (driveId = DRIVE_ID, domainId = DOMAIN_ID) => ({
  params: Promise.resolve({ driveId, domainId }),
});

beforeEach(() => {
  vi.clearAllMocks();
  authenticateRequestWithOptions.mockResolvedValue(mockAuth);
  checkMCPDriveScope.mockReturnValue(null);
  isPrincipalDriveOwnerOrAdmin.mockResolvedValue(true);
});

describe('DELETE /api/drives/[driveId]/domains/[domainId]', () => {
  it('returns 401 when not authenticated', async () => {
    authenticateRequestWithOptions.mockResolvedValue({ error: new Response(null, { status: 401 }) });
    const res = await DELETE(makeReq(), ctx());
    expect(res.status).toBe(401);
  });

  it('returns scope error when MCP token is out of scope', async () => {
    checkMCPDriveScope.mockReturnValue(new Response(null, { status: 403 }));
    const res = await DELETE(makeReq(), ctx());
    expect(res.status).toBe(403);
  });

  it('returns 403 when caller is not owner/admin', async () => {
    isPrincipalDriveOwnerOrAdmin.mockResolvedValue(false);
    const res = await DELETE(makeReq(), ctx());
    expect(res.status).toBe(403);
  });

  it('returns 404 when domain not found or belongs to different drive', async () => {
    dbDelete.mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) });
    const res = await DELETE(makeReq(), ctx());
    expect(res.status).toBe(404);
  });

  it('returns 200 + deleted:true on success', async () => {
    const deleted = { id: DOMAIN_ID, driveId: DRIVE_ID, hostname: 'acme.com', status: 'pending', createdAt: new Date() };
    dbDelete.mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([deleted]) }) });

    const res = await DELETE(makeReq(), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.deleted).toBe(true);
  });

  it('calls auditRequest on successful delete', async () => {
    const deleted = { id: DOMAIN_ID, driveId: DRIVE_ID, hostname: 'acme.com', status: 'pending', createdAt: new Date() };
    dbDelete.mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([deleted]) }) });

    await DELETE(makeReq(), ctx());
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'data.delete',
      details: expect.objectContaining({ operation: 'remove-custom-domain', hostname: 'acme.com' }),
    }));
  });

  it('returns 500 on unexpected db error', async () => {
    dbDelete.mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockRejectedValue(new Error('db down')) }) });
    const res = await DELETE(makeReq(), ctx());
    expect(res.status).toBe(500);
  });
});

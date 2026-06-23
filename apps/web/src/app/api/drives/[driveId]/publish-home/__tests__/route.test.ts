/**
 * Contract tests for POST /api/drives/[driveId]/publish-home
 *
 * Verifies the manual home-page (re)publish handler:
 * - Auth + MCP-scope gating
 * - Owner/admin-only enforcement (403)
 * - Publishing-not-configured short-circuit (503)
 * - 400 when the drive has no canvas home page / subdomain (null result)
 * - 200 + audit on success
 * - 500 on unexpected publish failure
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '../route';

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

const publishHomePageAtRoot = vi.fn();
vi.mock('@/lib/canvas/publish-page', () => ({
  publishHomePageAtRoot: (...args: unknown[]) => publishHomePageAtRoot(...args),
  PublishError: class PublishError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number = 500) {
      super(message);
      this.name = 'PublishError';
      this.statusCode = statusCode;
    }
  },
}));

const isPublishConfigured = vi.fn();
vi.mock('@/lib/canvas/published-storage', () => ({
  isPublishConfigured: (...args: unknown[]) => isPublishConfigured(...args),
}));

const auditRequest = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => auditRequest(...args),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

const makeReq = (): Request => ({} as unknown as Request);
const params = Promise.resolve({ driveId: 'drive-1' });

beforeEach(() => {
  vi.clearAllMocks();
  authenticateRequestWithOptions.mockResolvedValue({ userId: 'user-1' });
  checkMCPDriveScope.mockReturnValue(null);
  isPrincipalDriveOwnerOrAdmin.mockResolvedValue(true);
  isPublishConfigured.mockReturnValue(true);
  publishHomePageAtRoot.mockResolvedValue({
    url: 'https://acme.pagespace.site/',
    subdomain: 'acme',
    path: 'welcome',
    isHomePage: true,
  });
});

describe('POST /api/drives/[driveId]/publish-home', () => {
  it('returns the auth error when authentication fails', async () => {
    authenticateRequestWithOptions.mockResolvedValue({ error: new Response(null, { status: 401 }) });
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(401);
    expect(publishHomePageAtRoot).not.toHaveBeenCalled();
  });

  it('returns the scope error when the MCP token is out of scope', async () => {
    checkMCPDriveScope.mockReturnValue(new Response(null, { status: 403 }));
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(403);
    expect(publishHomePageAtRoot).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not a drive owner or admin', async () => {
    isPrincipalDriveOwnerOrAdmin.mockResolvedValue(false);
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(403);
    expect(publishHomePageAtRoot).not.toHaveBeenCalled();
  });

  it('returns 503 when publishing is not configured', async () => {
    isPublishConfigured.mockReturnValue(false);
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(503);
    expect(publishHomePageAtRoot).not.toHaveBeenCalled();
  });

  it('returns 503 when the global publishing kill-switch is engaged', async () => {
    const prev = process.env.CANVAS_PUBLISHING_DISABLED;
    process.env.CANVAS_PUBLISHING_DISABLED = 'true';
    try {
      const res = await POST(makeReq(), { params });
      expect(res.status).toBe(503);
      expect(publishHomePageAtRoot).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.CANVAS_PUBLISHING_DISABLED;
      else process.env.CANVAS_PUBLISHING_DISABLED = prev;
    }
  });

  it('preserves the PublishError HTTP status code (e.g. 409) instead of collapsing to 500', async () => {
    const { PublishError } = await import('@/lib/canvas/publish-page');
    publishHomePageAtRoot.mockRejectedValue(new PublishError('Subdomain taken, choose another', 409));
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(409);
    expect(auditRequest).not.toHaveBeenCalled();
  });

  it('returns 400 when there is no publishable canvas home page (null result)', async () => {
    publishHomePageAtRoot.mockResolvedValue(null);
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(400);
    expect(auditRequest).not.toHaveBeenCalled();
  });

  it('returns 200, the publish result, and audits on success', async () => {
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(publishHomePageAtRoot).toHaveBeenCalledWith('drive-1', 'user-1');
    const json = await res.json();
    expect(json).toEqual({ url: 'https://acme.pagespace.site/', subdomain: 'acme', path: 'welcome', isHomePage: true });
    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'data.write',
        userId: 'user-1',
        resourceType: 'drive',
        resourceId: 'drive-1',
        details: { operation: 'publish-home' },
      }),
    );
  });

  it('returns 500 when publishing throws unexpectedly', async () => {
    publishHomePageAtRoot.mockRejectedValue(new Error('S3 unavailable'));
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(500);
    expect(auditRequest).not.toHaveBeenCalled();
  });
});

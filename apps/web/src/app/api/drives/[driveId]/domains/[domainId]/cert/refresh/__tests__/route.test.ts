/**
 * Contract tests for POST /api/drives/[driveId]/domains/[domainId]/cert/refresh
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

const auditRequest = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => auditRequest(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

const addCertificate = vi.fn();
vi.mock('@/lib/fly/certs', () => ({
  addCertificate: (...args: unknown[]) => addCertificate(...args),
}));

const dbSelect = vi.fn();
const dbUpdate = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: (...args: unknown[]) => dbSelect(...args),
    update: (...args: unknown[]) => dbUpdate(...args),
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

const mirrorDriveToCustomHost = vi.fn().mockResolvedValue(undefined);
const clearCustomHost = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/canvas/custom-domain-mirror', () => ({
  mirrorDriveToCustomHost: (...args: unknown[]) => mirrorDriveToCustomHost(...args),
  clearCustomHost: (...args: unknown[]) => clearCustomHost(...args),
}));

const regeneratePublishedSiteFiles = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/canvas/publish-page', () => ({
  regeneratePublishedSiteFiles: (...args: unknown[]) => regeneratePublishedSiteFiles(...args),
}));

const DRIVE_ID = 'drive-1';
const DOMAIN_ID = 'dom-1';
const USER_ID = 'user-1';
const mockAuth = { userId: USER_ID };
const makeReq = (): Request => ({} as unknown as Request);
const ctx = (driveId = DRIVE_ID, domainId = DOMAIN_ID) => ({
  params: Promise.resolve({ driveId, domainId }),
});

function setupSelectReturning(rows: unknown[]) {
  dbSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  });
}

function setupUpdate() {
  dbUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  });
}

const VERIFIED_DOMAIN = {
  id: DOMAIN_ID,
  driveId: DRIVE_ID,
  hostname: 'docs.acme.com',
  status: 'verified',
  createdAt: new Date(),
};

const PROVISIONING_DOMAIN = { ...VERIFIED_DOMAIN, status: 'provisioning' };
const ACTIVE_DOMAIN = { ...VERIFIED_DOMAIN, status: 'active' };
const PENDING_DOMAIN = { ...VERIFIED_DOMAIN, status: 'pending' };
const DNS_FAILED_DOMAIN = { ...VERIFIED_DOMAIN, status: 'dns_failed' };
const CERT_FAILED_DOMAIN = { ...VERIFIED_DOMAIN, status: 'cert_failed' };
const LEGACY_FAILED_DOMAIN = { ...VERIFIED_DOMAIN, status: 'failed' };

beforeEach(() => {
  vi.clearAllMocks();
  authenticateRequestWithOptions.mockResolvedValue(mockAuth);
  checkMCPDriveScope.mockReturnValue(null);
  isPrincipalDriveOwnerOrAdmin.mockResolvedValue(true);
  setupUpdate();
  process.env.FLY_API_TOKEN = 'test-token';
  process.env.FLY_PROXY_APP_NAME = 'pagespace-proxy';
});

describe('POST /api/drives/[driveId]/domains/[domainId]/cert/refresh', () => {
  it('returns 401 when not authenticated', async () => {
    authenticateRequestWithOptions.mockResolvedValue({ error: new Response(null, { status: 401 }) });
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(401);
  });

  it('returns scope error when MCP token is out of scope', async () => {
    checkMCPDriveScope.mockReturnValue(new Response(null, { status: 403 }));
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(403);
  });

  it('returns 403 when caller is not owner/admin', async () => {
    isPrincipalDriveOwnerOrAdmin.mockResolvedValue(false);
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(403);
  });

  it('returns 404 when domain not found', async () => {
    setupSelectReturning([]);
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(404);
  });

  it('returns 409 when domain status is pending (not DNS-verified)', async () => {
    setupSelectReturning([PENDING_DOMAIN]);
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/DNS/i);
  });

  it('returns 409 when domain status is dns_failed (DNS not verified)', async () => {
    setupSelectReturning([DNS_FAILED_DOMAIN]);
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(409);
  });

  it('returns 409 when domain status is failed (legacy DNS failure)', async () => {
    setupSelectReturning([LEGACY_FAILED_DOMAIN]);
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(409);
  });

  it('returns 503 when FLY_API_TOKEN is not configured', async () => {
    delete process.env.FLY_API_TOKEN;
    setupSelectReturning([VERIFIED_DOMAIN]);
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(503);
    expect(addCertificate).not.toHaveBeenCalled();
  });

  describe('verified domain → provision', () => {
    it('calls addCertificate with the domain hostname', async () => {
      setupSelectReturning([VERIFIED_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: true, configured: false });

      await POST(makeReq(), ctx());

      expect(addCertificate).toHaveBeenCalledWith(
        expect.any(String),
        'docs.acme.com',
      );
    });

    it('sets status to provisioning when cert is not yet configured', async () => {
      setupSelectReturning([VERIFIED_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: true, configured: false });
      const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
      dbUpdate.mockReturnValue({ set: setMock });

      const res = await POST(makeReq(), ctx());
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('provisioning');
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'provisioning' }));
    });

    it('sets status to active when cert is already configured', async () => {
      setupSelectReturning([VERIFIED_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: true, configured: true });

      const res = await POST(makeReq(), ctx());
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('active');
    });

    it('sets status to cert_failed when Fly returns an error', async () => {
      setupSelectReturning([VERIFIED_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: false, error: 'Fly API timeout' });
      const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
      dbUpdate.mockReturnValue({ set: setMock });

      const res = await POST(makeReq(), ctx());
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('cert_failed');
    });
  });

  describe('provisioning domain → poll', () => {
    it('sets status to active when cert is now configured', async () => {
      setupSelectReturning([PROVISIONING_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: true, configured: true });

      const res = await POST(makeReq(), ctx());
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('active');
    });

    it('keeps status as provisioning when cert is still pending', async () => {
      setupSelectReturning([PROVISIONING_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: true, configured: false });

      const res = await POST(makeReq(), ctx());
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('provisioning');
    });
  });

  describe('cert_failed domain → retry provision', () => {
    it('allows retry from cert_failed status (eligible for cert provisioning)', async () => {
      setupSelectReturning([CERT_FAILED_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: true, configured: false });

      const res = await POST(makeReq(), ctx());
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('provisioning');
    });

    it('sets status to active when cert is now configured on retry', async () => {
      setupSelectReturning([CERT_FAILED_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: true, configured: true });

      const res = await POST(makeReq(), ctx());
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('active');
    });
  });

  describe('active domain → re-check', () => {
    it('keeps status as active when cert is still configured', async () => {
      setupSelectReturning([ACTIVE_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: true, configured: true });

      const res = await POST(makeReq(), ctx());
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('active');
    });
  });

  it('emits an audit event on successful cert refresh', async () => {
    setupSelectReturning([VERIFIED_DOMAIN]);
    addCertificate.mockResolvedValue({ ok: true, configured: false });

    await POST(makeReq(), ctx());

    expect(auditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'data.write',
        details: expect.objectContaining({ operation: 'cert-refresh' }),
      }),
    );
  });

  it('only provisions domains owned by the calling drive (driveId guard)', async () => {
    setupSelectReturning([]);
    const res = await POST(makeReq(), ctx('other-drive'));
    expect(res.status).toBe(404);
    expect(addCertificate).not.toHaveBeenCalled();
  });

  it('returns 500 on unexpected DB error', async () => {
    dbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('db down')),
      }),
    });
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(500);
  });

  describe('backfill on domain activation', () => {
    it('triggers mirrorDriveToCustomHost when domain transitions to active', async () => {
      setupSelectReturning([VERIFIED_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: true, configured: true });

      await POST(makeReq(), ctx());

      expect(mirrorDriveToCustomHost).toHaveBeenCalledWith(DRIVE_ID, 'docs.acme.com');
    });

    it('regenerates site files before mirroring when domain becomes active', async () => {
      setupSelectReturning([VERIFIED_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: true, configured: true });

      await POST(makeReq(), ctx());

      expect(regeneratePublishedSiteFiles).toHaveBeenCalledWith(DRIVE_ID);
    });

    it('triggers mirrorDriveToCustomHost when provisioning domain becomes active', async () => {
      setupSelectReturning([PROVISIONING_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: true, configured: true });

      await POST(makeReq(), ctx());

      expect(mirrorDriveToCustomHost).toHaveBeenCalledWith(DRIVE_ID, 'docs.acme.com');
    });

    it('does NOT trigger mirrorDriveToCustomHost when already-active domain is re-checked', async () => {
      setupSelectReturning([ACTIVE_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: true, configured: true });

      await POST(makeReq(), ctx());

      expect(mirrorDriveToCustomHost).not.toHaveBeenCalled();
    });

    it('does NOT trigger mirrorDriveToCustomHost when domain stays in provisioning', async () => {
      setupSelectReturning([VERIFIED_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: true, configured: false });

      await POST(makeReq(), ctx());

      expect(mirrorDriveToCustomHost).not.toHaveBeenCalled();
    });
  });

  describe('mirror cleanup on deactivation (active → cert_failed)', () => {
    it('calls clearCustomHost when an active domain transitions to cert_failed', async () => {
      setupSelectReturning([ACTIVE_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: false, error: 'Fly cert revoked' });

      await POST(makeReq(), ctx());

      expect(clearCustomHost).toHaveBeenCalledWith('docs.acme.com');
    });

    it('does NOT call clearCustomHost when a non-active domain transitions to cert_failed', async () => {
      setupSelectReturning([VERIFIED_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: false, error: 'Fly error' });

      await POST(makeReq(), ctx());

      expect(clearCustomHost).not.toHaveBeenCalled();
    });

    it('does NOT call clearCustomHost when an active domain stays active (re-check succeeds)', async () => {
      setupSelectReturning([ACTIVE_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: true, configured: true });

      await POST(makeReq(), ctx());

      expect(clearCustomHost).not.toHaveBeenCalled();
    });

    it('returns 200 (not 500) when clearCustomHost throws — status already committed to DB', async () => {
      setupSelectReturning([ACTIVE_DOMAIN]);
      addCertificate.mockResolvedValue({ ok: false, error: 'Fly cert revoked' });
      clearCustomHost.mockRejectedValueOnce(new Error('S3 down'));

      const res = await POST(makeReq(), ctx());

      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('cert_failed');
    });
  });
});

/**
 * Contract tests for DELETE and PATCH /api/drives/[driveId]/domains/[domainId]
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DELETE, PATCH } from '../route';

vi.mock('server-only', () => ({}));

const authenticateRequestWithOptions = vi.fn();
const checkMCPDriveScope = vi.fn();
const isPrincipalDriveOwnerOrAdmin = vi.fn();
vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => authenticateRequestWithOptions(...args),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: (result: unknown) => typeof result === 'object' && result !== null && 'error' in result,
  checkMCPDriveScope: (...args: unknown[]) => checkMCPDriveScope(...args),
}));
vi.mock('@/lib/auth/principal-permissions', () => ({
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
const dbUpdate = vi.fn();
const findFirst = vi.fn();
const dbTransaction = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    delete: (...args: unknown[]) => dbDelete(...args),
    update: (...args: unknown[]) => dbUpdate(...args),
    query: { customDomains: { findFirst: (...args: unknown[]) => findFirst(...args) } },
    transaction: (...args: unknown[]) => dbTransaction(...args),
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
    isPrimary: 'col_isPrimary',
    createdAt: 'col_createdAt',
    publishLandingPageId: 'col_publishLandingPageId',
    publishNotFoundPageId: 'col_publishNotFoundPageId',
  },
}));

const clearCustomHost = vi.fn().mockResolvedValue(undefined);
const mirrorDriveToCustomHost = vi.fn().mockResolvedValue(undefined);
const regeneratePublishedSiteFiles = vi.fn().mockResolvedValue(undefined);
const republishDriveCanonical = vi.fn().mockResolvedValue(0);
const renderDomainNotFoundOverride = vi.fn().mockResolvedValue(undefined);
const isValidDriveNotFoundPage = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/canvas/custom-domain-mirror', () => ({
  clearCustomHost: (...args: unknown[]) => clearCustomHost(...args),
  mirrorDriveToCustomHost: (...args: unknown[]) => mirrorDriveToCustomHost(...args),
}));
vi.mock('@/lib/canvas/publish-page', () => ({
  regeneratePublishedSiteFiles: (...args: unknown[]) => regeneratePublishedSiteFiles(...args),
  republishDriveCanonical: (...args: unknown[]) => republishDriveCanonical(...args),
  renderDomainNotFoundOverride: (...args: unknown[]) => renderDomainNotFoundOverride(...args),
}));
vi.mock('@pagespace/lib/services/drive-service', () => ({
  isValidDriveNotFoundPage: (...args: unknown[]) => isValidDriveNotFoundPage(...args),
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
  isValidDriveNotFoundPage.mockResolvedValue(true);
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

  it('triggers clearCustomHost (fire-and-forget) when deleted domain is active', async () => {
    const deleted = { id: DOMAIN_ID, driveId: DRIVE_ID, hostname: 'acme.com', status: 'active', createdAt: new Date() };
    dbDelete.mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([deleted]) }) });

    const res = await DELETE(makeReq(), ctx());
    // Wait for microtasks so the fire-and-forget .catch() can run
    await Promise.resolve();

    expect(res.status).toBe(200);
    expect(clearCustomHost).toHaveBeenCalledWith('acme.com');
  });

  it('triggers clearCustomHost when deleted domain is verified (serving, mirrored at verify time)', async () => {
    const deleted = { id: DOMAIN_ID, driveId: DRIVE_ID, hostname: 'verified.com', status: 'verified', createdAt: new Date() };
    dbDelete.mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([deleted]) }) });

    const res = await DELETE(makeReq(), ctx());
    await Promise.resolve();

    expect(res.status).toBe(200);
    expect(clearCustomHost).toHaveBeenCalledWith('verified.com');
  });

  it('triggers clearCustomHost when deleted domain is provisioning (serving)', async () => {
    const deleted = { id: DOMAIN_ID, driveId: DRIVE_ID, hostname: 'prov.com', status: 'provisioning', createdAt: new Date() };
    dbDelete.mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([deleted]) }) });

    await DELETE(makeReq(), ctx());
    await Promise.resolve();

    expect(clearCustomHost).toHaveBeenCalledWith('prov.com');
  });

  it('does NOT trigger clearCustomHost for a non-serving domain (pending/dns_failed)', async () => {
    for (const status of ['pending', 'dns_failed', 'cert_failed']) {
      clearCustomHost.mockClear();
      const deleted = { id: DOMAIN_ID, driveId: DRIVE_ID, hostname: `${status}.com`, status, createdAt: new Date() };
      dbDelete.mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([deleted]) }) });

      await DELETE(makeReq(), ctx());
      await Promise.resolve();

      expect(clearCustomHost).not.toHaveBeenCalled();
    }
  });
});

describe('PATCH /api/drives/[driveId]/domains/[domainId] (set primary)', () => {
  const makePatchReq = (body: unknown = { isPrimary: true }): Request =>
    ({ json: () => Promise.resolve(body) } as unknown as Request);

  // A tx where `.update().set().where()` is awaitable AND exposes `.returning()`
  // so both the clear-others update and the set-primary update work off one mock.
  const wireTransaction = (updated: unknown) => {
    const whereResult = Object.assign(Promise.resolve([updated]), {
      returning: () => Promise.resolve([updated]),
    });
    const tx = { update: vi.fn(() => ({ set: () => ({ where: () => whereResult }) })) };
    dbTransaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(tx));
    return tx;
  };

  it('returns 401 when not authenticated', async () => {
    authenticateRequestWithOptions.mockResolvedValue({ error: new Response(null, { status: 401 }) });
    const res = await PATCH(makePatchReq(), ctx());
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not owner/admin', async () => {
    isPrincipalDriveOwnerOrAdmin.mockResolvedValue(false);
    const res = await PATCH(makePatchReq(), ctx());
    expect(res.status).toBe(403);
  });

  it('returns 400 on an invalid body (isPrimary !== true)', async () => {
    const res = await PATCH(makePatchReq({ isPrimary: false }), ctx());
    expect(res.status).toBe(400);
  });

  it('returns 404 when the domain is not in the drive', async () => {
    findFirst.mockResolvedValue(undefined);
    const res = await PATCH(makePatchReq(), ctx());
    expect(res.status).toBe(404);
  });

  it('returns 400 when the target domain is not active', async () => {
    findFirst.mockResolvedValue({ id: DOMAIN_ID, hostname: 'acme.com', status: 'pending' });
    const res = await PATCH(makePatchReq(), ctx());
    expect(res.status).toBe(400);
    expect(dbTransaction).not.toHaveBeenCalled();
  });

  it('sets the active domain primary and returns the updated row', async () => {
    findFirst.mockResolvedValue({ id: DOMAIN_ID, hostname: 'acme.com', status: 'active' });
    const updated = { id: DOMAIN_ID, driveId: DRIVE_ID, hostname: 'acme.com', status: 'active', isPrimary: true };
    wireTransaction(updated);

    const res = await PATCH(makePatchReq(), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.domain.isPrimary).toBe(true);
  });

  it('re-renders published pages and audits on success', async () => {
    findFirst.mockResolvedValue({ id: DOMAIN_ID, hostname: 'acme.com', status: 'active' });
    wireTransaction({ id: DOMAIN_ID, driveId: DRIVE_ID, hostname: 'acme.com', status: 'active', isPrimary: true });
    // Two pages were re-rendered (each refreshes site files internally), so the
    // route must NOT redundantly regenerate them again.
    republishDriveCanonical.mockResolvedValueOnce(2);

    await PATCH(makePatchReq(), ctx());
    await Promise.resolve();

    expect(republishDriveCanonical).toHaveBeenCalledWith(DRIVE_ID, USER_ID);
    expect(regeneratePublishedSiteFiles).not.toHaveBeenCalled();
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'data.write',
      details: expect.objectContaining({ operation: 'set-primary-custom-domain', hostname: 'acme.com' }),
    }));
  });

  it('still refreshes site files when the drive has no published pages to re-render', async () => {
    findFirst.mockResolvedValue({ id: DOMAIN_ID, hostname: 'acme.com', status: 'active' });
    wireTransaction({ id: DOMAIN_ID, driveId: DRIVE_ID, hostname: 'acme.com', status: 'active', isPrimary: true });
    republishDriveCanonical.mockResolvedValueOnce(0);

    await PATCH(makePatchReq(), ctx());
    await Promise.resolve();

    expect(regeneratePublishedSiteFiles).toHaveBeenCalledWith(DRIVE_ID);
  });

  it('returns 500 on unexpected db error', async () => {
    findFirst.mockRejectedValue(new Error('db down'));
    const res = await PATCH(makePatchReq(), ctx());
    expect(res.status).toBe(500);
  });

  it('rejects a mixed payload without partially applying the primary-domain change', async () => {
    // isPrimary is valid on its own (domain is active), but the accompanying
    // publishLandingPageId is not — the whole request must be rejected before
    // either mutation runs, not just the invalid half.
    findFirst.mockResolvedValue({ id: DOMAIN_ID, hostname: 'acme.com', status: 'active' });
    isValidDriveNotFoundPage.mockResolvedValue(false);

    const res = await PATCH(makePatchReq({ isPrimary: true, publishLandingPageId: 'invalid-page-id' }), ctx());

    expect(res.status).toBe(400);
    expect(dbTransaction).not.toHaveBeenCalled();
    expect(dbUpdate).not.toHaveBeenCalled();
    expect(auditRequest).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/drives/[driveId]/domains/[domainId] (landing/404 page overrides)', () => {
  const makePatchReq = (body: unknown): Request =>
    ({ json: () => Promise.resolve(body) } as unknown as Request);

  const wireUpdate = (updated: unknown) => {
    dbUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([updated]) }),
      }),
    });
  };

  it('returns 400 on an invalid body (all fields omitted)', async () => {
    const res = await PATCH(makePatchReq({}), ctx());
    expect(res.status).toBe(400);
  });

  it('returns 404 when the domain is not in the drive', async () => {
    findFirst.mockResolvedValue(undefined);
    const res = await PATCH(makePatchReq({ publishLandingPageId: 'page-1' }), ctx());
    expect(res.status).toBe(404);
  });

  it('returns 400 when publishLandingPageId is not a valid Canvas page in this drive', async () => {
    findFirst.mockResolvedValue({ id: DOMAIN_ID, hostname: 'acme.com', status: 'pending' });
    isValidDriveNotFoundPage.mockResolvedValue(false);

    const res = await PATCH(makePatchReq({ publishLandingPageId: 'page-1' }), ctx());
    expect(res.status).toBe(400);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when publishNotFoundPageId is not a valid Canvas page in this drive', async () => {
    findFirst.mockResolvedValue({ id: DOMAIN_ID, hostname: 'acme.com', status: 'pending' });
    isValidDriveNotFoundPage.mockResolvedValue(false);

    const res = await PATCH(makePatchReq({ publishNotFoundPageId: 'page-404' }), ctx());
    expect(res.status).toBe(400);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it('does not require the domain to be active (unlike isPrimary)', async () => {
    findFirst.mockResolvedValue({ id: DOMAIN_ID, hostname: 'acme.com', status: 'pending' });
    wireUpdate({ id: DOMAIN_ID, driveId: DRIVE_ID, hostname: 'acme.com', publishLandingPageId: 'page-1' });

    const res = await PATCH(makePatchReq({ publishLandingPageId: 'page-1' }), ctx());
    expect(res.status).toBe(200);
  });

  it('sets publishLandingPageId and re-mirrors the host', async () => {
    findFirst.mockResolvedValue({ id: DOMAIN_ID, hostname: 'acme.com', status: 'active' });
    wireUpdate({ id: DOMAIN_ID, driveId: DRIVE_ID, hostname: 'acme.com', publishLandingPageId: 'page-1' });

    const res = await PATCH(makePatchReq({ publishLandingPageId: 'page-1' }), ctx());
    await Promise.resolve();

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.domain.publishLandingPageId).toBe('page-1');
    expect(mirrorDriveToCustomHost).toHaveBeenCalledWith(DRIVE_ID, 'acme.com', expect.any(Function));
  });

  it('clears publishLandingPageId when null is sent explicitly', async () => {
    findFirst.mockResolvedValue({ id: DOMAIN_ID, hostname: 'acme.com', status: 'active' });
    wireUpdate({ id: DOMAIN_ID, driveId: DRIVE_ID, hostname: 'acme.com', publishLandingPageId: null });

    const res = await PATCH(makePatchReq({ publishLandingPageId: null }), ctx());
    expect(res.status).toBe(200);
    expect(isValidDriveNotFoundPage).not.toHaveBeenCalled();
  });

  it('sets publishNotFoundPageId independently of publishLandingPageId', async () => {
    findFirst.mockResolvedValue({ id: DOMAIN_ID, hostname: 'acme.com', status: 'active' });
    wireUpdate({ id: DOMAIN_ID, driveId: DRIVE_ID, hostname: 'acme.com', publishNotFoundPageId: 'page-404' });

    const res = await PATCH(makePatchReq({ publishNotFoundPageId: 'page-404' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.domain.publishNotFoundPageId).toBe('page-404');
  });

  it('audits the override change with both field values', async () => {
    findFirst.mockResolvedValue({ id: DOMAIN_ID, hostname: 'acme.com', status: 'active' });
    wireUpdate({ id: DOMAIN_ID, driveId: DRIVE_ID, hostname: 'acme.com' });

    await PATCH(makePatchReq({ publishLandingPageId: 'page-1', publishNotFoundPageId: null }), ctx());

    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'data.write',
      details: expect.objectContaining({
        operation: 'set-custom-domain-page-overrides',
        hostname: 'acme.com',
        publishLandingPageId: 'page-1',
        publishNotFoundPageId: null,
      }),
    }));
  });

  it('returns 500 on unexpected db error', async () => {
    findFirst.mockResolvedValue({ id: DOMAIN_ID, hostname: 'acme.com', status: 'active' });
    dbUpdate.mockImplementation(() => {
      throw new Error('db down');
    });

    const res = await PATCH(makePatchReq({ publishLandingPageId: 'page-1' }), ctx());
    expect(res.status).toBe(500);
  });
});

/**
 * Contract tests for GET + POST /api/drives/[driveId]/domains
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, POST } from '../route';

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

const dbSelect = vi.fn();
const dbInsert = vi.fn();
const dbTransaction = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: (...args: unknown[]) => dbSelect(...args),
    insert: (...args: unknown[]) => dbInsert(...args),
    transaction: (...args: unknown[]) => dbTransaction(...args),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  count: vi.fn(() => ({ _count: true })),
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
vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'col_drives_id', ownerId: 'col_drives_ownerId' },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'col_users_id', subscriptionTier: 'col_subscriptionTier', role: 'col_role' },
}));

const mirrorDriveToCustomHost = vi.fn();
vi.mock('@/lib/canvas/custom-domain-mirror', () => ({
  mirrorDriveToCustomHost: (...args: unknown[]) => mirrorDriveToCustomHost(...args),
}));

vi.mock('@/lib/subscription/plans', () => ({
  getPlan: vi.fn((tier: string) => ({
    limits: {
      maxCustomDomains: tier === 'free' ? 0 : tier === 'pro' ? 1 : tier === 'founder' ? 3 : 10,
    },
  })),
}));

const reconcileCustomDomainCert = vi.fn();
vi.mock('@/lib/canvas/reconcile-cert', () => ({
  reconcileCustomDomainCert: (...args: unknown[]) => reconcileCustomDomainCert(...args),
}));

const DRIVE_ID = 'drive-1';
const USER_ID = 'user-1';
const mockAuth = { userId: USER_ID, role: 'user' };
const mockPlatformAdminAuth = { userId: USER_ID, role: 'admin' };
const makeReq = (body?: unknown): Request =>
  ({
    json: () => Promise.resolve(body ?? {}),
  } as unknown as Request);
const ctx = (driveId = DRIVE_ID) => ({ params: Promise.resolve({ driveId }) });

/**
 * Mock for POST (non-platform-domain path): three sequential dbSelect calls.
 *  1. Tier lookup (outside transaction): drives JOIN users -> [{tier}]
 *  2. Drive row lock (inside transaction): SELECT drives.id FOR UPDATE
 *  3. Count query (inside transaction): SELECT count() FROM customDomains
 */
function mockPostSelects({ ownerTier = 'pro', domainCount = 0 } = {}) {
  let callIndex = 0;
  dbSelect.mockImplementation(() => {
    callIndex++;
    if (callIndex === 1) {
      // Tier lookup
      return {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{ tier: ownerTier }]),
      };
    }
    if (callIndex === 2) {
      // Drive row lock: tx.select({id}).from(drives).where().for('update')
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        for: vi.fn().mockResolvedValue([{ id: DRIVE_ID }]),
      };
    }
    // Count query: tx.select({n}).from(customDomains).where()
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ n: domainCount }]),
    };
  });
}

function mockPlatformAdmin() {
  authenticateRequestWithOptions.mockResolvedValue(mockPlatformAdminAuth);
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateRequestWithOptions.mockResolvedValue(mockAuth);
  checkMCPDriveScope.mockReturnValue(null);
  isPrincipalDriveOwnerOrAdmin.mockResolvedValue(true);
  // Default tier lookup.
  dbSelect.mockImplementation(() => ({
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ tier: 'pro' }]),
  }));
  mirrorDriveToCustomHost.mockResolvedValue(undefined);
  // Default reconcile: no-op echoing the input status (overridden per-test).
  reconcileCustomDomainCert.mockImplementation(async (d: { status: string }) => ({ status: d.status, action: null }));
  // Default transaction: pass a tx stub that delegates to the same dbSelect/dbInsert mocks.
  dbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      select: (...args: unknown[]) => dbSelect(...args),
      insert: (...args: unknown[]) => dbInsert(...args),
    }),
  );
});

// ── GET ──────────────────────────────────────────────────────────────────────

describe('GET /api/drives/[driveId]/domains', () => {
  it('returns 401 when not authenticated', async () => {
    authenticateRequestWithOptions.mockResolvedValue({ error: new Response(null, { status: 401 }) });
    const res = await GET(makeReq(), ctx());
    expect(res.status).toBe(401);
  });

  it('returns scope error when MCP token is out of scope', async () => {
    checkMCPDriveScope.mockReturnValue(new Response(null, { status: 403 }));
    const res = await GET(makeReq(), ctx());
    expect(res.status).toBe(403);
  });

  it('returns 403 when caller is not owner/admin', async () => {
    isPrincipalDriveOwnerOrAdmin.mockResolvedValue(false);
    const res = await GET(makeReq(), ctx());
    expect(res.status).toBe(403);
  });

  it('returns domains list and limit on success', async () => {
    const fakeDomains = [{ id: 'd1', driveId: DRIVE_ID, hostname: 'acme.com', status: 'pending', createdAt: new Date() }];
    // Promise.all([domains_select, getMaxCustomDomainsForDrive()]) evaluates synchronously:
    // call 1 = domain list (first item in the array); call 2 = tier lookup (inside helper)
    let callIndex = 0;
    dbSelect.mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // domain list
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(fakeDomains) };
      }
      // owner tier lookup
      return { from: vi.fn().mockReturnThis(), innerJoin: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ tier: 'pro' }]) };
    });

    const res = await GET(makeReq(), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].hostname).toBe('acme.com');
    expect(body.limit).toBe(1); // pro tier = 1
  });

  it('returns 500 on unexpected db error', async () => {
    dbSelect.mockImplementation(() => ({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockRejectedValue(new Error('db down')),
      limit: vi.fn().mockRejectedValue(new Error('db down')),
    }));
    const res = await GET(makeReq(), ctx());
    expect(res.status).toBe(500);
  });

  // ── lazy cert reconcile ──────────────────────────────────────────────────
  /** Stub a GET where the domain list is `domains` and tier lookup is `pro`. */
  function mockGetSelects(domains: unknown[]) {
    let callIndex = 0;
    dbSelect.mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(domains) };
      }
      return { from: vi.fn().mockReturnThis(), innerJoin: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ tier: 'pro' }]) };
    });
  }

  it('reconciles verified and provisioning rows and returns the advanced status', async () => {
    mockGetSelects([
      { id: 'd1', driveId: DRIVE_ID, hostname: 'verified.com', status: 'verified', createdAt: new Date() },
      { id: 'd2', driveId: DRIVE_ID, hostname: 'prov.com', status: 'provisioning', createdAt: new Date() },
    ]);
    reconcileCustomDomainCert.mockImplementation(async (d: { hostname: string }) => ({
      status: d.hostname === 'verified.com' ? 'provisioning' : 'active',
      action: 'mark-active',
    }));

    const res = await GET(makeReq(), ctx());
    const body = await res.json();

    expect(reconcileCustomDomainCert).toHaveBeenCalledTimes(2);
    expect(body.domains.find((d: { hostname: string }) => d.hostname === 'verified.com').status).toBe('provisioning');
    expect(body.domains.find((d: { hostname: string }) => d.hostname === 'prov.com').status).toBe('active');
  });

  it('reconciles non-destructively on reads (allowFailureTransition: false)', async () => {
    mockGetSelects([
      { id: 'd1', driveId: DRIVE_ID, hostname: 'verified.com', status: 'verified', createdAt: new Date() },
    ]);

    await GET(makeReq(), ctx());

    expect(reconcileCustomDomainCert).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'verified.com' }),
      { allowFailureTransition: false },
    );
  });

  it('does NOT reconcile terminal rows (pending/active/dns_failed/cert_failed)', async () => {
    mockGetSelects([
      { id: 'd1', driveId: DRIVE_ID, hostname: 'pending.com', status: 'pending', createdAt: new Date() },
      { id: 'd2', driveId: DRIVE_ID, hostname: 'active.com', status: 'active', createdAt: new Date() },
      { id: 'd3', driveId: DRIVE_ID, hostname: 'dnsfail.com', status: 'dns_failed', createdAt: new Date() },
      { id: 'd4', driveId: DRIVE_ID, hostname: 'certfail.com', status: 'cert_failed', createdAt: new Date() },
    ]);

    const res = await GET(makeReq(), ctx());
    const body = await res.json();

    expect(reconcileCustomDomainCert).not.toHaveBeenCalled();
    expect(body.domains).toHaveLength(4);
  });

  it('never 500s when reconcile throws (Fly outage) — returns the un-advanced row', async () => {
    mockGetSelects([
      { id: 'd1', driveId: DRIVE_ID, hostname: 'verified.com', status: 'verified', createdAt: new Date() },
    ]);
    reconcileCustomDomainCert.mockRejectedValueOnce(new Error('Fly is down'));

    const res = await GET(makeReq(), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.domains[0].status).toBe('verified');
  });
});

// ── POST ─────────────────────────────────────────────────────────────────────

describe('POST /api/drives/[driveId]/domains', () => {
  it('returns 401 when not authenticated', async () => {
    authenticateRequestWithOptions.mockResolvedValue({ error: new Response(null, { status: 401 }) });
    const res = await POST(makeReq({ hostname: 'acme.com' }), ctx());
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not owner/admin', async () => {
    isPrincipalDriveOwnerOrAdmin.mockResolvedValue(false);
    const res = await POST(makeReq({ hostname: 'acme.com' }), ctx());
    expect(res.status).toBe(403);
  });

  it('returns 400 for a missing hostname body', async () => {
    const res = await POST(makeReq({}), ctx());
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid hostname', async () => {
    const res = await POST(makeReq({ hostname: 'not a domain!!!' }), ctx());
    expect(res.status).toBe(400);
  });

  it('returns 400 for a pagespace.site hostname', async () => {
    const res = await POST(makeReq({ hostname: 'acme.pagespace.site' }), ctx());
    expect(res.status).toBe(400);
  });

  it('returns 403 when the free tier tries to add a domain', async () => {
    mockPostSelects({ ownerTier: 'free', domainCount: 0 });

    const res = await POST(makeReq({ hostname: 'acme.com' }), ctx());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not available on your current plan/i);
  });

  it('returns 403 when the drive is at the pro tier cap (1 domain)', async () => {
    mockPostSelects({ ownerTier: 'pro', domainCount: 1 });

    const res = await POST(makeReq({ hostname: 'newdomain.com' }), ctx());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/maximum of 1 custom domain/i);
  });

  it('returns 403 when the drive is at the founder tier cap (3 domains)', async () => {
    mockPostSelects({ ownerTier: 'founder', domainCount: 3 });

    const res = await POST(makeReq({ hostname: 'fourth.com' }), ctx());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/maximum of 3 custom domains/i);
  });

  it('normalizes the hostname before insert (strips scheme/path)', async () => {
    mockPostSelects({ ownerTier: 'pro', domainCount: 0 });
    const inserted = { id: 'dom-1', driveId: DRIVE_ID, hostname: 'acme.com', status: 'pending', createdAt: new Date() };
    const returningMock = vi.fn().mockResolvedValue([inserted]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    dbInsert.mockReturnValue({ values: valuesMock });

    await POST(makeReq({ hostname: 'https://ACME.COM/path' }), ctx());
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'acme.com' }));
  });

  it('returns 201 + domain on success (pro tier, 0 existing)', async () => {
    mockPostSelects({ ownerTier: 'pro', domainCount: 0 });
    const inserted = { id: 'dom-1', driveId: DRIVE_ID, hostname: 'acme.com', status: 'pending', createdAt: new Date() };
    const returningMock = vi.fn().mockResolvedValue([inserted]);
    dbInsert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: returningMock }) });

    const res = await POST(makeReq({ hostname: 'acme.com' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.domain.hostname).toBe('acme.com');
  });

  it('calls auditRequest on success', async () => {
    mockPostSelects({ ownerTier: 'business', domainCount: 0 });
    const inserted = { id: 'dom-1', driveId: DRIVE_ID, hostname: 'acme.com', status: 'pending', createdAt: new Date() };
    dbInsert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([inserted]) }) });

    await POST(makeReq({ hostname: 'acme.com' }), ctx());
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'data.write',
      details: expect.objectContaining({ operation: 'add-custom-domain' }),
    }));
  });

  it('returns 409 when hostname is already registered (cross-drive duplicate)', async () => {
    mockPostSelects({ ownerTier: 'pro', domainCount: 0 });
    const uniqueErr = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    dbInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(uniqueErr),
      }),
    });
    const res = await POST(makeReq({ hostname: 'acme.com' }), ctx());
    expect(res.status).toBe(409);
  });

  // ── platform-owned domain (admin bypass) ──────────────────────────────────

  it('still rejects pagespace.ai for a non-platform-admin caller', async () => {
    // role defaults to 'user' via beforeEach
    const res = await POST(makeReq({ hostname: 'pagespace.ai' }), ctx());
    expect(res.status).toBe(400);
  });

  it('allows a platform admin to register pagespace.ai for a drive they do not own, skipping the tier cap', async () => {
    mockPlatformAdmin();
    isPrincipalDriveOwnerOrAdmin.mockResolvedValue(false); // not a drive member — must not matter
    const inserted = { id: 'dom-1', driveId: DRIVE_ID, hostname: 'pagespace.ai', status: 'active', platformOwned: true, createdAt: new Date() };
    const valuesMock = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([inserted]) });
    dbInsert.mockReturnValue({ values: valuesMock });

    const res = await POST(makeReq({ hostname: 'pagespace.ai' }), ctx());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.domain.status).toBe('active');
    expect(body.domain.platformOwned).toBe(true);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'pagespace.ai', status: 'active', platformOwned: true }),
    );
    expect(mirrorDriveToCustomHost).toHaveBeenCalledWith(DRIVE_ID, 'pagespace.ai');
  });

  it('does not let a platform admin bypass the blocklist for an unrelated pagespace.* host', async () => {
    mockPlatformAdmin();
    const res = await POST(makeReq({ hostname: 'evil.pagespace.xyz' }), ctx());
    expect(res.status).toBe(400);
  });

  it('audits the platform-owned registration with platformOwned: true', async () => {
    mockPlatformAdmin();
    const inserted = { id: 'dom-1', driveId: DRIVE_ID, hostname: 'pagespace.ai', status: 'active', platformOwned: true, createdAt: new Date() };
    dbInsert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([inserted]) }) });

    await POST(makeReq({ hostname: 'pagespace.ai' }), ctx());

    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ hostname: 'pagespace.ai', platformOwned: true }),
    }));
  });

  it('a normal (non-platform-domain) POST audits with platformOwned: false', async () => {
    mockPostSelects({ ownerTier: 'pro', domainCount: 0 });
    const inserted = { id: 'dom-1', driveId: DRIVE_ID, hostname: 'acme.com', status: 'pending', createdAt: new Date() };
    dbInsert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([inserted]) }) });

    await POST(makeReq({ hostname: 'acme.com' }), ctx());

    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ platformOwned: false }),
    }));
  });

  it('returns 409 when pagespace.ai is already registered', async () => {
    mockPlatformAdmin();
    const uniqueErr = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    dbInsert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockRejectedValue(uniqueErr) }) });

    const res = await POST(makeReq({ hostname: 'pagespace.ai' }), ctx());
    expect(res.status).toBe(409);
  });
});

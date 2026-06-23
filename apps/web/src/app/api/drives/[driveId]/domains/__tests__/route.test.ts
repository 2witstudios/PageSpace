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
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: (...args: unknown[]) => dbSelect(...args),
    insert: (...args: unknown[]) => dbInsert(...args),
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
const USER_ID = 'user-1';
const mockAuth = { userId: USER_ID };
const makeReq = (body?: unknown): Request =>
  ({
    json: () => Promise.resolve(body ?? {}),
  } as unknown as Request);
const ctx = (driveId = DRIVE_ID) => ({ params: Promise.resolve({ driveId }) });

beforeEach(() => {
  vi.clearAllMocks();
  authenticateRequestWithOptions.mockResolvedValue(mockAuth);
  checkMCPDriveScope.mockReturnValue(null);
  isPrincipalDriveOwnerOrAdmin.mockResolvedValue(true);
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

  it('returns domains list on success', async () => {
    const fakeDomains = [{ id: 'd1', driveId: DRIVE_ID, hostname: 'acme.com', status: 'pending', createdAt: new Date() }];
    dbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(fakeDomains) }),
    });

    const res = await GET(makeReq(), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].hostname).toBe('acme.com');
  });

  it('returns 500 on unexpected db error', async () => {
    dbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(new Error('db down')) }),
    });
    const res = await GET(makeReq(), ctx());
    expect(res.status).toBe(500);
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

  it('normalizes the hostname before insert (strips scheme/path)', async () => {
    const inserted = { id: 'dom-1', driveId: DRIVE_ID, hostname: 'acme.com', status: 'pending', createdAt: new Date() };
    const returningMock = vi.fn().mockResolvedValue([inserted]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    dbInsert.mockReturnValue({ values: valuesMock });

    await POST(makeReq({ hostname: 'https://ACME.COM/path' }), ctx());
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'acme.com' }));
  });

  it('returns 201 + domain on success', async () => {
    const inserted = { id: 'dom-1', driveId: DRIVE_ID, hostname: 'acme.com', status: 'pending', createdAt: new Date() };
    const returningMock = vi.fn().mockResolvedValue([inserted]);
    dbInsert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: returningMock }) });

    const res = await POST(makeReq({ hostname: 'acme.com' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.domain.hostname).toBe('acme.com');
  });

  it('calls auditRequest on success', async () => {
    const inserted = { id: 'dom-1', driveId: DRIVE_ID, hostname: 'acme.com', status: 'pending', createdAt: new Date() };
    dbInsert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([inserted]) }) });

    await POST(makeReq({ hostname: 'acme.com' }), ctx());
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'data.write',
      details: expect.objectContaining({ operation: 'add-custom-domain' }),
    }));
  });

  it('returns 409 when hostname is already registered', async () => {
    dbInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('unique constraint violation')),
      }),
    });
    const res = await POST(makeReq({ hostname: 'acme.com' }), ctx());
    expect(res.status).toBe(409);
  });
});

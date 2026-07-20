import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAuthenticateRequestWithOptions = vi.fn();
const mockIsAuthError = vi.fn();
const mockCanManagePageWebhooks = vi.fn();
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequestWithOptions(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
  canManagePageWebhooks: (...args: unknown[]) => mockCanManagePageWebhooks(...args),
}));

const mockPageWebhooksFindMany = vi.fn();
const mockPagesFindFirst = vi.fn();
const mockInsertValues = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pageWebhooks: { findMany: (...args: unknown[]) => mockPageWebhooksFindMany(...args) },
      pages: { findFirst: (...args: unknown[]) => mockPagesFindFirst(...args) },
    },
    insert: () => ({
      values: (...args: unknown[]) => ({
        returning: () => mockInsertValues(...args),
      }),
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: (a: unknown, b: unknown) => ({ a, b }) }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'pages.id', isTrashed: 'pages.isTrashed' } }));
vi.mock('@pagespace/db/schema/page-webhooks', () => ({
  pageWebhooks: { pageId: 'pageWebhooks.pageId' },
}));

const mockEncryptField = vi.fn(async (v: string) => `encrypted(${v})`);
vi.mock('@pagespace/lib/encryption/field-crypto', () => ({
  encryptField: (...args: [string]) => mockEncryptField(...args),
}));

const mockAuditRequest = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import { GET, POST } from '../route';

const SESSION_AUTH = { userId: 'user-1', kind: 'session' };

function makeRequest(body?: unknown): Request {
  return new Request('https://example.com/api/pages/page-1/webhooks', {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
}

const PARAMS = { params: Promise.resolve({ pageId: 'page-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequestWithOptions.mockResolvedValue(SESSION_AUTH);
  mockIsAuthError.mockReturnValue(false);
  mockCanManagePageWebhooks.mockResolvedValue(true);
});

describe('GET /api/pages/[pageId]/webhooks', () => {
  it('lists webhooks for a manager, stripping the encrypted secret from every row', async () => {
    mockPageWebhooksFindMany.mockResolvedValue([
      { id: 'wh-1', name: 'Deploys', webhookToken: 'tok', webhookSecretEncrypted: 'secret-should-not-leak', isEnabled: true },
    ]);
    const response = await GET(makeRequest(), PARAMS);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.webhooks).toEqual([{ id: 'wh-1', name: 'Deploys', webhookToken: 'tok', isEnabled: true }]);
    expect(JSON.stringify(body)).not.toContain('secret-should-not-leak');
  });

  it('rejects a non-owner/admin with 403', async () => {
    mockCanManagePageWebhooks.mockResolvedValue(false);
    const response = await GET(makeRequest(), PARAMS);
    expect(response.status).toBe(403);
    expect(mockPageWebhooksFindMany).not.toHaveBeenCalled();
  });

  it('propagates an auth error unchanged', async () => {
    const authError = { error: new Response(null, { status: 401 }) };
    mockAuthenticateRequestWithOptions.mockResolvedValue(authError);
    mockIsAuthError.mockReturnValue(true);
    const response = await GET(makeRequest(), PARAMS);
    expect(response.status).toBe(401);
    expect(mockCanManagePageWebhooks).not.toHaveBeenCalled();
  });
});

describe('POST /api/pages/[pageId]/webhooks', () => {
  it('creates a webhook, encrypts the secret at rest, and returns the plaintext secret exactly once', async () => {
    mockPagesFindFirst.mockResolvedValue({ isTrashed: false });
    mockInsertValues.mockResolvedValue([
      { id: 'wh-1', pageId: 'page-1', name: 'Deploys', webhookToken: 'tok-abc', webhookSecretEncrypted: 'encrypted(plain)', isEnabled: true, createdBy: 'user-1' },
    ]);
    const response = await POST(makeRequest({ name: 'Deploys' }), PARAMS);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.webhook).toEqual({ id: 'wh-1', pageId: 'page-1', name: 'Deploys', webhookToken: 'tok-abc', isEnabled: true, createdBy: 'user-1' });
    expect(typeof body.webhookSecret).toBe('string');
    expect(body.webhookSecret.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.webhook)).not.toContain('encrypted(');
    expect(mockAuditRequest).toHaveBeenCalled();
  });

  it('rejects a non-owner/admin with 403 without touching the page or inserting', async () => {
    mockCanManagePageWebhooks.mockResolvedValue(false);
    const response = await POST(makeRequest({ name: 'Deploys' }), PARAMS);
    expect(response.status).toBe(403);
    expect(mockPagesFindFirst).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('mints for any non-trashed page type — no CHANNEL gate', async () => {
    mockPagesFindFirst.mockResolvedValue({ isTrashed: false });
    mockInsertValues.mockResolvedValue([
      { id: 'wh-2', pageId: 'page-1', name: 'CI', webhookToken: 'tok-def', webhookSecretEncrypted: 'encrypted(plain)', isEnabled: true, createdBy: 'user-1' },
    ]);
    const response = await POST(makeRequest({ name: 'CI' }), PARAMS);
    expect(response.status).toBe(201);
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
  });

  it('rejects a trashed page with 400', async () => {
    mockPagesFindFirst.mockResolvedValue({ isTrashed: true });
    const response = await POST(makeRequest({ name: 'Deploys' }), PARAMS);
    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects a missing page with 404', async () => {
    mockPagesFindFirst.mockResolvedValue(undefined);
    const response = await POST(makeRequest({ name: 'Deploys' }), PARAMS);
    expect(response.status).toBe(404);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects an empty name', async () => {
    mockPagesFindFirst.mockResolvedValue({ isTrashed: false });
    const response = await POST(makeRequest({ name: '   ' }), PARAMS);
    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects a name over the length cap', async () => {
    mockPagesFindFirst.mockResolvedValue({ isTrashed: false });
    const response = await POST(makeRequest({ name: 'x'.repeat(81) }), PARAMS);
    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});

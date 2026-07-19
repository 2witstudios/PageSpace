import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAuthenticateRequestWithOptions = vi.fn();
const mockIsAuthError = vi.fn();
const mockCanManageChannelWebhooks = vi.fn();
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequestWithOptions(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
  canManageChannelWebhooks: (...args: unknown[]) => mockCanManageChannelWebhooks(...args),
}));

const mockChannelWebhooksFindMany = vi.fn();
const mockPagesFindFirst = vi.fn();
const mockInsertValues = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      channelWebhooks: { findMany: (...args: unknown[]) => mockChannelWebhooksFindMany(...args) },
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
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'pages.id', type: 'pages.type' } }));
vi.mock('@pagespace/db/schema/channel-webhooks', () => ({
  channelWebhooks: { pageId: 'channelWebhooks.pageId' },
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
  return new Request('https://example.com/api/channels/page-1/webhooks', {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
}

const PARAMS = { params: Promise.resolve({ pageId: 'page-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequestWithOptions.mockResolvedValue(SESSION_AUTH);
  mockIsAuthError.mockReturnValue(false);
  mockCanManageChannelWebhooks.mockResolvedValue(true);
});

describe('GET /api/channels/[pageId]/webhooks', () => {
  it('lists webhooks for a manager, stripping the encrypted secret from every row', async () => {
    mockChannelWebhooksFindMany.mockResolvedValue([
      { id: 'wh-1', name: 'Deploys', webhookToken: 'tok', webhookSecretEncrypted: 'secret-should-not-leak', isEnabled: true },
    ]);
    const response = await GET(makeRequest(), PARAMS);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.webhooks).toEqual([{ id: 'wh-1', name: 'Deploys', webhookToken: 'tok', isEnabled: true }]);
    expect(JSON.stringify(body)).not.toContain('secret-should-not-leak');
  });

  it('rejects a non-owner/admin with 403', async () => {
    mockCanManageChannelWebhooks.mockResolvedValue(false);
    const response = await GET(makeRequest(), PARAMS);
    expect(response.status).toBe(403);
    expect(mockChannelWebhooksFindMany).not.toHaveBeenCalled();
  });

  it('propagates an auth error unchanged', async () => {
    const authError = { error: new Response(null, { status: 401 }) };
    mockAuthenticateRequestWithOptions.mockResolvedValue(authError);
    mockIsAuthError.mockReturnValue(true);
    const response = await GET(makeRequest(), PARAMS);
    expect(response.status).toBe(401);
    expect(mockCanManageChannelWebhooks).not.toHaveBeenCalled();
  });
});

describe('POST /api/channels/[pageId]/webhooks', () => {
  it('creates a webhook, encrypts the secret at rest, and returns the plaintext secret exactly once', async () => {
    mockPagesFindFirst.mockResolvedValue({ type: 'CHANNEL' });
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
    mockCanManageChannelWebhooks.mockResolvedValue(false);
    const response = await POST(makeRequest({ name: 'Deploys' }), PARAMS);
    expect(response.status).toBe(403);
    expect(mockPagesFindFirst).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects a page that is not a CHANNEL', async () => {
    mockPagesFindFirst.mockResolvedValue({ type: 'DOCUMENT' });
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
    mockPagesFindFirst.mockResolvedValue({ type: 'CHANNEL' });
    const response = await POST(makeRequest({ name: '   ' }), PARAMS);
    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects a name over the length cap', async () => {
    mockPagesFindFirst.mockResolvedValue({ type: 'CHANNEL' });
    const response = await POST(makeRequest({ name: 'x'.repeat(81) }), PARAMS);
    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});

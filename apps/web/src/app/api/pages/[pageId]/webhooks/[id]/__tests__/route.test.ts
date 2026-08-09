import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAuthenticateRequestWithOptions = vi.fn();
const mockIsAuthError = vi.fn();
const mockCanManagePageWebhooks = vi.fn();
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequestWithOptions(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
  canManagePageWebhooks: (...args: unknown[]) => mockCanManagePageWebhooks(...args),
}));

const mockFindFirst = vi.fn();
const mockUpdateReturning = vi.fn();
const mockDeleteWhere = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { pageWebhooks: { findFirst: (...args: unknown[]) => mockFindFirst(...args) } },
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => mockUpdateReturning(),
        }),
      }),
    }),
    delete: () => ({
      where: (...args: unknown[]) => mockDeleteWhere(...args),
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
  and: (...args: unknown[]) => ({ and: args }),
}));
vi.mock('@pagespace/db/schema/page-webhooks', () => ({
  pageWebhooks: { id: 'pageWebhooks.id', pageId: 'pageWebhooks.pageId' },
}));

const mockAuditRequest = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import { PATCH, DELETE } from '../route';

const SESSION_AUTH = { userId: 'user-1', kind: 'session' };
const PARAMS = { params: Promise.resolve({ pageId: 'page-1', id: 'wh-1' }) };
const WEBHOOK_ROW = {
  id: 'wh-1',
  pageId: 'page-1',
  name: 'Deploys',
  webhookToken: 'tok-abc',
  webhookSecretEncrypted: 'secret-should-not-leak',
  isEnabled: true,
  createdBy: 'user-1',
};

function makeRequest(method: string, body?: unknown): Request {
  return new Request('https://example.com/api/pages/page-1/webhooks/wh-1', {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequestWithOptions.mockResolvedValue(SESSION_AUTH);
  mockIsAuthError.mockReturnValue(false);
  mockCanManagePageWebhooks.mockResolvedValue(true);
  mockFindFirst.mockResolvedValue(WEBHOOK_ROW);
});

describe('PATCH /api/pages/[pageId]/webhooks/[id]', () => {
  it('toggles isEnabled and strips the encrypted secret from the response', async () => {
    mockUpdateReturning.mockResolvedValue([{ ...WEBHOOK_ROW, isEnabled: false }]);
    const response = await PATCH(makeRequest('PATCH', { isEnabled: false }), PARAMS);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.webhook.isEnabled).toBe(false);
    expect(JSON.stringify(body)).not.toContain('secret-should-not-leak');
    expect(mockAuditRequest).toHaveBeenCalled();
  });

  it('renames a webhook', async () => {
    mockUpdateReturning.mockResolvedValue([{ ...WEBHOOK_ROW, name: 'Renamed' }]);
    const response = await PATCH(makeRequest('PATCH', { name: 'Renamed' }), PARAMS);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.webhook.name).toBe('Renamed');
  });

  it('rejects an empty body', async () => {
    const response = await PATCH(makeRequest('PATCH', {}), PARAMS);
    expect(response.status).toBe(400);
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it('rejects a non-owner/admin with 403', async () => {
    mockCanManagePageWebhooks.mockResolvedValue(false);
    const response = await PATCH(makeRequest('PATCH', { isEnabled: false }), PARAMS);
    expect(response.status).toBe(403);
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it('returns 404 for a webhook not owned by this page', async () => {
    mockFindFirst.mockResolvedValue(null);
    const response = await PATCH(makeRequest('PATCH', { isEnabled: false }), PARAMS);
    expect(response.status).toBe(404);
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/pages/[pageId]/webhooks/[id]', () => {
  it('deletes an owned webhook and returns 204', async () => {
    mockDeleteWhere.mockResolvedValue(undefined);
    const response = await DELETE(makeRequest('DELETE'), PARAMS);
    expect(response.status).toBe(204);
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    expect(mockAuditRequest).toHaveBeenCalled();
  });

  it('rejects a non-owner/admin with 403 without deleting', async () => {
    mockCanManagePageWebhooks.mockResolvedValue(false);
    const response = await DELETE(makeRequest('DELETE'), PARAMS);
    expect(response.status).toBe(403);
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });

  it('returns 404 for a webhook not owned by this page, without deleting', async () => {
    mockFindFirst.mockResolvedValue(null);
    const response = await DELETE(makeRequest('DELETE'), PARAMS);
    expect(response.status).toBe(404);
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });
});

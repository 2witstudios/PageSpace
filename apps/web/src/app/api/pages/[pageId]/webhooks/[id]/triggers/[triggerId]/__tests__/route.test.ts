import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAuthenticateRequestWithOptions = vi.fn();
const mockIsAuthError = vi.fn();
const mockCanManagePageWebhooks = vi.fn();
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequestWithOptions(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
  canManagePageWebhooks: (...args: unknown[]) => mockCanManagePageWebhooks(...args),
}));

const mockWebhookFindFirst = vi.fn();
const mockTriggerFindFirst = vi.fn();
const mockUpdateReturning = vi.fn();
const mockDeleteWhere = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pageWebhooks: { findFirst: (...args: unknown[]) => mockWebhookFindFirst(...args) },
      webhookTriggers: { findFirst: (...args: unknown[]) => mockTriggerFindFirst(...args) },
    },
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
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  and: (...args: unknown[]) => ({ and: args }),
}));
vi.mock('@pagespace/db/schema/page-webhooks', () => ({
  pageWebhooks: { id: 'pageWebhooks.id', pageId: 'pageWebhooks.pageId' },
}));
vi.mock('@pagespace/db/schema/webhook-triggers', () => ({
  webhookTriggers: { id: 'webhookTriggers.id', pageWebhookId: 'webhookTriggers.pageWebhookId' },
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
const PARAMS = { params: Promise.resolve({ pageId: 'page-1', id: 'wh-1', triggerId: 't-1' }) };
const TRIGGER_ROW = { id: 't-1', pageWebhookId: 'wh-1', workflowId: 'wf-1', isEnabled: true };

function makeRequest(method: string, body?: unknown): Request {
  return new Request('https://example.com/api/pages/page-1/webhooks/wh-1/triggers/t-1', {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequestWithOptions.mockResolvedValue(SESSION_AUTH);
  mockIsAuthError.mockReturnValue(false);
  mockCanManagePageWebhooks.mockResolvedValue(true);
  mockWebhookFindFirst.mockResolvedValue({ id: 'wh-1' });
  mockTriggerFindFirst.mockResolvedValue(TRIGGER_ROW);
});

describe('PATCH /api/pages/[pageId]/webhooks/[id]/triggers/[triggerId]', () => {
  it('toggles isEnabled and audits the change', async () => {
    mockUpdateReturning.mockResolvedValue([{ ...TRIGGER_ROW, isEnabled: false }]);
    const response = await PATCH(makeRequest('PATCH', { isEnabled: false }), PARAMS);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.trigger.isEnabled).toBe(false);
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceType: 'webhook_trigger', details: expect.objectContaining({ operation: 'toggle' }) }),
    );
  });

  it('rejects an empty body with 400', async () => {
    const response = await PATCH(makeRequest('PATCH', {}), PARAMS);
    expect(response.status).toBe(400);
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it('rejects a non-owner/admin with 403', async () => {
    mockCanManagePageWebhooks.mockResolvedValue(false);
    const response = await PATCH(makeRequest('PATCH', { isEnabled: false }), PARAMS);
    expect(response.status).toBe(403);
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it('returns 404 when the trigger is not on this page webhook', async () => {
    mockTriggerFindFirst.mockResolvedValue(null);
    const response = await PATCH(makeRequest('PATCH', { isEnabled: false }), PARAMS);
    expect(response.status).toBe(404);
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it('returns 404 when the webhook is not on this page', async () => {
    mockWebhookFindFirst.mockResolvedValue(null);
    const response = await PATCH(makeRequest('PATCH', { isEnabled: false }), PARAMS);
    expect(response.status).toBe(404);
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it('returns 404 without auditing when the row vanishes between the check and the update (TOCTOU)', async () => {
    // Ownership check passes, but a concurrent DELETE removes the row before the
    // UPDATE lands — returning() yields nothing.
    mockUpdateReturning.mockResolvedValue([]);
    const response = await PATCH(makeRequest('PATCH', { isEnabled: false }), PARAMS);
    expect(response.status).toBe(404);
    expect(mockAuditRequest).not.toHaveBeenCalled();
  });

  it('scopes both lookups so a trigger on another page/webhook cannot be toggled (IDOR)', async () => {
    mockUpdateReturning.mockResolvedValue([{ ...TRIGGER_ROW, isEnabled: false }]);
    await PATCH(makeRequest('PATCH', { isEnabled: false }), PARAMS);
    // Webhook must be AND-scoped to (id, pageId)...
    expect(mockWebhookFindFirst.mock.calls[0][0].where).toEqual({
      and: [
        { eq: ['pageWebhooks.id', 'wh-1'] },
        { eq: ['pageWebhooks.pageId', 'page-1'] },
      ],
    });
    // ...and the trigger AND-scoped to (triggerId, pageWebhookId).
    expect(mockTriggerFindFirst.mock.calls[0][0].where).toEqual({
      and: [
        { eq: ['webhookTriggers.id', 't-1'] },
        { eq: ['webhookTriggers.pageWebhookId', 'wh-1'] },
      ],
    });
  });
});

describe('DELETE /api/pages/[pageId]/webhooks/[id]/triggers/[triggerId]', () => {
  it('detaches an owned trigger and returns 204', async () => {
    mockDeleteWhere.mockResolvedValue(undefined);
    const response = await DELETE(makeRequest('DELETE'), PARAMS);
    expect(response.status).toBe(204);
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceType: 'webhook_trigger', details: expect.objectContaining({ operation: 'delete' }) }),
    );
  });

  it('rejects a non-owner/admin with 403 without deleting', async () => {
    mockCanManagePageWebhooks.mockResolvedValue(false);
    const response = await DELETE(makeRequest('DELETE'), PARAMS);
    expect(response.status).toBe(403);
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });

  it('returns 404 for a trigger not on this page webhook, without deleting', async () => {
    mockTriggerFindFirst.mockResolvedValue(null);
    const response = await DELETE(makeRequest('DELETE'), PARAMS);
    expect(response.status).toBe(404);
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });
});

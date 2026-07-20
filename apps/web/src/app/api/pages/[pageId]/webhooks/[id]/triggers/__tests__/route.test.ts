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
const mockPageFindFirst = vi.fn();
const mockWorkflowFindFirst = vi.fn();
const mockTriggerFindFirst = vi.fn();
const mockTriggerFindMany = vi.fn();
const mockInsertReturning = vi.fn();
const mockCountResult = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pageWebhooks: { findFirst: (...args: unknown[]) => mockWebhookFindFirst(...args) },
      pages: { findFirst: (...args: unknown[]) => mockPageFindFirst(...args) },
      workflows: { findFirst: (...args: unknown[]) => mockWorkflowFindFirst(...args) },
      webhookTriggers: {
        findFirst: (...args: unknown[]) => mockTriggerFindFirst(...args),
        findMany: (...args: unknown[]) => mockTriggerFindMany(...args),
      },
    },
    select: () => ({
      from: () => ({
        where: () => mockCountResult(),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => mockInsertReturning(),
        }),
      }),
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  and: (...args: unknown[]) => ({ and: args }),
  asc: (col: unknown) => ({ asc: col }),
  count: () => ({ count: true }),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id' },
}));
vi.mock('@pagespace/db/schema/page-webhooks', () => ({
  pageWebhooks: { id: 'pageWebhooks.id', pageId: 'pageWebhooks.pageId' },
}));
vi.mock('@pagespace/db/schema/webhook-triggers', () => ({
  webhookTriggers: {
    id: 'webhookTriggers.id',
    pageWebhookId: 'webhookTriggers.pageWebhookId',
    workflowId: 'webhookTriggers.workflowId',
    createdAt: 'webhookTriggers.createdAt',
  },
  PAGE_WEBHOOK_EVENT_TYPE: '*',
}));
vi.mock('@pagespace/db/schema/workflows', () => ({
  workflows: { id: 'workflows.id' },
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
const PARAMS = { params: Promise.resolve({ pageId: 'page-1', id: 'wh-1' }) };

function makeRequest(method: string, body?: unknown): Request {
  return new Request('https://example.com/api/pages/page-1/webhooks/wh-1/triggers', {
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
  mockPageFindFirst.mockResolvedValue({ driveId: 'drive-1' });
  mockWorkflowFindFirst.mockResolvedValue({ id: 'wf-1', driveId: 'drive-1' });
  mockTriggerFindFirst.mockResolvedValue(null); // no existing binding by default
  mockCountResult.mockResolvedValue([{ value: 0 }]);
});

describe('GET /api/pages/[pageId]/webhooks/[id]/triggers', () => {
  it('lists the webhook triggers with a bounded, deterministically-ordered query', async () => {
    mockTriggerFindMany.mockResolvedValue([{ id: 't-1', pageWebhookId: 'wh-1', workflowId: 'wf-1' }]);
    const response = await GET(makeRequest('GET'), PARAMS);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.triggers).toHaveLength(1);
    expect(mockTriggerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, orderBy: expect.any(Array) }),
    );
  });

  it('rejects a non-owner/admin with 403', async () => {
    mockCanManagePageWebhooks.mockResolvedValue(false);
    const response = await GET(makeRequest('GET'), PARAMS);
    expect(response.status).toBe(403);
    expect(mockTriggerFindMany).not.toHaveBeenCalled();
  });

  it('returns 404 when the webhook is not on this page', async () => {
    mockWebhookFindFirst.mockResolvedValue(null);
    const response = await GET(makeRequest('GET'), PARAMS);
    expect(response.status).toBe(404);
    expect(mockTriggerFindMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/pages/[pageId]/webhooks/[id]/triggers', () => {
  it('binds a same-drive workflow and audits the create', async () => {
    mockInsertReturning.mockResolvedValue([{ id: 't-1', pageWebhookId: 'wh-1', workflowId: 'wf-1' }]);
    const response = await POST(makeRequest('POST', { workflowId: 'wf-1' }), PARAMS);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.trigger.id).toBe('t-1');
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', resourceType: 'webhook_trigger' }),
    );
  });

  it('rejects a foreign-drive workflow with 400 and does not insert', async () => {
    mockWorkflowFindFirst.mockResolvedValue({ id: 'wf-1', driveId: 'drive-OTHER' });
    const response = await POST(makeRequest('POST', { workflowId: 'wf-1' }), PARAMS);
    expect(response.status).toBe(400);
    expect(mockInsertReturning).not.toHaveBeenCalled();
    expect(mockAuditRequest).not.toHaveBeenCalled();
  });

  it('returns 200 (idempotent) when the binding already exists, without re-inserting or counting', async () => {
    mockTriggerFindFirst.mockResolvedValue({ id: 't-existing', pageWebhookId: 'wh-1', workflowId: 'wf-1' });
    const response = await POST(makeRequest('POST', { workflowId: 'wf-1' }), PARAMS);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.trigger.id).toBe('t-existing');
    expect(mockCountResult).not.toHaveBeenCalled();
    expect(mockInsertReturning).not.toHaveBeenCalled();
  });

  it('rejects a genuinely-new binding beyond the per-webhook cap with 409', async () => {
    mockCountResult.mockResolvedValue([{ value: 100 }]);
    const response = await POST(makeRequest('POST', { workflowId: 'wf-new' }), PARAMS);
    expect(response.status).toBe(409);
    expect(mockInsertReturning).not.toHaveBeenCalled();
  });

  it('returns 404 when the workflow does not exist', async () => {
    mockWorkflowFindFirst.mockResolvedValue(null);
    const response = await POST(makeRequest('POST', { workflowId: 'missing' }), PARAMS);
    expect(response.status).toBe(404);
    expect(mockInsertReturning).not.toHaveBeenCalled();
  });

  it('returns 404 when the webhook is not on this page', async () => {
    mockWebhookFindFirst.mockResolvedValue(null);
    const response = await POST(makeRequest('POST', { workflowId: 'wf-1' }), PARAMS);
    expect(response.status).toBe(404);
    expect(mockWorkflowFindFirst).not.toHaveBeenCalled();
  });

  it('rejects a missing workflowId with 400', async () => {
    const response = await POST(makeRequest('POST', {}), PARAMS);
    expect(response.status).toBe(400);
    expect(mockInsertReturning).not.toHaveBeenCalled();
  });

  it('rejects a non-owner/admin with 403 before touching the workflow', async () => {
    mockCanManagePageWebhooks.mockResolvedValue(false);
    const response = await POST(makeRequest('POST', { workflowId: 'wf-1' }), PARAMS);
    expect(response.status).toBe(403);
    expect(mockWorkflowFindFirst).not.toHaveBeenCalled();
  });
});

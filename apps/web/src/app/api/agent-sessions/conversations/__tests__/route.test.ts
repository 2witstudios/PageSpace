// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockAuditRequest,
  mockListAllConversationsPaginated,
  mockGetBatchPagePermissions,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockAuditRequest: vi.fn(),
  mockListAllConversationsPaginated: vi.fn(),
  mockGetBatchPagePermissions: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => result != null && typeof result === 'object' && 'error' in result,
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn() } },
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getBatchPagePermissions: (...args: unknown[]) => mockGetBatchPagePermissions(...args),
}));
vi.mock('@/lib/agent-sessions/agent-sessions-conversations-runtime', () => ({
  listAllConversationsPaginated: (...args: unknown[]) => mockListAllConversationsPaginated(...args),
}));

import { GET } from '../route';

const AUTH_ADMIN = { userId: 'user-1', role: 'admin' };
const AUTH_NON_ADMIN = { userId: 'user-2', role: 'user' };

const GLOBAL_ROW = {
  conversationId: 'conv-global',
  title: 'Global chat',
  type: 'global',
  agentPageId: null,
  pageTitle: null,
  lastMessageAt: '2026-07-28T00:00:00.000Z',
  createdAt: '2026-07-27T00:00:00.000Z',
  sessionId: null,
  sessionName: null,
  sessionEndedAt: null,
  driveId: null,
};

const PAGE_ROW = {
  conversationId: 'conv-page',
  title: null,
  type: 'page',
  agentPageId: 'agent-1',
  pageTitle: 'My Agent',
  lastMessageAt: '2026-07-28T00:00:00.000Z',
  createdAt: '2026-07-27T00:00:00.000Z',
  sessionId: null,
  sessionName: null,
  sessionEndedAt: null,
  driveId: 'drive-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_ADMIN);
  mockListAllConversationsPaginated.mockResolvedValue({
    conversations: [GLOBAL_ROW],
    pagination: { hasMore: false, nextCursor: null, limit: 20 },
  });
});

describe('GET /api/agent-sessions/conversations', () => {
  it('given an admin with no filter, lists their conversations', async () => {
    const response = await GET(new Request('http://localhost/api/agent-sessions/conversations'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      conversations: [GLOBAL_ROW],
      pagination: { hasMore: false, nextCursor: null, limit: 20 },
    });
    expect(mockListAllConversationsPaginated).toHaveBeenCalledWith(
      { ownerId: 'user-1', driveId: undefined },
      { limit: 20, cursor: undefined },
    );
    // No page rows in this page of results — the batch permission check
    // never runs (nothing to mask).
    expect(mockGetBatchPagePermissions).not.toHaveBeenCalled();
  });

  it('given ?driveId=, narrows the listing filter', async () => {
    await GET(new Request('http://localhost/api/agent-sessions/conversations?driveId=drive-1'));
    expect(mockListAllConversationsPaginated).toHaveBeenCalledWith(
      { ownerId: 'user-1', driveId: 'drive-1' },
      { limit: 20, cursor: undefined },
    );
  });

  it('given ?limit=&cursor=, passes them through bounded', async () => {
    await GET(new Request('http://localhost/api/agent-sessions/conversations?limit=5&cursor=conv-9'));
    expect(mockListAllConversationsPaginated).toHaveBeenCalledWith(
      { ownerId: 'user-1', driveId: undefined },
      { limit: 5, cursor: 'conv-9' },
    );
  });

  it('given a non-admin, 403s without enumerating anything, and audits the denial', async () => {
    mockAuthenticateRequest.mockResolvedValue(AUTH_NON_ADMIN);
    const response = await GET(new Request('http://localhost/api/agent-sessions/conversations'));
    expect(response.status).toBe(403);
    expect(mockListAllConversationsPaginated).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied' }),
    );
  });

  describe('page-derived metadata masking (app-admin status does not imply current page access)', () => {
    beforeEach(() => {
      mockListAllConversationsPaginated.mockResolvedValue({
        conversations: [PAGE_ROW, GLOBAL_ROW],
        pagination: { hasMore: false, nextCursor: null, limit: 20 },
      });
    });

    it('keeps pageTitle/driveId when the requester can still view the page', async () => {
      mockGetBatchPagePermissions.mockResolvedValue(new Map([['agent-1', { canView: true }]]));

      const response = await GET(new Request('http://localhost/api/agent-sessions/conversations'));
      const body = await response.json();

      expect(mockGetBatchPagePermissions).toHaveBeenCalledWith('user-1', ['agent-1']);
      expect(body.conversations).toEqual([PAGE_ROW, GLOBAL_ROW]);
    });

    it('masks pageTitle/driveId — but keeps the conversation row — when the requester can no longer view the page', async () => {
      // The requester authored this conversation while a member of the page's
      // drive, then lost that membership. App-admin status alone must not
      // stand in for a page-level view check (review finding).
      mockGetBatchPagePermissions.mockResolvedValue(new Map([['agent-1', { canView: false }]]));

      const response = await GET(new Request('http://localhost/api/agent-sessions/conversations'));
      const body = await response.json();

      expect(body.conversations).toEqual([
        { ...PAGE_ROW, pageTitle: null, driveId: null },
        GLOBAL_ROW,
      ]);
    });

    it('masks when the permission map has no entry at all for the page (fails closed)', async () => {
      mockGetBatchPagePermissions.mockResolvedValue(new Map());

      const response = await GET(new Request('http://localhost/api/agent-sessions/conversations'));
      const body = await response.json();

      expect(body.conversations[0]).toEqual({ ...PAGE_ROW, pageTitle: null, driveId: null });
    });

    it('batch-checks once for every distinct agentPageId, never per-row (no N+1)', async () => {
      mockListAllConversationsPaginated.mockResolvedValue({
        conversations: [PAGE_ROW, { ...PAGE_ROW, conversationId: 'conv-page-2' }],
        pagination: { hasMore: false, nextCursor: null, limit: 20 },
      });
      mockGetBatchPagePermissions.mockResolvedValue(new Map([['agent-1', { canView: true }]]));

      await GET(new Request('http://localhost/api/agent-sessions/conversations'));

      expect(mockGetBatchPagePermissions).toHaveBeenCalledTimes(1);
      expect(mockGetBatchPagePermissions).toHaveBeenCalledWith('user-1', ['agent-1']);
    });
  });

  describe('drive-scoped requests DROP (not mask) an inaccessible page row', () => {
    // The ?driveId= filter runs against the page's CURRENT driveId before any
    // permission check — so a masked-but-present row in a driveId-scoped
    // result would itself confirm "this inaccessible page currently belongs
    // to this drive", an oracle a caller could probe across candidate drive
    // ids (review finding). Masking alone (keep the row, null the fields) is
    // only safe when NOT scoped to a specific drive.
    beforeEach(() => {
      mockListAllConversationsPaginated.mockResolvedValue({
        conversations: [PAGE_ROW, GLOBAL_ROW],
        pagination: { hasMore: false, nextCursor: null, limit: 20 },
      });
    });

    it('drops the row entirely when driveId is scoped and the page is inaccessible', async () => {
      mockGetBatchPagePermissions.mockResolvedValue(new Map([['agent-1', { canView: false }]]));

      const response = await GET(new Request('http://localhost/api/agent-sessions/conversations?driveId=drive-1'));
      const body = await response.json();

      expect(body.conversations).toEqual([GLOBAL_ROW]);
    });

    it('still masks (keeps the row) rather than dropping when driveId is NOT scoped', async () => {
      mockGetBatchPagePermissions.mockResolvedValue(new Map([['agent-1', { canView: false }]]));

      const response = await GET(new Request('http://localhost/api/agent-sessions/conversations'));
      const body = await response.json();

      expect(body.conversations).toEqual([{ ...PAGE_ROW, pageTitle: null, driveId: null }, GLOBAL_ROW]);
    });

    it('keeps the row in full when driveId is scoped and the page IS accessible', async () => {
      mockGetBatchPagePermissions.mockResolvedValue(new Map([['agent-1', { canView: true }]]));

      const response = await GET(new Request('http://localhost/api/agent-sessions/conversations?driveId=drive-1'));
      const body = await response.json();

      expect(body.conversations).toEqual([PAGE_ROW, GLOBAL_ROW]);
    });
  });
});

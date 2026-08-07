// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockListAllConversationsPaginated,
  mockGetBatchPagePermissions,
  mockResolveDriveMembership,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockListAllConversationsPaginated: vi.fn(),
  mockGetBatchPagePermissions: vi.fn(),
  mockResolveDriveMembership: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => result != null && typeof result === 'object' && 'error' in result,
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn() } },
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getBatchPagePermissions: (...args: unknown[]) => mockGetBatchPagePermissions(...args),
}));
vi.mock('@pagespace/lib/services/agent-workspaces/agent-session-tenant', () => ({
  resolveDriveMembership: (...args: unknown[]) => mockResolveDriveMembership(...args),
}));
vi.mock('@/lib/agent-workspaces/agent-sessions-conversations-runtime', () => ({
  listAllConversationsPaginated: (...args: unknown[]) => mockListAllConversationsPaginated(...args),
  encodeCursor: (sortKey: Date | string, id: string) =>
    Buffer.from(JSON.stringify({ sortKey: new Date(sortKey).toISOString(), id })).toString('base64url'),
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
  workspaceId: null,
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
  workspaceId: null,
  sessionName: null,
  sessionEndedAt: null,
  driveId: 'drive-1',
};

// A `type: 'global'` conversation bound to a drive-scoped agent session —
// any accepted member of `driveId` may have created this (session access is
// granted by drive membership, not session ownership), so this row can exist
// even for a session `user-1` doesn't own.
const SESSION_GLOBAL_ROW = {
  conversationId: 'conv-session-global',
  title: null,
  type: 'global',
  agentPageId: null,
  pageTitle: null,
  lastMessageAt: '2026-07-28T00:00:00.000Z',
  createdAt: '2026-07-27T00:00:00.000Z',
  workspaceId: 'session-1',
  sessionName: 'My Sandbox',
  sessionEndedAt: null,
  driveId: 'drive-2',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_ADMIN);
  mockListAllConversationsPaginated.mockResolvedValue({
    conversations: [GLOBAL_ROW],
    pagination: { hasMore: false, nextCursor: null, limit: 20 },
  });
});

describe('GET /api/agent-workspaces/conversations', () => {
  it('given an admin with no filter, lists their conversations', async () => {
    const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations'));
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
    await GET(new Request('http://localhost/api/agent-workspaces/conversations?driveId=drive-1'));
    expect(mockListAllConversationsPaginated).toHaveBeenCalledWith(
      { ownerId: 'user-1', driveId: 'drive-1' },
      { limit: 20, cursor: undefined },
    );
  });

  it('given ?limit=&cursor=, passes them through bounded', async () => {
    await GET(new Request('http://localhost/api/agent-workspaces/conversations?limit=5&cursor=conv-9'));
    expect(mockListAllConversationsPaginated).toHaveBeenCalledWith(
      { ownerId: 'user-1', driveId: undefined },
      { limit: 5, cursor: 'conv-9' },
    );
  });

  it('given a non-admin, lists THEIR OWN conversations same as an admin — this listing is open to every authenticated user', async () => {
    mockAuthenticateRequest.mockResolvedValue(AUTH_NON_ADMIN);
    const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations'));
    expect(response.status).toBe(200);
    expect(mockListAllConversationsPaginated).toHaveBeenCalledWith(
      { ownerId: 'user-2', driveId: undefined },
      { limit: 20, cursor: undefined },
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

      const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations'));
      const body = await response.json();

      expect(mockGetBatchPagePermissions).toHaveBeenCalledWith('user-1', ['agent-1']);
      expect(body.conversations).toEqual([PAGE_ROW, GLOBAL_ROW]);
    });

    it('masks pageTitle/driveId — but keeps the conversation row — when the requester can no longer view the page', async () => {
      // The requester authored this conversation while a member of the page's
      // drive, then lost that membership. App-admin status alone must not
      // stand in for a page-level view check (review finding).
      mockGetBatchPagePermissions.mockResolvedValue(new Map([['agent-1', { canView: false }]]));

      const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations'));
      const body = await response.json();

      expect(body.conversations).toEqual([
        { ...PAGE_ROW, pageTitle: null, driveId: null },
        GLOBAL_ROW,
      ]);
    });

    it('masks when the permission map has no entry at all for the page (fails closed)', async () => {
      mockGetBatchPagePermissions.mockResolvedValue(new Map());

      const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations'));
      const body = await response.json();

      expect(body.conversations[0]).toEqual({ ...PAGE_ROW, pageTitle: null, driveId: null });
    });

    it('batch-checks once for every distinct agentPageId, never per-row (no N+1)', async () => {
      mockListAllConversationsPaginated.mockResolvedValue({
        conversations: [PAGE_ROW, { ...PAGE_ROW, conversationId: 'conv-page-2' }],
        pagination: { hasMore: false, nextCursor: null, limit: 20 },
      });
      mockGetBatchPagePermissions.mockResolvedValue(new Map([['agent-1', { canView: true }]]));

      await GET(new Request('http://localhost/api/agent-workspaces/conversations'));

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

      const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations?driveId=drive-1'));
      const body = await response.json();

      expect(body.conversations).toEqual([GLOBAL_ROW]);
    });

    it('still masks (keeps the row) rather than dropping when driveId is NOT scoped', async () => {
      mockGetBatchPagePermissions.mockResolvedValue(new Map([['agent-1', { canView: false }]]));

      const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations'));
      const body = await response.json();

      expect(body.conversations).toEqual([{ ...PAGE_ROW, pageTitle: null, driveId: null }, GLOBAL_ROW]);
    });

    it('keeps the row in full when driveId is scoped and the page IS accessible', async () => {
      mockGetBatchPagePermissions.mockResolvedValue(new Map([['agent-1', { canView: true }]]));

      const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations?driveId=drive-1'));
      const body = await response.json();

      expect(body.conversations).toEqual([PAGE_ROW, GLOBAL_ROW]);
    });
  });

  describe('dropping inaccessible rows keeps fetching rather than returning a stuck-empty page', () => {
    // Dropping (not masking) can turn a full DB-level page into fewer, or
    // zero, visible rows while `hasMore`/`nextCursor` still describe the
    // unfiltered page underneath. Returning that directly breaks the
    // frontend: an empty first page renders the terminal empty state and
    // hides Prev/Next, permanently hiding a later, actually-visible row
    // (review finding).
    it('the first DB page is entirely dropped rows: transparently fetches the next page and returns its visible row', async () => {
      mockListAllConversationsPaginated
        .mockResolvedValueOnce({
          conversations: [PAGE_ROW],
          pagination: { hasMore: true, nextCursor: 'cursor-1', limit: 20 },
        })
        .mockResolvedValueOnce({
          conversations: [{ ...GLOBAL_ROW, conversationId: 'conv-global-2' }],
          pagination: { hasMore: false, nextCursor: null, limit: 20 },
        });
      mockGetBatchPagePermissions.mockResolvedValue(new Map([['agent-1', { canView: false }]]));

      const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations?driveId=drive-1'));
      const body = await response.json();

      expect(mockListAllConversationsPaginated).toHaveBeenCalledTimes(2);
      expect(mockListAllConversationsPaginated).toHaveBeenNthCalledWith(
        2,
        { ownerId: 'user-1', driveId: 'drive-1' },
        { limit: 20, cursor: 'cursor-1' },
      );
      expect(body.conversations).toEqual([{ ...GLOBAL_ROW, conversationId: 'conv-global-2' }]);
      expect(body.pagination).toEqual({ hasMore: false, nextCursor: null, limit: 20 });
    });

    it('an unbroken run of dropped rows stops at the internal fetch cap and still returns a real, continuable answer', async () => {
      for (let i = 1; i <= 5; i++) {
        mockListAllConversationsPaginated.mockResolvedValueOnce({
          conversations: [PAGE_ROW],
          pagination: { hasMore: true, nextCursor: `cursor-${i}`, limit: 20 },
        });
      }
      mockGetBatchPagePermissions.mockResolvedValue(new Map([['agent-1', { canView: false }]]));

      const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations?driveId=drive-1'));
      const body = await response.json();

      // Capped, not unbounded: exactly 5 internal fetches, not one per
      // remaining page of a user's entire (hypothetically huge) history.
      expect(mockListAllConversationsPaginated).toHaveBeenCalledTimes(5);
      expect(body.conversations).toEqual([]);
      // hasMore stays true and nextCursor carries the last cursor actually
      // reached — the caller can page again rather than being told (falsely)
      // that history has ended.
      expect(body.pagination).toEqual({ hasMore: true, nextCursor: 'cursor-5', limit: 20 });
    });

    it('accumulating past `limit` across internal fetches truncates to `limit` and derives nextCursor from the last KEPT row, not the raw DB cursor', async () => {
      mockListAllConversationsPaginated
        .mockResolvedValueOnce({
          // Entirely dropped — forces a second internal fetch.
          conversations: [PAGE_ROW],
          pagination: { hasMore: true, nextCursor: 'cursor-1', limit: 2 },
        })
        .mockResolvedValueOnce({
          // 3 visible rows against a limit of 2 — pushes `visible` past `limit`.
          conversations: [
            { ...GLOBAL_ROW, conversationId: 'conv-a', lastMessageAt: '2026-07-29T00:00:00.000Z' },
            { ...GLOBAL_ROW, conversationId: 'conv-b', lastMessageAt: '2026-07-28T00:00:00.000Z' },
            { ...GLOBAL_ROW, conversationId: 'conv-c', lastMessageAt: '2026-07-27T00:00:00.000Z' },
          ],
          pagination: { hasMore: true, nextCursor: 'cursor-2', limit: 2 },
        });
      mockGetBatchPagePermissions.mockResolvedValue(new Map([['agent-1', { canView: false }]]));

      // Drive-scoped so the first fetch's row is DROPPED (not masked) —
      // otherwise a masked-but-kept row would occupy one of the two `limit`
      // slots itself, muddying what this test is isolating.
      const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations?limit=2&driveId=drive-1'));
      const body = await response.json();

      // Truncated to the requested limit, not the 3 rows the second fetch found.
      expect(body.conversations).toEqual([
        expect.objectContaining({ conversationId: 'conv-a' }),
        expect.objectContaining({ conversationId: 'conv-b' }),
      ]);
      expect(body.pagination.hasMore).toBe(true);
      // The cursor must come from `conv-b` (the last KEPT row) — not `cursor-2`
      // (the raw DB cursor, which would skip past `conv-b` and re-admit
      // `conv-c` a second time on the next page if it leaked through instead).
      const expectedCursor = Buffer.from(
        JSON.stringify({ sortKey: new Date('2026-07-28T00:00:00.000Z').toISOString(), id: 'conv-b' }),
      ).toString('base64url');
      expect(body.pagination.nextCursor).toBe(expectedCursor);
    });
  });

  describe('session-bound global rows: the session drive can belong to a different member than the requester', () => {
    // A drive-scoped agent session is a shared working context — any
    // accepted member may create their own `type: 'global'` conversation
    // inside it (session access is granted by drive membership, not session
    // ownership), so `conversations.userId` and the session's own `ownerId`
    // can legitimately differ. Conversation ownership never lapses, but
    // membership in that session's drive can — the same "authored it once,
    // current access unproven" gap already covered above for pages.
    beforeEach(() => {
      mockListAllConversationsPaginated.mockResolvedValue({
        conversations: [SESSION_GLOBAL_ROW, GLOBAL_ROW],
        pagination: { hasMore: false, nextCursor: null, limit: 20 },
      });
    });

    it('keeps the row in full when the requester still has access to the session drive', async () => {
      mockResolveDriveMembership.mockResolvedValue('member');

      const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations'));
      const body = await response.json();

      expect(mockResolveDriveMembership).toHaveBeenCalledWith({ userId: 'user-1', driveId: 'drive-2' });
      expect(body.conversations).toEqual([SESSION_GLOBAL_ROW, GLOBAL_ROW]);
    });

    it('masks the session-derived fields (keeps the row, as the conversation is still readable) when unscoped and access is lost', async () => {
      // The global-assistant message GET gates purely on `conversations.userId`
      // — never session or drive membership — so the conversation's own
      // content stays fully readable. Only the session-derived fields (which
      // `resolveNavigationTarget` would otherwise use to route into a pane
      // the requester can no longer open) are nulled.
      mockResolveDriveMembership.mockResolvedValue('none');

      const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations'));
      const body = await response.json();

      expect(body.conversations).toEqual([
        { ...SESSION_GLOBAL_ROW, workspaceId: null, driveId: null, sessionName: null, sessionEndedAt: null },
        GLOBAL_ROW,
      ]);
    });

    it('drops the row entirely when driveId is scoped and access is lost (same oracle risk as page rows)', async () => {
      mockResolveDriveMembership.mockResolvedValue('none');

      const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations?driveId=drive-2'));
      const body = await response.json();

      expect(mockListAllConversationsPaginated).toHaveBeenCalledWith(
        { ownerId: 'user-1', driveId: 'drive-2' },
        { limit: 20, cursor: undefined },
      );
      expect(body.conversations).toEqual([GLOBAL_ROW]);
    });

    it('keeps the row in full when driveId is scoped and access is NOT lost', async () => {
      mockResolveDriveMembership.mockResolvedValue('owner');

      const response = await GET(new Request('http://localhost/api/agent-workspaces/conversations?driveId=drive-2'));
      const body = await response.json();

      expect(body.conversations).toEqual([SESSION_GLOBAL_ROW, GLOBAL_ROW]);
    });

    it('never checks drive membership for a driveless global-assistant conversation (no session, nothing to check)', async () => {
      mockListAllConversationsPaginated.mockResolvedValue({
        conversations: [GLOBAL_ROW],
        pagination: { hasMore: false, nextCursor: null, limit: 20 },
      });

      await GET(new Request('http://localhost/api/agent-workspaces/conversations'));

      expect(mockResolveDriveMembership).not.toHaveBeenCalled();
    });

    it('batch-checks once per distinct driveId, never per-row (no N+1)', async () => {
      mockListAllConversationsPaginated.mockResolvedValue({
        conversations: [SESSION_GLOBAL_ROW, { ...SESSION_GLOBAL_ROW, conversationId: 'conv-session-global-2' }],
        pagination: { hasMore: false, nextCursor: null, limit: 20 },
      });
      mockResolveDriveMembership.mockResolvedValue('member');

      await GET(new Request('http://localhost/api/agent-workspaces/conversations'));

      expect(mockResolveDriveMembership).toHaveBeenCalledTimes(1);
    });
  });
});

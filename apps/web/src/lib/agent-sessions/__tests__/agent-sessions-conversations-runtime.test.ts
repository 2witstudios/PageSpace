/**
 * `listAllConversationsPaginated` had zero direct tests before this — the
 * `direction: 'before' | 'after'` cursor bug a review caught (the `after`
 * branch reused an unchanged `ORDER BY ... DESC`, so it returned the globally
 * newest matches instead of the page adjacent to the cursor) shipped without
 * one. That branch is now deleted entirely rather than fixed — this listing's
 * only caller never asks to go "forward" — so what's left to verify is the
 * unidirectional cursor's pagination math and the row mapping, not a
 * direction toggle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => {
  // A single chainable stub: every non-terminal call returns itself, and
  // `.limit()` is the ONE terminal method for both queries this module runs
  // (the cursor lookup ends `.where().limit(1)`; the main query ends
  // `.where().orderBy().limit(n)`) — a round-robin queue of canned responses,
  // consumed in call order, needs no per-query-shape branching.
  const responses: unknown[][] = [];
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(responses.shift() ?? [])),
  };
  return { db: chain, __queueResponse: (rows: unknown[]) => responses.push(rows) };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col, val) => ({ op: 'eq', col, val })),
  and: vi.fn((...args) => ({ op: 'and', args })),
  or: vi.fn((...args) => ({ op: 'or', args })),
  desc: vi.fn((field) => ({ op: 'desc', field })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values })),
  exists: vi.fn((sub) => ({ op: 'exists', sub })),
  isNotNull: vi.fn((col) => ({ op: 'isNotNull', col })),
}));
vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: {
    id: 'conversations.id', userId: 'conversations.userId', isActive: 'conversations.isActive',
    type: 'conversations.type', title: 'conversations.title', contextId: 'conversations.contextId',
    lastMessageAt: 'conversations.lastMessageAt', createdAt: 'conversations.createdAt',
    sessionId: 'conversations.sessionId', closedInSessionAt: 'conversations.closedInSessionAt',
  },
  messages: { conversationId: 'messages.conversationId', isActive: 'messages.isActive' },
}));
vi.mock('@pagespace/db/schema/agent-sessions', () => ({
  agentSessions: { id: 'agentSessions.id', driveId: 'agentSessions.driveId', name: 'agentSessions.name', endedAt: 'agentSessions.endedAt' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', title: 'pages.title', driveId: 'pages.driveId' },
  chatMessages: { pageId: 'chatMessages.pageId', conversationId: 'chatMessages.conversationId', isActive: 'chatMessages.isActive' },
}));

import * as dbModule from '@pagespace/db/db';
import { listAllConversationsPaginated } from '../agent-sessions-conversations-runtime';

// The real `@pagespace/db/db` module only exports `db`, typed as
// `NodePgDatabase<...>` (no `.limit()` of its own — only through a real query
// chain). The mock above replaces `db` wholesale with a plain chainable stub
// and adds its own `__queueResponse` export alongside it — untyped access is
// the only way to reach either from here.
const mockDb = dbModule as unknown as { db: { limit: ReturnType<typeof vi.fn> }; __queueResponse: (r: unknown[]) => void };
const queueResponse = (rows: unknown[]) => mockDb.__queueResponse(rows);

const GLOBAL_ROW = {
  conversationId: 'conv-1', title: 'Chat', type: 'global', contextId: null,
  lastMessageAt: new Date('2026-07-28'), createdAt: new Date('2026-07-27'),
  sessionId: null, sessionName: null, sessionEndedAt: null, pageTitle: null, driveId: null,
};
const PAGE_ROW = {
  conversationId: 'conv-2', title: null, type: 'page', contextId: 'agent-1',
  lastMessageAt: new Date('2026-07-26'), createdAt: new Date('2026-07-25'),
  sessionId: null, sessionName: null, sessionEndedAt: null, pageTitle: 'My Agent', driveId: 'drive-1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listAllConversationsPaginated', () => {
  it('derives agentPageId from contextId ONLY for type === "page"', async () => {
    queueResponse([GLOBAL_ROW, PAGE_ROW]);

    const result = await listAllConversationsPaginated({ ownerId: 'user-1' }, { limit: 20 });

    expect(result.conversations[0]).toMatchObject({ conversationId: 'conv-1', agentPageId: null });
    expect(result.conversations[1]).toMatchObject({ conversationId: 'conv-2', agentPageId: 'agent-1' });
  });

  it('passes every joined field through unchanged', async () => {
    queueResponse([PAGE_ROW]);

    const result = await listAllConversationsPaginated({ ownerId: 'user-1' });

    expect(result.conversations[0]).toEqual({
      conversationId: 'conv-2',
      title: null,
      type: 'page',
      agentPageId: 'agent-1',
      pageTitle: 'My Agent',
      lastMessageAt: PAGE_ROW.lastMessageAt,
      createdAt: PAGE_ROW.createdAt,
      sessionId: null,
      sessionName: null,
      sessionEndedAt: null,
      driveId: 'drive-1',
    });
  });

  describe('pagination math', () => {
    it('no cursor: fetches maxLimit + 1 rows in one query, no cursor lookup', async () => {
      queueResponse([GLOBAL_ROW]);

      const result = await listAllConversationsPaginated({ ownerId: 'user-1' }, { limit: 20 });

      expect(result.pagination).toEqual({ hasMore: false, nextCursor: null, limit: 20 });
      // Exactly one query ran (no separate cursor-lookup round trip).
      expect(mockDb.db.limit).toHaveBeenCalledTimes(1);
      expect(mockDb.db.limit).toHaveBeenCalledWith(21);
    });

    it('exactly maxLimit rows returned: hasMore is false, nextCursor is null', async () => {
      queueResponse(Array.from({ length: 20 }, (_, i) => ({ ...GLOBAL_ROW, conversationId: `conv-${i}` })));

      const result = await listAllConversationsPaginated({ ownerId: 'user-1' }, { limit: 20 });

      expect(result.conversations).toHaveLength(20);
      expect(result.pagination.hasMore).toBe(false);
      expect(result.pagination.nextCursor).toBeNull();
    });

    it('maxLimit + 1 rows returned: hasMore is true, the extra row is dropped, nextCursor is the LAST kept row', async () => {
      const rows = Array.from({ length: 21 }, (_, i) => ({ ...GLOBAL_ROW, conversationId: `conv-${i}` }));
      queueResponse(rows);

      const result = await listAllConversationsPaginated({ ownerId: 'user-1' }, { limit: 20 });

      expect(result.conversations).toHaveLength(20);
      expect(result.pagination.hasMore).toBe(true);
      expect(result.pagination.nextCursor).toBe('conv-19');
    });

    it('with a cursor: looks it up first (one extra round trip), then runs the main query', async () => {
      queueResponse([{ sortKey: new Date('2026-07-27'), id: 'conv-cursor' }]); // cursor lookup
      queueResponse([GLOBAL_ROW]); // main query

      const result = await listAllConversationsPaginated({ ownerId: 'user-1' }, { cursor: 'conv-cursor', limit: 20 });

      expect(mockDb.db.limit).toHaveBeenCalledTimes(2);
      expect(mockDb.db.limit).toHaveBeenNthCalledWith(1, 1); // cursor lookup: limit(1)
      expect(mockDb.db.limit).toHaveBeenNthCalledWith(2, 21); // main query: limit(maxLimit + 1)
      expect(result.conversations).toEqual([expect.objectContaining({ conversationId: 'conv-1' })]);
    });

    it('a cursor that resolves to nothing (deleted/foreign id) is silently ignored — not an error', async () => {
      queueResponse([]); // cursor lookup finds no row
      queueResponse([GLOBAL_ROW]); // main query still runs, unfiltered by cursor

      const result = await listAllConversationsPaginated({ ownerId: 'user-1' }, { cursor: 'conv-gone' });

      expect(result.conversations).toHaveLength(1);
    });

    it('clamps limit into [1, 100]', async () => {
      queueResponse([]);
      await listAllConversationsPaginated({ ownerId: 'user-1' }, { limit: 500 });
      expect(mockDb.db.limit).toHaveBeenCalledWith(101);

      vi.clearAllMocks();
      queueResponse([]);
      await listAllConversationsPaginated({ ownerId: 'user-1' }, { limit: -5 });
      expect(mockDb.db.limit).toHaveBeenCalledWith(2);
    });
  });
});

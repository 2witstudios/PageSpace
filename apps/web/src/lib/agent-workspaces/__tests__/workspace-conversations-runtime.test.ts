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
  // `.limit()` is the terminal method for the one query this module runs per
  // call (the cursor is decoded synchronously, not looked up in the DB — see
  // encodeCursor/decodeCursor) — a round-robin queue of canned responses,
  // consumed in call order, needs no per-query-shape branching.
  const responses: unknown[][] = [];
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    // A subquery ALIAS, not a terminal: the drive-scoped listing joins the
    // membership relation (`agent_workspace_nodes` narrowed to chat targets),
    // and building one is pure query construction that never touches the
    // queue. It returns a plain object rather than the chain so a stray
    // `.limit()` on an alias would blow up here instead of quietly eating a
    // canned response.
    as: vi.fn((name: string) => ({ __alias: name, targetId: {}, rootId: {} })),
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
  },
  messages: { conversationId: 'messages.conversationId', isActive: 'messages.isActive' },
}));
vi.mock('@pagespace/db/schema/agent-workspaces', () => ({
  agentWorkspaces: { id: 'agentWorkspaces.id', driveId: 'agentWorkspaces.driveId', name: 'agentWorkspaces.name', endedAt: 'agentWorkspaces.endedAt' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', title: 'pages.title', driveId: 'pages.driveId' },
}));

import * as dbModule from '@pagespace/db/db';
import { listAllConversationsPaginated } from '../workspace-conversations-runtime';
import { encodeCursor, decodeCursor } from '@/lib/conversations/conversation-recency';

// The real `@pagespace/db/db` module only exports `db`, typed as
// `NodePgDatabase<...>` (no `.limit()` of its own — only through a real query
// chain). The mock above replaces `db` wholesale with a plain chainable stub
// and adds its own `__queueResponse` export alongside it — untyped access is
// the only way to reach either from here.
const mockDb = dbModule as unknown as { db: { limit: ReturnType<typeof vi.fn> }; __queueResponse: (r: unknown[]) => void };
const queueResponse = (rows: unknown[]) => mockDb.__queueResponse(rows);

const GLOBAL_ROW = {
  conversationId: 'conv-1', title: 'Chat', type: 'global', contextId: null,
  lastMessageAt: new Date('2026-07-28'), sortKeyValue: new Date('2026-07-28'), createdAt: new Date('2026-07-27'),
  workspaceId: null, sessionName: null, sessionEndedAt: null, pageTitle: null, driveId: null,
};
const PAGE_ROW = {
  conversationId: 'conv-2', title: null, type: 'page', contextId: 'agent-1',
  lastMessageAt: new Date('2026-07-26'), sortKeyValue: new Date('2026-07-26'), createdAt: new Date('2026-07-25'),
  workspaceId: null, sessionName: null, sessionEndedAt: null, pageTitle: 'My Agent', driveId: 'drive-1',
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
      workspaceId: null,
      sessionName: null,
      sessionEndedAt: null,
      driveId: 'drive-1',
      // Server-only, and carried DELIBERATELY: the route paginates a second
      // time after permission filtering and mints its cursor from this, so it
      // has to survive the mapping. `toWireRow` is what strips it before the
      // response. Asserted with `toEqual` so a field added here has to be
      // stated rather than arriving unnoticed.
      sortKeyValue: PAGE_ROW.sortKeyValue,
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

    it('maxLimit + 1 rows returned: hasMore is true, the extra row is dropped, nextCursor encodes the LAST kept row', async () => {
      const rows = Array.from({ length: 21 }, (_, i) => ({ ...GLOBAL_ROW, conversationId: `conv-${i}` }));
      queueResponse(rows);

      const result = await listAllConversationsPaginated({ ownerId: 'user-1' }, { limit: 20 });

      expect(result.conversations).toHaveLength(20);
      expect(result.pagination.hasMore).toBe(true);
      expect(result.pagination.nextCursor).not.toBeNull();
      // A string, not the `Date` instance the fixture holds: `decodeCursor`
      // returns the sort key exactly as encoded, so a caller re-deriving a
      // `Date` from it (as this fixture's own `sortKeyValue` is) would
      // silently truncate any sub-millisecond precision right back out.
      expect(decodeCursor(result.pagination.nextCursor!)).toEqual({
        sortKey: GLOBAL_ROW.sortKeyValue.toISOString(),
        id: 'conv-19',
      });
    });

    it('with a cursor: decodes it synchronously (no extra DB round trip) and runs one query', async () => {
      const cursor = encodeCursor(new Date('2026-07-27'), 'conv-cursor');
      queueResponse([GLOBAL_ROW]); // the one and only query

      const result = await listAllConversationsPaginated({ ownerId: 'user-1' }, { cursor, limit: 20 });

      // Exactly one query ran — no separate cursor-lookup round trip against
      // LIVE data (review finding: re-deriving the boundary from mutable
      // chat_messages let a concurrent message shift it forward, re-admitting
      // already-shown rows, or — if the cursor row vanished — apply no
      // boundary at all).
      expect(mockDb.db.limit).toHaveBeenCalledTimes(1);
      expect(mockDb.db.limit).toHaveBeenCalledWith(21);
      expect(result.conversations).toEqual([expect.objectContaining({ conversationId: 'conv-1' })]);
    });

    it('a malformed/tampered cursor is silently ignored — not an error', async () => {
      queueResponse([GLOBAL_ROW]); // the query still runs, unfiltered by cursor

      const result = await listAllConversationsPaginated({ ownerId: 'user-1' }, { cursor: 'not-valid-base64url-json' });

      expect(mockDb.db.limit).toHaveBeenCalledTimes(1);
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

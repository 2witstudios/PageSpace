/**
 * Unit tests for conversationRepository.
 *
 * The repository is the seam where ORM/query-builder details are isolated.
 * These tests mock @pagespace/db/db to verify the seam delegates to Drizzle
 * with the correct shapes. Route/service tests mock the repository instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock chains
const mockSelectChain = vi.hoisted(() => ({
  from: vi.fn(),
}));

const mockInsertChain = vi.hoisted(() => ({
  values: vi.fn(),
}));

const mockUpdateChain = vi.hoisted(() => ({
  set: vi.fn(),
}));

const mockExecute = vi.hoisted(() => vi.fn());

// `tx` supports the identical `.select`/`.update`/etc. surface `db` does —
// the transaction mock invokes its callback with `db` itself, so a test's
// `mockDb.update = vi.fn()...` override applies transparently whether the
// real code runs its writes directly or inside `db.transaction(async (tx) => ...)`.
vi.mock('@pagespace/db/db', () => {
  const db = {
    select: vi.fn(() => mockSelectChain),
    insert: vi.fn(() => mockInsertChain),
    update: vi.fn(() => mockUpdateChain),
    execute: mockExecute,
    query: {
      pages: { findFirst: vi.fn() },
    },
    transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(db)),
  };
  return { db };
});

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ kind: 'eq', field, value })),
  and: vi.fn((...conds) => ({ kind: 'and', conds })),
  inArray: vi.fn((field, values) => ({ kind: 'inArray', field, values })),
  isNull: vi.fn((field) => ({ kind: 'isNull', field })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      kind: 'sql',
      strings,
      values,
    })),
    { as: vi.fn() }
  ),
}));

vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: {
    id: 'conversations.id',
    userId: 'conversations.userId',
    isShared: 'conversations.isShared',
    title: 'conversations.title',
    updatedAt: 'conversations.updatedAt',
  },
  // The unified leg of the dual-write (Phase 4 PR 10): the History soft-delete
  // now tombstones a conversation's rows in BOTH message tables, in the same
  // transaction, so a post-cutover reader cannot resurrect deleted messages.
  messages: {
    id: 'messages.id',
    conversationId: 'messages.conversationId',
    isActive: 'messages.isActive',
  },
}));

vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: {
    id: 'chatMessages.id',
    pageId: 'chatMessages.pageId',
    conversationId: 'chatMessages.conversationId',
    isActive: 'chatMessages.isActive',
  },
  pages: { id: 'pages.id', type: 'pages.type', isTrashed: 'pages.isTrashed' },
}));

vi.mock('@pagespace/db/schema/monitoring', () => ({
  userActivities: { userId: 'userActivities.userId' },
}));

const mockInvalidateCompaction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ai/core/compaction/compaction-repository', () => ({
  invalidate: (...args: unknown[]) => mockInvalidateCompaction(...args),
}));

import { conversationRepository } from '../conversation-repository';
import { db } from '@pagespace/db/db';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('conversationRepository.getConversation', () => {
  it('should return the conversations row when found', async () => {
    const mockRow = {
      id: 'conv_abc',
      userId: 'user_123',
      isShared: false,
      type: 'page',
      contextId: 'agent_456',
      title: null,
      isActive: true,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-02'),
    };

    const whereMock = vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue([mockRow]),
    });
    mockSelectChain.from.mockReturnValue({ where: whereMock });

    const result = await conversationRepository.getConversation('conv_abc');

    expect(result).toEqual(mockRow);
  });

  it('should return null when conversation row does not exist', async () => {
    const whereMock = vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue([]),
    });
    mockSelectChain.from.mockReturnValue({ where: whereMock });

    const result = await conversationRepository.getConversation('conv_missing');

    expect(result).toBeNull();
  });
});

describe('conversationRepository.getAiAgent', () => {
  // vi.mocked(db) does not see through Drizzle's query-builder generics.
  const findFirstMock = () =>
    mockDb.query.pages.findFirst as unknown as ReturnType<typeof vi.fn>;

  // The MACHINE widening (#2166 Phase 11) is REVERTED: agent sessions anchor
  // to the conversation itself, so AI_CHAT pages are the only conversation
  // hosts again.
  it('queries for conversation-hosting page types: AI_CHAT only', async () => {
    findFirstMock().mockResolvedValue({
      id: 'agent_1',
      title: 'Research Agent',
      type: 'AI_CHAT',
      driveId: 'drive_1',
    });

    const result = await conversationRepository.getAiAgent('agent_1');

    expect(result).toEqual(
      expect.objectContaining({ id: 'agent_1', type: 'AI_CHAT' }),
    );
    const call = findFirstMock().mock.calls[0][0] as { where: { conds: unknown[] } };
    expect(call.where.conds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'inArray', values: ['AI_CHAT'] }),
      ]),
    );
  });

  it('returns null when the page does not exist', async () => {
    findFirstMock().mockResolvedValue(undefined);

    expect(await conversationRepository.getAiAgent('missing')).toBeNull();
  });
});

describe('conversationRepository.createConversation', () => {
  // #1846 Codex P2: a caller-supplied conversationId must not be able to
  // claim ownership of a pre-existing conversation (real chat_messages, no
  // conversations row yet) authored by a different user. Two DB round trips:
  // (1) does a conversations row already exist? (2) if not, does any prior
  // message in this conversation belong to someone else?
  function mockConversationsLookup(existing: Array<{ id: string }>) {
    const limitMock = vi.fn().mockResolvedValue(existing);
    return { where: vi.fn().mockReturnValue({ limit: limitMock }) };
  }
  function mockChatMessagesLookup(rows: Array<{ userId: string | null }>) {
    return { where: vi.fn().mockResolvedValue(rows) };
  }
  // The INSERT chain is values → onConflictDoNothing → returning. `rows` is
  // what RETURNING yields: [{id}] = this call won the insert, [] = a
  // concurrent writer beat it (conflict swallowed the insert).
  function mockInsert(rows: Array<{ id: string }>) {
    const returning = vi.fn().mockResolvedValue(rows);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoNothing });
    mockDb.insert = vi.fn().mockReturnValue({ values: valuesMock });
    return { valuesMock, onConflictDoNothing, returning };
  }

  it("reports 'exists' when a conversations row already exists (cheap indexed short-circuit)", async () => {
    let call = 0;
    mockSelectChain.from.mockImplementation(() => {
      call += 1;
      return mockConversationsLookup([{ id: 'conv-a' }]);
    });

    const outcome = await conversationRepository.createConversation('conv-a', 'user-1', 'agent-1');

    expect(outcome).toBe('exists');
    expect(call).toBe(1); // only the conversations lookup — never touches chat_messages or inserts
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('creates the row when no conversations row exists and no prior message conflicts', async () => {
    mockSelectChain.from
      .mockImplementationOnce(() => mockConversationsLookup([]))
      .mockImplementationOnce(() => mockChatMessagesLookup([]));
    const { valuesMock, onConflictDoNothing } = mockInsert([{ id: 'conv-new' }]);

    const outcome = await conversationRepository.createConversation('conv-new', 'user-1', 'agent-1');

    expect(outcome).toBe('created');
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-new', userId: 'user-1', contextId: 'agent-1', isShared: false })
    );
    expect(onConflictDoNothing).toHaveBeenCalled();
  });

  it('carries title inside the INSERT (sessionId is never a param here — binding is claimed separately, never at creation)', async () => {
    mockSelectChain.from
      .mockImplementationOnce(() => mockConversationsLookup([]))
      .mockImplementationOnce(() => mockChatMessagesLookup([]));
    const { valuesMock } = mockInsert([{ id: 'conv-bound' }]);

    const outcome = await conversationRepository.createConversation('conv-bound', 'user-1', 'agent-1', {
      title: 'Worker: research',
    });

    expect(outcome).toBe('created');
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-bound', sessionId: null, title: 'Worker: research' })
    );
  });

  it('defaults title to null when opts omit it, always inserting sessionId: null', async () => {
    mockSelectChain.from
      .mockImplementationOnce(() => mockConversationsLookup([]))
      .mockImplementationOnce(() => mockChatMessagesLookup([]));
    const { valuesMock } = mockInsert([{ id: 'conv-unbound' }]);

    await conversationRepository.createConversation('conv-unbound', 'user-1', 'agent-1');

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-unbound', sessionId: null, title: null })
    );
  });

  it("reports 'exists' when RETURNING yields no row — a concurrent first-write won and this caller's insert did NOT persist", async () => {
    mockSelectChain.from
      .mockImplementationOnce(() => mockConversationsLookup([]))
      .mockImplementationOnce(() => mockChatMessagesLookup([]));
    mockInsert([]);

    const outcome = await conversationRepository.createConversation('conv-race', 'user-1', 'agent-1');

    expect(outcome).toBe('exists');
  });

  it("reports 'message_owner_conflict' (no insert) when an existing message belongs to a different user (Codex P2)", async () => {
    mockSelectChain.from
      .mockImplementationOnce(() => mockConversationsLookup([]))
      .mockImplementationOnce(() => mockChatMessagesLookup([
        { userId: 'victim-user' },
        { userId: null },
      ]));

    const outcome = await conversationRepository.createConversation('conv-legacy', 'attacker-user', 'agent-1');

    expect(outcome).toBe('message_owner_conflict');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  // THE SQUAT. The ownership guard used to be scoped to the caller's page — which is the one
  // page an attacker would simply not stand on:
  //
  //   1. Victim has a legacy conversation C (real messages under page X, no conversations row).
  //   2. Attacker, on their OWN page Y, sends with conversationId=C. Scoped to page Y the guard
  //      saw nothing, so the row was INSERTED with the ATTACKER as owner.
  //   3. The victim's next send on page X finds a row it does not own and that is not shared:
  //      403, PERMANENTLY. Locked out of their own history, and deletion now trusts the
  //      attacker's userId.
  //
  // "Who owns this conversation" is not a per-page question. The predicate must not mention the
  // page at all — asserted here on the WHERE clause itself, because mocking the row lookup (as
  // the tests above do) cannot see the scoping bug that let the wrong rows through.
  it('asks who owns the conversation ACROSS ALL PAGES — a page-scoped guard let an attacker squat it from outside', async () => {
    const messagesWhere = vi.fn().mockResolvedValue([]);
    mockSelectChain.from
      .mockImplementationOnce(() => mockConversationsLookup([]))
      .mockImplementationOnce(() => ({ where: messagesWhere }));
    mockInsert([{ id: 'conv-victim' }]);

    await conversationRepository.createConversation('conv-victim', 'attacker-user', 'attacker-page');

    // Reads the UNIFIED `messages` table since the message-table merge (epic
    // "Agent-Session Single Source of Truth", Phase 4 / D6, PR 12). The
    // property under test is unchanged and is the whole point of this case:
    // the predicate must name the conversation and nothing about the page.
    const predicate = messagesWhere.mock.calls[0][0] as { kind: string; conds: Array<{ field?: string }> };
    const fields = predicate.conds.map((c) => c.field);
    expect(fields).toContain('messages.conversationId');
    expect(fields).toContain('messages.isActive');
    // The page must NOT narrow it — that narrowing IS the vulnerability.
    expect(fields).not.toContain('messages.pageId');
    expect(fields).not.toContain('chatMessages.pageId');
  });

  it('creates the row when prior messages exist but all belong to the caller', async () => {
    mockSelectChain.from
      .mockImplementationOnce(() => mockConversationsLookup([]))
      .mockImplementationOnce(() => mockChatMessagesLookup([
        { userId: 'user-1' },
        { userId: null },
      ]));
    const { valuesMock } = mockInsert([{ id: 'conv-mine' }]);

    const outcome = await conversationRepository.createConversation('conv-mine', 'user-1', 'agent-1');

    expect(outcome).toBe('created');
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-mine', userId: 'user-1' })
    );
  });

  it('given { isShared: true }, persists a shared row, keeping the squat-guard + onConflictDoNothing', async () => {
    mockSelectChain.from
      .mockImplementationOnce(() => mockConversationsLookup([]))
      .mockImplementationOnce(() => mockChatMessagesLookup([]));
    const { valuesMock, onConflictDoNothing } = mockInsert([{ id: 'conv-shared' }]);

    await conversationRepository.createConversation('conv-shared', 'user-1', 'machine-1', { isShared: true });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-shared', userId: 'user-1', contextId: 'machine-1', isShared: true })
    );
    expect(onConflictDoNothing).toHaveBeenCalled();
  });

  it('given no opts (or isShared omitted), still defaults to isShared: false', async () => {
    mockSelectChain.from
      .mockImplementationOnce(() => mockConversationsLookup([]))
      .mockImplementationOnce(() => mockChatMessagesLookup([]));
    const { valuesMock } = mockInsert([{ id: 'conv-default' }]);

    await conversationRepository.createConversation('conv-default', 'user-1', 'agent-1', {});

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-default', isShared: false })
    );
  });

  it('given { isShared: true }, still refuses a conversationId owned by a different user (squat-guard applies regardless of isShared)', async () => {
    mockSelectChain.from
      .mockImplementationOnce(() => mockConversationsLookup([]))
      .mockImplementationOnce(() => mockChatMessagesLookup([{ userId: 'victim-user' }]));

    await conversationRepository.createConversation('conv-legacy', 'attacker-user', 'machine-1', { isShared: true });

    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

describe('conversationRepository.autoTitleConversation', () => {
  // The IS-NULL guard lives in the SQL WHERE clause, not an in-memory check —
  // that's what makes this safe to call on every message without a separate
  // "is this the first message" lookup, and race-safe under concurrent calls.
  it('updates title guarded by "title IS NULL" in the WHERE clause', async () => {
    const returningMock = vi.fn().mockResolvedValue([{ id: 'conv_abc', userId: 'owner-1', isShared: false, sessionId: null, type: 'page', contextId: 'agent_1', title: null, lastMessageAt: null, createdAt: new Date('2025-01-01'), closedInSessionAt: null, isActive: true, rev: 1 }]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    mockDb.update = vi.fn().mockReturnValue({ set: setMock });

    await conversationRepository.autoTitleConversation('conv_abc', 'Summarize this doc');

    expect(mockDb.update).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Summarize this doc' }));
    const predicate = whereMock.mock.calls[0][0] as { kind: string; conds: Array<{ kind: string; field?: string }> };
    const idCond = predicate.conds.find((c) => c.field === 'conversations.id');
    const nullTitleCond = predicate.conds.find((c) => c.kind === 'isNull');
    expect(idCond).toBeDefined();
    expect(nullTitleCond).toEqual({ kind: 'isNull', field: 'conversations.title' });
  });

  it('never overwrites an existing title — the guard is baked into every UPDATE\'s WHERE clause, not an in-memory check', async () => {
    // A row with a non-null title simply matches zero rows against the
    // "title IS NULL" predicate. There is no in-memory "if title" branch
    // for a race to slip through — the second of two concurrent calls
    // still issues the same guarded UPDATE and updates zero rows.
    const returningMock = vi.fn().mockResolvedValue([]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    mockDb.update = vi.fn().mockReturnValue({ set: setMock });

    await conversationRepository.autoTitleConversation('conv_titled', 'New attempted title');

    const predicate = whereMock.mock.calls[0][0] as { kind: string; conds: Array<{ kind: string; field?: string }> };
    const nullTitleCond = predicate.conds.find((c) => c.kind === 'isNull');
    expect(nullTitleCond).toEqual({ kind: 'isNull', field: 'conversations.title' });
  });
});

describe('conversationRepository.setConversationShared', () => {
  it('should update isShared to true for a conversation', async () => {
    const returningMock = vi.fn().mockResolvedValue([{ id: 'conv_abc', userId: 'owner-1', isShared: false, sessionId: null, type: 'page', contextId: 'agent_1', title: null, lastMessageAt: null, createdAt: new Date('2025-01-01'), closedInSessionAt: null, isActive: true, rev: 1 }]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    mockUpdateChain.set.mockReturnValue({ where: whereMock });
    mockDb.update = vi.fn().mockReturnValue({ set: setMock });

    await conversationRepository.setConversationShared('conv_abc', true);

    expect(mockDb.update).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ isShared: true })
    );
  });

  it('should update isShared to false for a conversation', async () => {
    const returningMock = vi.fn().mockResolvedValue([{ id: 'conv_abc', userId: 'owner-1', isShared: false, sessionId: null, type: 'page', contextId: 'agent_1', title: null, lastMessageAt: null, createdAt: new Date('2025-01-01'), closedInSessionAt: null, isActive: true, rev: 1 }]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    mockDb.update = vi.fn().mockReturnValue({ set: setMock });

    await conversationRepository.setConversationShared('conv_abc', false);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ isShared: false })
    );
  });
});

describe('conversationRepository.softDeleteConversation', () => {
  it("deactivates the canonical conversations row, not just its messages — review finding (chatgpt-codex-connector on PR #2296): every reader gating on conversations.isActive (session listings/caps, the v1/MCP API, retention purge) previously kept treating a page conversation deleted from History as live forever", async () => {
    const returningMock = vi.fn().mockResolvedValue([{ id: 'conv_abc', userId: 'owner-1', isShared: false, sessionId: null, type: 'page', contextId: 'agent_1', title: null, lastMessageAt: null, createdAt: new Date('2025-01-01'), closedInSessionAt: null, isActive: true, rev: 1 }]);
    const whereMock = vi.fn(() =>
      Object.assign(Promise.resolve(undefined), { returning: returningMock }),
    );
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    mockDb.update = vi.fn().mockReturnValue({ set: setMock });

    await conversationRepository.softDeleteConversation('agent_1', 'conv_deleted');

    // Both UPDATEs run inside ONE transaction — a partial failure between
    // them must never leave messages inactive but the row still active, or
    // vice versa (a second review finding on the same fix: chatgpt-codex-
    // connector on PR #2296).
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    // Two UPDATEs: conversations FIRST, then the message sweep — the
    // canonical row is locked before the sweep, or a concurrent send's own
    // FOR UPDATE re-check (apps/web/src/app/api/ai/chat/route.ts) could
    // acquire that lock in the window between them, observe isActive: true,
    // and commit a new active message a moment before this transaction
    // tombstones the conversation (review finding — chatgpt-codex-connector on
    // PR #2299, filed after the original messages-then-conversations order
    // shipped on PR #2296). Verified via the table argument each db.update()
    // call received.
    //
    // The count has tracked the merge: two before PR 10, THREE during the
    // dual-write, and two again now that Phase 4 PR 14 has frozen
    // `chat_messages`. A `chatMessages` table argument reappearing in this
    // list is a resurrected legacy writer.
    expect(mockDb.update).toHaveBeenCalledTimes(2);
    expect(mockDb.update).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'conversations.id' }));
    expect(mockDb.update).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'messages.id' }));
    expect(mockDb.update).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'chatMessages.id' }));
    expect(setMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ isActive: false }));
    expect(setMock).toHaveBeenNthCalledWith(2, { isActive: false });
    expect(mockInvalidateCompaction).toHaveBeenCalledWith('conv_deleted', { source: 'page', pageId: 'agent_1' });
  });

  it('does not touch conversations.isActive at all if the message sweep throws — the transaction rolls back atomically', async () => {
    const returningMock = vi.fn().mockResolvedValue([{ id: 'conv_abc', userId: 'owner-1', isShared: false, sessionId: null, type: 'page', contextId: 'agent_1', title: null, lastMessageAt: null, createdAt: new Date('2025-01-01'), closedInSessionAt: null, isActive: true, rev: 1 }]);
    const whereMock = vi
      .fn()
      // First statement: the conversations tombstone (ends `.returning()`).
      .mockImplementationOnce(() => ({ returning: returningMock }))
      // Second statement: the message sweep, through the shared page writer —
      // it ends in `.returning()`, which is what throws here.
      .mockImplementationOnce(() => ({
        returning: () => Promise.reject(new Error('db exploded')),
      }));
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    mockDb.update = vi.fn().mockReturnValue({ set: setMock });

    await expect(conversationRepository.softDeleteConversation('agent_1', 'conv_deleted')).rejects.toThrow(
      'db exploded',
    );

    // Both statements were issued in-transaction; the throw aborts the
    // transaction, so nothing after the sweep (emission, compaction
    // invalidation) runs — matching real transaction semantics.
    expect(mockDb.update).toHaveBeenCalledTimes(2);
    expect(mockInvalidateCompaction).not.toHaveBeenCalled();
  });
});

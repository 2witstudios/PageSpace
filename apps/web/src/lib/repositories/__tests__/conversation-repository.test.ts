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

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => mockSelectChain),
    insert: vi.fn(() => mockInsertChain),
    update: vi.fn(() => mockUpdateChain),
    execute: mockExecute,
    query: {
      pages: { findFirst: vi.fn() },
    },
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ kind: 'eq', field, value })),
  and: vi.fn((...conds) => ({ kind: 'and', conds })),
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
    updatedAt: 'conversations.updatedAt',
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

  it('does nothing when a conversations row already exists (cheap indexed short-circuit)', async () => {
    let call = 0;
    mockSelectChain.from.mockImplementation(() => {
      call += 1;
      return mockConversationsLookup([{ id: 'conv-a' }]);
    });

    await conversationRepository.createConversation('conv-a', 'user-1', 'agent-1');

    expect(call).toBe(1); // only the conversations lookup — never touches chat_messages or inserts
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('creates the row when no conversations row exists and no prior message conflicts', async () => {
    mockSelectChain.from
      .mockImplementationOnce(() => mockConversationsLookup([]))
      .mockImplementationOnce(() => mockChatMessagesLookup([]));
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoNothing });
    mockDb.insert = vi.fn().mockReturnValue({ values: valuesMock });

    await conversationRepository.createConversation('conv-new', 'user-1', 'agent-1');

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-new', userId: 'user-1', contextId: 'agent-1', isShared: false })
    );
    expect(onConflictDoNothing).toHaveBeenCalled();
  });

  it('does NOT create the row when an existing message in this conversation belongs to a different user (Codex P2)', async () => {
    mockSelectChain.from
      .mockImplementationOnce(() => mockConversationsLookup([]))
      .mockImplementationOnce(() => mockChatMessagesLookup([
        { userId: 'victim-user' },
        { userId: null },
      ]));

    await conversationRepository.createConversation('conv-legacy', 'attacker-user', 'agent-1');

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
    const chatMessagesWhere = vi.fn().mockResolvedValue([]);
    mockSelectChain.from
      .mockImplementationOnce(() => mockConversationsLookup([]))
      .mockImplementationOnce(() => ({ where: chatMessagesWhere }));
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }),
    });

    await conversationRepository.createConversation('conv-victim', 'attacker-user', 'attacker-page');

    const predicate = chatMessagesWhere.mock.calls[0][0] as { kind: string; conds: Array<{ field?: string }> };
    const fields = predicate.conds.map((c) => c.field);
    expect(fields).toContain('chatMessages.conversationId');
    expect(fields).toContain('chatMessages.isActive');
    // The page must NOT narrow it — that narrowing IS the vulnerability.
    expect(fields).not.toContain('chatMessages.pageId');
  });

  it('creates the row when prior messages exist but all belong to the caller', async () => {
    mockSelectChain.from
      .mockImplementationOnce(() => mockConversationsLookup([]))
      .mockImplementationOnce(() => mockChatMessagesLookup([
        { userId: 'user-1' },
        { userId: null },
      ]));
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const valuesMock = vi.fn().mockReturnValue({ onConflictDoNothing });
    mockDb.insert = vi.fn().mockReturnValue({ values: valuesMock });

    await conversationRepository.createConversation('conv-mine', 'user-1', 'agent-1');

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-mine', userId: 'user-1' })
    );
  });
});

describe('conversationRepository.setConversationShared', () => {
  it('should update isShared to true for a conversation', async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
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
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    mockDb.update = vi.fn().mockReturnValue({ set: setMock });

    await conversationRepository.setConversationShared('conv_abc', false);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ isShared: false })
    );
  });
});

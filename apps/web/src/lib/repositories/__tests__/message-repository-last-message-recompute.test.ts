/**
 * Issue #2153 — `conversations.lastMessageAt` is derived from the surviving
 * active messages. Every mutation that can remove the newest message (purge,
 * and the delete paths that route through the repository) must recompute it
 * via the one shared writer, `recomputeLastMessageAt`, instead of leaving the
 * timestamp pointing at a message that no longer exists.
 *
 * MOVED from `global-conversation-last-message-recompute.test.ts` with the
 * code it pins: the message-table merge (epic "Agent-Session Single Source of
 * Truth", Phase 4 / D6, PR 12) made `messages` the one message table, so the
 * recompute and the purge moved from `global-conversation-repository.ts` into
 * `message-repository.ts` — and they now cover PAGE conversations too, which
 * had no recompute at all while they lived in `chat_messages`.
 *
 * The dead members that used to be pinned here (`softDeleteMessage`,
 * `hardDeleteMessage` — no non-test caller since the repository choke point
 * landed) were deleted rather than carried across.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockSelectLimit,
  mockSelectFor,
  mockUpdateSet,
  mockUpdateWhere,
  mockDeleteReturning,
  mockUpdateReturning,
  mockTransaction,
  mockLoggerWarn,
} = vi.hoisted(() => ({
  mockSelectLimit: vi.fn(),
  // The conversation-row lock (`.for('update')`) recomputeLastMessageAt takes
  // before reading the surviving messages (#2153).
  mockSelectFor: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockDeleteReturning: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockTransaction: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => {
  // A single chain shape serves both the lock select (`.for('update')`) and
  // the newest-message select (`.orderBy().limit()`) — each call site uses
  // only the branch it needs.
  const dbShape = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          for: mockSelectFor,
          orderBy: vi.fn().mockReturnValue({ limit: mockSelectLimit }),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({ set: mockUpdateSet }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: mockDeleteReturning }),
    }),
    transaction: mockTransaction,
  };
  mockTransaction.mockImplementation((cb: (tx: typeof dbShape) => unknown) => cb(dbShape));
  return { db: dbShape };
});

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
  and: vi.fn((...conditions) => ({ type: 'and', conditions })),
  or: vi.fn((...conditions) => ({ type: 'or', conditions })),
  ne: vi.fn((field, value) => ({ type: 'ne', field, value })),
  desc: vi.fn((field) => ({ type: 'desc', field })),
  lt: vi.fn((field, value) => ({ type: 'lt', field, value })),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

vi.mock('@pagespace/db/schema/core', () => ({
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'users.id', name: 'users.name', image: 'users.image' } }));
vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: {
    id: 'conversations.id',
    type: 'conversations.type',
    contextId: 'conversations.contextId',
    lastMessageAt: 'conversations.lastMessageAt',
  },
  messages: {
    id: 'messages.id',
    conversationId: 'messages.conversationId',
    isActive: 'messages.isActive',
    createdAt: 'messages.createdAt',
  },
}));

vi.mock('@pagespace/lib/encryption/field-crypto', () => ({ decryptField: vi.fn(async (v) => v) }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: { warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn(), info: vi.fn() },
    api: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('@pagespace/lib/ai/global-channel-id', () => ({ globalChannelId: (id: string) => `user:${id}:global` }));
vi.mock('@/lib/channels/notify-mentioned-users', () => ({ notifyMentionedUsers: vi.fn() }));
vi.mock('@/lib/ai/core/message-utils', () => ({
  extractStructuredContentFromParts: vi.fn(async (_parts: unknown, content: string) => content),
  convertDbMessageToUIMessage: vi.fn(async () => ({ id: 'm', role: 'assistant', parts: [] })),
  MessageConversationConflictError: class extends Error {},
}));
vi.mock('@/lib/websocket/conversation-events', () => ({
  SERVER_TRIGGERED_BROWSER_SESSION: 'server',
  conversationEvents: {
    messageCreated: vi.fn().mockResolvedValue(undefined),
    messageUpdated: vi.fn().mockResolvedValue(undefined),
    messageDeleted: vi.fn().mockResolvedValue(undefined),
    undoApplied: vi.fn().mockResolvedValue(undefined),
    created: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastAiMessageEdited: vi.fn().mockResolvedValue(undefined),
  broadcastAiMessageDeleted: vi.fn().mockResolvedValue(undefined),
  broadcastAiUndoApplied: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/repositories/conversation-rev', () => ({
  bumpConversationRev: vi.fn().mockResolvedValue(null),
  emitContextFromRow: vi.fn(),
}));
vi.mock('@/lib/repositories/unified-message-leg', () => ({
  upsertUnifiedPageMessage: vi.fn(),
  insertUnifiedPageMessage: vi.fn(),
  materializeUnifiedPageMessage: vi.fn(),
  mutateUnifiedMessageById: vi.fn(),
  serializeJsonColumn: vi.fn(() => null),
}));

import { messageRepository } from '../message-repository';

interface AssertParams {
  given: string;
  should: string;
  actual: unknown;
  expected: unknown;
}

const assert = ({ given, should, actual, expected }: AssertParams): void => {
  expect(actual, `Given ${given}, should ${should}`).toEqual(expected);
};

const NEWEST = new Date('2026-07-10T10:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectLimit.mockResolvedValue([]);
  mockSelectFor.mockResolvedValue([]);
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockImplementation(() => {
    const result = Promise.resolve([]);
    return Object.assign(result, { returning: mockUpdateReturning });
  });
  mockUpdateReturning.mockResolvedValue([]);
  mockDeleteReturning.mockResolvedValue([]);
  mockLoggerWarn.mockReset();
});

describe('messageRepository.recomputeLastMessageAt', () => {
  it('sets lastMessageAt from the newest surviving active message', async () => {
    mockSelectLimit.mockResolvedValue([{ createdAt: NEWEST }]);

    await messageRepository.recomputeLastMessageAt('conv-1');

    const setArg = mockUpdateSet.mock.calls[0]?.[0];
    assert({
      given: 'a conversation with a surviving active message',
      should: 'write that message createdAt as lastMessageAt',
      actual: setArg?.lastMessageAt,
      expected: NEWEST,
    });
  });

  it('nulls lastMessageAt when no active message survives', async () => {
    mockSelectLimit.mockResolvedValue([]);

    await messageRepository.recomputeLastMessageAt('conv-1');

    const setArg = mockUpdateSet.mock.calls[0]?.[0];
    assert({
      given: 'a conversation whose messages are all deleted',
      should: 'null out lastMessageAt instead of leaving it pointing at a deleted message',
      actual: { called: mockUpdateSet.mock.calls.length > 0, lastMessageAt: setArg?.lastMessageAt },
      expected: { called: true, lastMessageAt: null },
    });
  });

  it('locks the conversation row (SELECT ... FOR UPDATE) inside its own transaction before reading the surviving messages (#2153)', async () => {
    mockSelectLimit.mockResolvedValue([{ createdAt: NEWEST }]);

    await messageRepository.recomputeLastMessageAt('conv-1');

    assert({
      given: 'a lastMessageAt recompute',
      should: 'take the conversation-row lock exactly once, inside a transaction, before writing — closing the race where a concurrent save or another recompute commits between this read and this write',
      actual: {
        forUpdateCalls: mockSelectFor.mock.calls.length,
        ranInTransaction: mockTransaction.mock.calls.length > 0,
      },
      expected: { forUpdateCalls: 1, ranInTransaction: true },
    });
  });
});

describe('messageRepository.purgeInactiveMessages', () => {
  it('recomputes each affected conversation exactly once and returns the true purge count', async () => {
    mockDeleteReturning.mockResolvedValue([
      { id: 'm1', conversationId: 'conv-a' },
      { id: 'm2', conversationId: 'conv-a' },
      { id: 'm3', conversationId: 'conv-b' },
    ]);
    mockSelectLimit.mockResolvedValue([]);

    const purged = await messageRepository.purgeInactiveMessages(new Date('2026-01-01T00:00:00Z'));

    assert({
      given: 'a purge removing tombstones across two conversations',
      should: 'recompute lastMessageAt once per distinct conversation',
      actual: { purged, updates: mockUpdateSet.mock.calls.length },
      expected: { purged: 3, updates: 2 },
    });
  });

  it('returns 0 when nothing matches, and recomputes nothing', async () => {
    mockDeleteReturning.mockResolvedValue([]);

    const purged = await messageRepository.purgeInactiveMessages(new Date('2026-01-01T00:00:00Z'));

    assert({
      given: 'a purge that matched no tombstones',
      should: 'report zero and leave every conversation timestamp alone',
      actual: { purged, updates: mockUpdateSet.mock.calls.length },
      expected: { purged: 0, updates: 0 },
    });
  });

  it('keeps recomputing later conversations after one recompute fails, and still returns the full purge count', async () => {
    mockDeleteReturning.mockResolvedValueOnce([
      { id: 'm1', conversationId: 'conv-a' },
      { id: 'm2', conversationId: 'conv-b' },
    ]);
    // The delete itself runs OUTSIDE a transaction, so the first transaction
    // call is the first recompute.
    mockTransaction
      .mockImplementationOnce(() => {
        throw new Error('lock timeout');
      })
      .mockImplementationOnce((cb: (tx: unknown) => unknown) =>
        cb({
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                for: mockSelectFor,
                orderBy: vi.fn().mockReturnValue({ limit: mockSelectLimit }),
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({ set: mockUpdateSet }),
        })
      );

    const purged = await messageRepository.purgeInactiveMessages(new Date('2026-01-01T00:00:00Z'));

    assert({
      given: 'a purge across two conversations where the first recompute throws',
      should: 'still recompute the second conversation, still report the true purge count, and log exactly one warning',
      actual: { purged, warnCalls: mockLoggerWarn.mock.calls.length, updates: mockUpdateSet.mock.calls.length },
      expected: { purged: 2, warnCalls: 1, updates: 1 },
    });
  });
});


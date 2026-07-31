/**
 * Issue #2153 — conversations.lastMessageAt is derived from the surviving
 * active messages. Every mutation that can remove the newest message
 * (soft-delete, hard-delete, purge) must recompute it via the one shared
 * writer, `recomputeLastMessageAt`, instead of leaving the timestamp
 * pointing at a message that no longer exists.
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
  // The conversation-row lock (`.for('update')`) recomputeLastMessageAt now
  // takes before reading the surviving messages (#2153) — see the
  // concurrency-safety tests below.
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
    // recomputeLastMessageAt now runs its lock+read+write inside its own
    // transaction (#2153) — the mock just invokes the callback with the
    // same shape, since none of these tests need real transactional
    // isolation, only to observe the calls made through `tx`.
    transaction: mockTransaction,
  };
  mockTransaction.mockImplementation((cb: (tx: typeof dbShape) => unknown) => cb(dbShape));
  return { db: dbShape };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
  and: vi.fn((...conditions) => ({ type: 'and', conditions })),
  desc: vi.fn((field) => ({ type: 'desc', field })),
  sql: vi.fn(),
  lt: vi.fn((field, value) => ({ type: 'lt', field, value })),
  exists: vi.fn((sub) => ({ type: 'exists', sub })),
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({ aiUsageLogs: {} }));
vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: { id: 'conversations.id', lastMessageAt: 'conversations.lastMessageAt' },
  messages: {
    id: 'messages.id',
    conversationId: 'messages.conversationId',
    isActive: 'messages.isActive',
    createdAt: 'messages.createdAt',
  },
}));
vi.mock('@/lib/ai/core/compaction/compaction-repository', () => ({
  invalidate: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { warn: mockLoggerWarn } },
}));

import { globalConversationRepository } from '../global-conversation-repository';

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
  mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
  // Awaiting the update chain without .returning() must also work.
  mockUpdateWhere.mockImplementation(() => {
    const result = Promise.resolve([]);
    return Object.assign(result, { returning: mockUpdateReturning });
  });
  mockUpdateReturning.mockResolvedValue([]);
  mockDeleteReturning.mockResolvedValue([]);
  mockLoggerWarn.mockReset();
});

describe('globalConversationRepository.recomputeLastMessageAt', () => {
  it('sets lastMessageAt from the newest surviving active message', async () => {
    mockSelectLimit.mockResolvedValue([{ createdAt: NEWEST }]);

    await globalConversationRepository.recomputeLastMessageAt('conv-1');

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

    await globalConversationRepository.recomputeLastMessageAt('conv-1');

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

    await globalConversationRepository.recomputeLastMessageAt('conv-1');

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

describe('globalConversationRepository message deletions recompute lastMessageAt (#2153)', () => {
  it('softDeleteMessage recomputes the owning conversation after tombstoning', async () => {
    mockUpdateReturning.mockResolvedValue([{ conversationId: 'conv-9' }]);
    mockSelectLimit.mockResolvedValue([{ createdAt: NEWEST }]);

    await globalConversationRepository.softDeleteMessage('msg-1');

    const lastSet = mockUpdateSet.mock.calls.at(-1)?.[0];
    assert({
      given: 'a soft-delete of a global conversation message',
      should: 'follow up with a conversations.lastMessageAt recompute from the surviving rows',
      actual: { updates: mockUpdateSet.mock.calls.length, lastMessageAt: lastSet?.lastMessageAt },
      expected: { updates: 2, lastMessageAt: NEWEST },
    });
  });

  it('hardDeleteMessage recomputes the owning conversation after removal', async () => {
    mockDeleteReturning.mockResolvedValue([{ conversationId: 'conv-9' }]);
    mockSelectLimit.mockResolvedValue([]);

    await globalConversationRepository.hardDeleteMessage('msg-1');

    const lastSet = mockUpdateSet.mock.calls.at(-1)?.[0];
    assert({
      given: 'a hard-delete of a global conversation message',
      should: 'recompute lastMessageAt (nulled here — nothing survives)',
      actual: { updates: mockUpdateSet.mock.calls.length, lastMessageAt: lastSet?.lastMessageAt },
      expected: { updates: 1, lastMessageAt: null },
    });
  });

  it('purgeInactiveMessages recomputes each affected conversation exactly once', async () => {
    mockDeleteReturning.mockResolvedValue([
      { id: 'm1', conversationId: 'conv-a' },
      { id: 'm2', conversationId: 'conv-a' },
      { id: 'm3', conversationId: 'conv-b' },
    ]);
    mockSelectLimit.mockResolvedValue([]);

    const purged = await globalConversationRepository.purgeInactiveMessages(new Date('2026-01-01T00:00:00Z'));

    assert({
      given: 'a purge removing tombstones across two conversations',
      should: 'recompute lastMessageAt once per distinct conversation',
      actual: { purged, updates: mockUpdateSet.mock.calls.length },
      expected: { purged: 3, updates: 2 },
    });
  });
});

describe('globalConversationRepository recompute failures are isolated from the caller (#2153)', () => {
  it('softDeleteMessage does not throw when the recompute fails, and logs a warning', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ conversationId: 'conv-9' }]);
    mockTransaction.mockImplementationOnce(() => {
      throw new Error('lock timeout');
    });

    await expect(globalConversationRepository.softDeleteMessage('msg-1')).resolves.toBeUndefined();

    assert({
      given: 'a soft-delete whose recompute throws',
      should: 'swallow the recompute failure and log a warning instead of failing the delete',
      actual: {
        warnCalls: mockLoggerWarn.mock.calls.length,
        conversationId: mockLoggerWarn.mock.calls[0]?.[1]?.conversationId,
      },
      expected: { warnCalls: 1, conversationId: 'conv-9' },
    });
  });

  it('hardDeleteMessage does not throw when the recompute fails, and logs a warning', async () => {
    mockDeleteReturning.mockResolvedValueOnce([{ conversationId: 'conv-9' }]);
    mockTransaction.mockImplementationOnce(() => {
      throw new Error('lock timeout');
    });

    await expect(globalConversationRepository.hardDeleteMessage('msg-1')).resolves.toBeUndefined();

    assert({
      given: 'a hard-delete whose recompute throws',
      should: 'swallow the recompute failure and log a warning instead of failing the delete',
      actual: {
        warnCalls: mockLoggerWarn.mock.calls.length,
        conversationId: mockLoggerWarn.mock.calls[0]?.[1]?.conversationId,
      },
      expected: { warnCalls: 1, conversationId: 'conv-9' },
    });
  });

  it('purgeInactiveMessages keeps recomputing later conversations after one recompute fails, and still returns the full purge count', async () => {
    mockDeleteReturning.mockResolvedValueOnce([
      { id: 'm1', conversationId: 'conv-a' },
      { id: 'm2', conversationId: 'conv-b' },
    ]);
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

    const purged = await globalConversationRepository.purgeInactiveMessages(new Date('2026-01-01T00:00:00Z'));

    assert({
      given: 'a purge across two conversations where the first recompute throws',
      should: 'still recompute the second conversation, still report the true purge count, and log exactly one warning',
      actual: { purged, warnCalls: mockLoggerWarn.mock.calls.length, updates: mockUpdateSet.mock.calls.length },
      expected: { purged: 2, warnCalls: 1, updates: 1 },
    });
  });
});

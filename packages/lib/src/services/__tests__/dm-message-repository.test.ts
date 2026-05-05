import { describe, it, expect, vi, beforeEach } from 'vitest';

interface AssertParams {
  given: string;
  should: string;
  actual: unknown;
  expected: unknown;
}

const assert = ({ given, should, actual, expected }: AssertParams): void => {
  const message = `Given ${given}, should ${should}`;
  expect(actual, message).toEqual(expected);
};

const {
  mockUpdateSet,
  mockUpdateWhere,
  mockUpdateReturning,
  mockDeleteWhere,
  mockDeleteReturning,
  mockExecute,
  mockTransaction,
  mockDirectMessagesFindFirst,
  mockDirectMessagesFindMany,
  mockReactionsFindFirst,
  mockInsertValues,
  mockInsertReturning,
} = vi.hoisted(() => ({
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockDeleteWhere: vi.fn(),
  mockDeleteReturning: vi.fn(),
  mockExecute: vi.fn(),
  mockTransaction: vi.fn(),
  mockDirectMessagesFindFirst: vi.fn(),
  mockDirectMessagesFindMany: vi.fn(),
  mockReactionsFindFirst: vi.fn(),
  mockInsertValues: vi.fn(),
  mockInsertReturning: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      dmConversations: { findFirst: vi.fn() },
      files: { findFirst: vi.fn() },
      fileConversations: { findFirst: vi.fn() },
      directMessages: {
        findFirst: mockDirectMessagesFindFirst,
        findMany: mockDirectMessagesFindMany,
      },
      dmMessageReactions: { findFirst: mockReactionsFindFirst },
    },
    insert: vi.fn(() => ({ values: mockInsertValues })),
    update: vi.fn(() => ({ set: mockUpdateSet })),
    delete: vi.fn(() => ({ where: mockDeleteWhere })),
    execute: mockExecute,
    transaction: mockTransaction,
  },
}));

vi.mock('@pagespace/db/operators', () => {
  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
    {
      join: vi.fn((items: unknown[], separator: unknown) => ({ items, separator })),
    }
  );

  return {
    and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
    desc: vi.fn((field: unknown) => ({ op: 'desc', field })),
    eq: vi.fn((field: unknown, value: unknown) => ({ op: 'eq', field, value })),
    isNotNull: vi.fn((field: unknown) => ({ op: 'isNotNull', field })),
    isNull: vi.fn((field: unknown) => ({ op: 'isNull', field })),
    lt: vi.fn((field: unknown, value: unknown) => ({ op: 'lt', field, value })),
    or: vi.fn((...conditions: unknown[]) => ({ op: 'or', conditions })),
    sql,
  };
});

vi.mock('@pagespace/db/schema/social', () => ({
  dmConversations: {
    id: 'dm_conversations.id',
    participant1Id: 'dm_conversations.participant1Id',
    participant2Id: 'dm_conversations.participant2Id',
    lastMessageAt: 'dm_conversations.lastMessageAt',
  },
  directMessages: {
    id: 'direct_messages.id',
    conversationId: 'direct_messages.conversationId',
    senderId: 'direct_messages.senderId',
    content: 'direct_messages.content',
    fileId: 'direct_messages.fileId',
    attachmentMeta: 'direct_messages.attachmentMeta',
    isRead: 'direct_messages.isRead',
    readAt: 'direct_messages.readAt',
    isActive: 'direct_messages.isActive',
    deletedAt: 'direct_messages.deletedAt',
    createdAt: 'direct_messages.createdAt',
  },
  dmMessageReactions: {
    id: 'dm_message_reactions.id',
    messageId: 'dm_message_reactions.messageId',
    userId: 'dm_message_reactions.userId',
    emoji: 'dm_message_reactions.emoji',
  },
}));

vi.mock('@pagespace/db/schema/storage', () => ({
  files: {
    id: 'files.id',
    createdBy: 'files.createdBy',
  },
  fileConversations: {
    fileId: 'file_conversations.fileId',
    conversationId: 'file_conversations.conversationId',
  },
}));

import { db } from '@pagespace/db/db';
import { directMessages, dmMessageReactions } from '@pagespace/db/schema/social';
import { eq, isNotNull, lt } from '@pagespace/db/operators';
import { dmMessageRepository } from '../dm-message-repository';

describe('dmMessageRepository lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUpdateReturning.mockResolvedValue([{ id: 'msg-1' }]);
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    vi.mocked(db.update).mockReturnValue({ set: mockUpdateSet } as never);

    mockDeleteReturning.mockResolvedValue([
      { id: 'msg-1', conversationId: 'conv-1', fileId: 'file-1' },
    ]);
    mockDeleteWhere.mockReturnValue({ returning: mockDeleteReturning });
    vi.mocked(db.delete).mockReturnValue({ where: mockDeleteWhere } as never);
    mockExecute.mockResolvedValue({ rows: [] });
    mockTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        delete: vi.mocked(db.delete),
        execute: mockExecute,
      })
    );
  });

  it('given_softDelete_recordsDeletedAtWithoutFalsifyingReadReceipt', async () => {
    const count = await dmMessageRepository.softDeleteMessage('msg-1');

    expect(count).toBe(1);
    const updatePayload = mockUpdateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updatePayload.isActive).toBe(false);
    expect(updatePayload.deletedAt).toBeInstanceOf(Date);
    expect(updatePayload).not.toHaveProperty('isRead');
    expect(updatePayload).not.toHaveProperty('readAt');
  });

  it('given_inactiveDmsPastRetention_purgesByDeletedAtAndReleasesConversationFileLinks', async () => {
    const cutoff = new Date('2026-04-01T00:00:00.000Z');

    const count = await dmMessageRepository.purgeInactiveMessages(cutoff);

    expect(count).toBe(1);
    expect(isNotNull).toHaveBeenCalledWith(directMessages.deletedAt);
    expect(lt).toHaveBeenCalledWith(directMessages.deletedAt, cutoff);
    expect(mockDeleteReturning).toHaveBeenCalledWith({
      id: directMessages.id,
      conversationId: directMessages.conversationId,
      fileId: directMessages.fileId,
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Reactions parity (PR 2 of 5)
// ---------------------------------------------------------------------------

describe('dmMessageRepository.listActiveMessages [reactions parity]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDirectMessagesFindMany.mockResolvedValue([]);
  });

  it('joins the reactions relation with the user columns the broadcast payload needs', async () => {
    await dmMessageRepository.listActiveMessages({ conversationId: 'conv-1', limit: 50 });

    const call = mockDirectMessagesFindMany.mock.calls[0]?.[0] as {
      with: { reactions: { with: { user: { columns: Record<string, true> } } } };
    };
    assert({
      given: 'a DM list fetch',
      should: 'request reactions with user.id and user.name so the DM page renders the same chip + tooltip shape as channels',
      actual: {
        hasReactions: !!call.with.reactions,
        userColumns: call.with.reactions.with.user.columns,
      },
      expected: {
        hasReactions: true,
        userColumns: { id: true, name: true },
      },
    });
  });
});

describe('dmMessageRepository.addDmReaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertReturning.mockResolvedValue([{ id: 'reaction-1' }]);
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning });
    vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);
  });

  it('writes (messageId, userId, emoji) verbatim and returns the inserted row', async () => {
    mockInsertReturning.mockResolvedValueOnce([{ id: 'reaction-1' }]);

    const result = await dmMessageRepository.addDmReaction({
      messageId: 'msg-1',
      userId: 'user-1',
      emoji: '👍',
    });

    const values = mockInsertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    assert({
      given: 'a DM reaction add request',
      should: 'persist the triple (messageId, userId, emoji) and return the new row id (the unique index enforces no-dup at the DB layer)',
      actual: { values, result },
      expected: {
        values: { messageId: 'msg-1', userId: 'user-1', emoji: '👍' },
        result: { id: 'reaction-1' },
      },
    });
  });
});

describe('dmMessageRepository.loadDmReactionWithUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the reaction with the user relation so broadcasts include name+id without a re-fetch', async () => {
    mockReactionsFindFirst.mockResolvedValueOnce({ id: 'reaction-1', user: { id: 'u', name: 'n' } });

    await dmMessageRepository.loadDmReactionWithUser('reaction-1');

    const call = mockReactionsFindFirst.mock.calls[0]?.[0] as {
      with: { user: { columns: Record<string, true> } };
    };
    assert({
      given: 'a freshly added DM reaction',
      should: 'load the user relation (id, name) so the broadcast payload renders the actor without an extra round-trip',
      actual: call.with.user.columns,
      expected: { id: true, name: true },
    });
  });
});

describe('dmMessageRepository.removeDmReaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteReturning.mockResolvedValue([{ id: 'reaction-1' }]);
    mockDeleteWhere.mockReturnValue({ returning: mockDeleteReturning });
    vi.mocked(db.delete).mockReturnValue({ where: mockDeleteWhere } as never);
  });

  it('returns 0 when the delete matched no rows so the route can 404 on no-op', async () => {
    mockDeleteReturning.mockResolvedValueOnce([]);

    const removed = await dmMessageRepository.removeDmReaction({
      messageId: 'msg-1',
      userId: 'user-1',
      emoji: '👍',
    });

    assert({
      given: 'a delete that matched no rows (already removed or never existed)',
      should: 'return 0 so the route can return 404 instead of pretending success',
      actual: removed,
      expected: 0,
    });
  });

  it('scopes the delete to (messageId, userId, emoji) — never deletes another participant\'s reaction', async () => {
    mockDeleteReturning.mockResolvedValueOnce([{ id: 'reaction-1' }]);

    await dmMessageRepository.removeDmReaction({
      messageId: 'msg-1',
      userId: 'user-1',
      emoji: '👍',
    });

    const eqCalls = vi.mocked(eq).mock.calls;
    const hasMessageId = eqCalls.some(
      ([field, value]) => field === dmMessageReactions.messageId && value === 'msg-1'
    );
    const hasUserId = eqCalls.some(
      ([field, value]) => field === dmMessageReactions.userId && value === 'user-1'
    );
    const hasEmoji = eqCalls.some(
      ([field, value]) => field === dmMessageReactions.emoji && value === '👍'
    );
    assert({
      given: 'a reaction-removal request',
      should: 'WHERE on all three of messageId, userId, and emoji so we only remove the requester\'s own reaction',
      actual: { hasMessageId, hasUserId, hasEmoji },
      expected: { hasMessageId: true, hasUserId: true, hasEmoji: true },
    });
  });
});

// Surface guard: keep the public API shape stable so consumers don't break.
// Note: the route uses the existing `findActiveMessage` for the existence check
// (active-only, by design — soft-deleted DMs cannot accept reactions).
describe('dmMessageRepository surface', () => {
  it('exports the reaction functions the DM routes need at parity with channels', () => {
    const keys = Object.keys(dmMessageRepository);
    assert({
      given: 'the repository module',
      should: 'expose addDmReaction, removeDmReaction, and loadDmReactionWithUser',
      actual: {
        addDmReaction: keys.includes('addDmReaction'),
        removeDmReaction: keys.includes('removeDmReaction'),
        loadDmReactionWithUser: keys.includes('loadDmReactionWithUser'),
      },
      expected: {
        addDmReaction: true,
        removeDmReaction: true,
        loadDmReactionWithUser: true,
      },
    });
  });
});

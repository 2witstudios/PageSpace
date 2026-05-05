import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockUpdateSet,
  mockUpdateWhere,
  mockUpdateReturning,
  mockDeleteWhere,
  mockDeleteReturning,
  mockExecute,
  mockTransaction,
  mockInsertValues,
  mockInsertReturning,
  mockInsertOnConflictDoNothing,
  mockDirectMessagesFindFirst,
  mockSelectFrom,
} = vi.hoisted(() => ({
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockDeleteWhere: vi.fn(),
  mockDeleteReturning: vi.fn(),
  mockExecute: vi.fn(),
  mockTransaction: vi.fn(),
  mockInsertValues: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockInsertOnConflictDoNothing: vi.fn(),
  mockDirectMessagesFindFirst: vi.fn(),
  mockSelectFrom: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      dmConversations: { findFirst: vi.fn() },
      files: { findFirst: vi.fn() },
      fileConversations: { findFirst: vi.fn() },
      directMessages: { findFirst: mockDirectMessagesFindFirst },
    },
    insert: vi.fn(() => ({ values: mockInsertValues })),
    update: vi.fn(() => ({ set: mockUpdateSet })),
    delete: vi.fn(() => ({ where: mockDeleteWhere })),
    select: vi.fn(() => ({ from: mockSelectFrom })),
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
    asc: vi.fn((field: unknown) => ({ op: 'asc', field })),
    desc: vi.fn((field: unknown) => ({ op: 'desc', field })),
    eq: vi.fn((field: unknown, value: unknown) => ({ op: 'eq', field, value })),
    gt: vi.fn((field: unknown, value: unknown) => ({ op: 'gt', field, value })),
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
    parentId: 'direct_messages.parentId',
    replyCount: 'direct_messages.replyCount',
    lastReplyAt: 'direct_messages.lastReplyAt',
    mirroredFromId: 'direct_messages.mirroredFromId',
  },
  dmThreadFollowers: {
    rootMessageId: 'dm_thread_followers.rootMessageId',
    userId: 'dm_thread_followers.userId',
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
import { directMessages, dmThreadFollowers } from '@pagespace/db/schema/social';
import { asc, eq, gt, isNotNull, lt } from '@pagespace/db/operators';
import { dmMessageRepository } from '../dm-message-repository';

// Riteway-style assert helper for the thread tests below.
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

describe('dmMessageRepository lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUpdateReturning.mockResolvedValue([{ id: 'msg-1', parentId: null }]);
    mockUpdateWhere.mockReturnValue({
      returning: mockUpdateReturning,
      then: (resolve: (v: unknown) => unknown) => resolve(undefined),
    });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    vi.mocked(db.update).mockReturnValue({ set: mockUpdateSet } as never);

    mockInsertReturning.mockResolvedValue([{ id: 'msg-1' }]);
    mockInsertOnConflictDoNothing.mockResolvedValue(undefined);
    mockInsertValues.mockReturnValue({
      returning: mockInsertReturning,
      onConflictDoNothing: mockInsertOnConflictDoNothing,
    });
    vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);

    mockDeleteReturning.mockResolvedValue([
      { id: 'msg-1', conversationId: 'conv-1', fileId: 'file-1' },
    ]);
    mockDeleteWhere.mockReturnValue({
      returning: mockDeleteReturning,
      then: (resolve: (v: unknown) => unknown) => resolve(undefined),
    });
    vi.mocked(db.delete).mockReturnValue({ where: mockDeleteWhere } as never);

    mockSelectFrom.mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    });
    vi.mocked(db.select).mockReturnValue({ from: mockSelectFrom } as never);

    mockExecute.mockResolvedValue({ rows: [] });
    // Default: pass db itself as the tx so all chain mocks above apply unchanged.
    mockTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(db)
    );
  });

  it('given_softDelete_recordsDeletedAtWithoutFalsifyingReadReceipt', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'msg-1', parentId: null }]);

    const count = await dmMessageRepository.softDeleteMessage('msg-1');

    expect(count).toBe(1);
    const updatePayload = mockUpdateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updatePayload.isActive).toBe(false);
    expect(updatePayload.deletedAt).toBeInstanceOf(Date);
    expect(updatePayload).not.toHaveProperty('isRead');
    expect(updatePayload).not.toHaveProperty('readAt');
  });

  it('given_softDeleteOfThreadReply_decrementsParentReplyCount', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'reply-1', parentId: 'parent-1' }]);

    await dmMessageRepository.softDeleteMessage('reply-1');

    const setCalls = mockUpdateSet.mock.calls.map((c) => c[0] as Record<string, unknown>);
    assert({
      given: 'a soft-delete of a DM thread reply',
      should: 'issue two updates inside the same tx — one to flip isActive, one to decrement parent.replyCount',
      actual: {
        firstSetIsActive: setCalls[0]?.isActive,
        secondHasReplyCount: 'replyCount' in (setCalls[1] ?? {}),
      },
      expected: { firstSetIsActive: false, secondHasReplyCount: true },
    });
  });

  it('given_softDeleteOfTopLevelDm_doesNotIssueParentCounterUpdate', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'top-1', parentId: null }]);

    await dmMessageRepository.softDeleteMessage('top-1');

    assert({
      given: 'a soft-delete of a top-level DM (parentId IS NULL)',
      should: 'only run the isActive flip — never touch a parent counter',
      actual: mockUpdateSet.mock.calls.length,
      expected: 1,
    });
  });

  it('given_restoreOfThreadReply_incrementsParentReplyCount', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ id: 'reply-1', parentId: 'parent-1' }]);

    const count = await dmMessageRepository.restoreDmMessage('reply-1');

    expect(count).toBe(1);
    const setCalls = mockUpdateSet.mock.calls.map((c) => c[0] as Record<string, unknown>);
    assert({
      given: 'a restore of a DM thread reply',
      should: 'flip isActive=true and increment parent.replyCount in the same tx',
      actual: {
        firstSetIsActive: setCalls[0]?.isActive,
        secondHasReplyCount: 'replyCount' in (setCalls[1] ?? {}),
      },
      expected: { firstSetIsActive: true, secondHasReplyCount: true },
    });
  });

  it('given_inactiveDmsPastRetention_purgesByDeletedAtAndReleasesConversationFileLinks', async () => {
    // The purge tx callback uses tx.delete + tx.execute; mock transaction with
    // exactly that surface so we don't fall through to the db pass-through used
    // by the soft-delete tests above.
    mockTransaction.mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ delete: vi.mocked(db.delete), execute: mockExecute })
    );

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

// =============================================================================
// Thread reply functions
// =============================================================================

describe('dmMessageRepository.insertDmThreadReply', () => {
  const baseInput = {
    parentId: 'parent-1',
    conversationId: 'conv-1',
    senderId: 'user-replier',
    content: 'thread response',
    fileId: null,
    attachmentMeta: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockUpdateReturning.mockResolvedValue([{ replyCount: 1, lastReplyAt: new Date() }]);
    mockUpdateWhere.mockReturnValue({
      returning: mockUpdateReturning,
      then: (resolve: (v: unknown) => unknown) => resolve(undefined),
    });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    vi.mocked(db.update).mockReturnValue({ set: mockUpdateSet } as never);

    mockInsertReturning.mockResolvedValue([{ id: 'reply-1', createdAt: new Date(), parentId: 'parent-1' }]);
    mockInsertOnConflictDoNothing.mockResolvedValue(undefined);
    mockInsertValues.mockReturnValue({
      returning: mockInsertReturning,
      onConflictDoNothing: mockInsertOnConflictDoNothing,
    });
    vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);

    mockTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(db)
    );
  });

  it('rejects with parent_not_found when the parent is missing or inactive', async () => {
    mockDirectMessagesFindFirst.mockResolvedValueOnce(undefined);

    const result = await dmMessageRepository.insertDmThreadReply(baseInput);

    assert({
      given: 'a parent id that does not resolve to an active DM row',
      should: 'return parent_not_found WITHOUT inserting a reply or follower row',
      actual: { kind: result.kind, insertCount: mockInsertValues.mock.calls.length },
      expected: { kind: 'parent_not_found', insertCount: 0 },
    });
  });

  it('rejects with parent_wrong_conversation when the parent belongs to a different conversation', async () => {
    mockDirectMessagesFindFirst.mockResolvedValueOnce({
      id: 'parent-1',
      conversationId: 'other-conv',
      parentId: null,
      senderId: 'user-parent',
      isActive: true,
    });

    const result = await dmMessageRepository.insertDmThreadReply(baseInput);

    assert({
      given: 'a parent id whose conversationId differs from the request conversation',
      should: 'return parent_wrong_conversation so the route can 400',
      actual: { kind: result.kind, insertCount: mockInsertValues.mock.calls.length },
      expected: { kind: 'parent_wrong_conversation', insertCount: 0 },
    });
  });

  it('rejects with parent_not_top_level when the parent itself has parentId set (depth-2 attempt)', async () => {
    mockDirectMessagesFindFirst.mockResolvedValueOnce({
      id: 'parent-1',
      conversationId: 'conv-1',
      parentId: 'grandparent',
      senderId: 'user-parent',
      isActive: true,
    });

    const result = await dmMessageRepository.insertDmThreadReply(baseInput);

    assert({
      given: 'a DM parent that is itself a thread reply',
      should: 'return parent_not_top_level — DM threads are exactly one level deep',
      actual: { kind: result.kind, insertCount: mockInsertValues.mock.calls.length },
      expected: { kind: 'parent_not_top_level', insertCount: 0 },
    });
  });

  it('inserts the reply with parentId set, bumps replyCount + lastReplyAt, and upserts both followers', async () => {
    mockDirectMessagesFindFirst.mockResolvedValueOnce({
      id: 'parent-1',
      conversationId: 'conv-1',
      parentId: null,
      senderId: 'user-parent',
      isActive: true,
    });
    const replyCreatedAt = new Date('2026-05-04T12:00:00Z');
    mockInsertReturning.mockResolvedValueOnce([
      { id: 'reply-1', createdAt: replyCreatedAt, parentId: 'parent-1' },
    ]);
    mockUpdateReturning.mockResolvedValueOnce([
      { replyCount: 1, lastReplyAt: replyCreatedAt },
    ]);

    const result = await dmMessageRepository.insertDmThreadReply(baseInput);

    const replyValues = mockInsertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    const followerValues = mockInsertValues.mock.calls[1]?.[0] as Array<Record<string, unknown>>;
    const updateSet = mockUpdateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    assert({
      given: 'a happy-path DM thread reply with a distinct replier and parent author',
      should: 'insert the reply with parentId, set lastReplyAt, and upsert followers for parent author + replier',
      actual: {
        kind: result.kind,
        replyParent: replyValues.parentId,
        updateHasReplyCount: 'replyCount' in updateSet,
        updateLastReplyAt: updateSet.lastReplyAt,
        followerUserIds: followerValues.map((r) => r.userId).sort(),
        usedOnConflictDoNothing: mockInsertOnConflictDoNothing.mock.calls.length,
      },
      expected: {
        kind: 'ok',
        replyParent: 'parent-1',
        updateHasReplyCount: true,
        updateLastReplyAt: replyCreatedAt,
        followerUserIds: ['user-parent', 'user-replier'],
        usedOnConflictDoNothing: 1,
      },
    });
  });

  it('dedupes followers when the parent author replies to their own DM thread', async () => {
    mockDirectMessagesFindFirst.mockResolvedValueOnce({
      id: 'parent-1',
      conversationId: 'conv-1',
      parentId: null,
      senderId: 'user-self',
      isActive: true,
    });
    mockInsertReturning.mockResolvedValueOnce([
      { id: 'reply-1', createdAt: new Date(), parentId: 'parent-1' },
    ]);
    mockUpdateReturning.mockResolvedValueOnce([
      { replyCount: 1, lastReplyAt: new Date() },
    ]);

    await dmMessageRepository.insertDmThreadReply({
      ...baseInput,
      senderId: 'user-self',
    });

    const followerValues = mockInsertValues.mock.calls[1]?.[0] as Array<Record<string, unknown>>;
    assert({
      given: 'a DM reply where parent author and replier are the same user',
      should: 'send a single follower row to onConflictDoNothing — Postgres rejects duplicates within one INSERT',
      actual: followerValues,
      expected: [{ rootMessageId: 'parent-1', userId: 'user-self' }],
    });
  });

  it('writes a second top-level row with mirroredFromId set when alsoSendToParent is true', async () => {
    mockDirectMessagesFindFirst.mockResolvedValueOnce({
      id: 'parent-1',
      conversationId: 'conv-1',
      parentId: null,
      senderId: 'user-parent',
      isActive: true,
    });
    mockInsertReturning
      .mockResolvedValueOnce([
        { id: 'reply-1', createdAt: new Date('2026-05-04T12:00:00Z'), parentId: 'parent-1' },
      ])
      .mockResolvedValueOnce([
        { id: 'mirror-1', createdAt: new Date('2026-05-04T12:00:01Z'), mirroredFromId: 'reply-1' },
      ]);
    mockUpdateReturning.mockResolvedValueOnce([
      { replyCount: 1, lastReplyAt: new Date('2026-05-04T12:00:00Z') },
    ]);

    const result = await dmMessageRepository.insertDmThreadReply({
      ...baseInput,
      alsoSendToParent: true,
    });

    const insertCount = mockInsertValues.mock.calls.length;
    const mirrorValues = mockInsertValues.mock.calls[2]?.[0] as Record<string, unknown>;
    assert({
      given: 'an alsoSendToParent DM thread reply',
      should: 'write a second top-level row with mirroredFromId pointing at the reply id',
      actual: {
        kind: result.kind,
        insertCount,
        mirrorParentId: mirrorValues?.parentId ?? null,
        mirrorMirroredFromId: mirrorValues?.mirroredFromId,
        resultMirrorId: result.kind === 'ok' ? result.mirror?.id : null,
      },
      expected: {
        kind: 'ok',
        insertCount: 3,
        mirrorParentId: null,
        mirrorMirroredFromId: 'reply-1',
        resultMirrorId: 'mirror-1',
      },
    });
  });
});

describe('dmMessageRepository.listDmThreadReplies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The function uses db.select().from().where().orderBy().limit() chain.
    const limitMock = vi.fn().mockResolvedValue([]);
    const orderByMock = vi.fn(() => ({ limit: limitMock }));
    const whereMock = vi.fn(() => ({ orderBy: orderByMock }));
    mockSelectFrom.mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: mockSelectFrom } as never);
  });

  it('filters by parentId AND isActive=true and orders ascending by (createdAt, id)', async () => {
    await dmMessageRepository.listDmThreadReplies({ rootId: 'parent-1', limit: 50 });

    const eqCalls = vi.mocked(eq).mock.calls;
    const ascCalls = vi.mocked(asc).mock.calls;
    assert({
      given: 'a DM thread list-replies request',
      should: 'WHERE parentId = root AND isActive = true; ORDER BY createdAt asc, id asc',
      actual: {
        scopedToParent: eqCalls.some(
          ([field, value]) => field === directMessages.parentId && value === 'parent-1'
        ),
        scopedActive: eqCalls.some(
          ([field, value]) => field === directMessages.isActive && value === true
        ),
        ascCount: ascCalls.length,
      },
      expected: { scopedToParent: true, scopedActive: true, ascCount: 2 },
    });
  });

  it('builds a strictly-greater-than composite cursor when after is supplied', async () => {
    const after = { createdAt: new Date('2026-05-04T12:00:00Z'), id: 'reply-cursor' };

    await dmMessageRepository.listDmThreadReplies({
      rootId: 'parent-1',
      limit: 50,
      after,
    });

    const gtCalls = vi.mocked(gt).mock.calls;
    assert({
      given: 'an ascending-cursor DM pagination request',
      should: 'use gt() against both createdAt and id so the next page never re-emits the cursor row',
      actual: {
        createdAt: gtCalls.some(([field, value]) => field === directMessages.createdAt && value === after.createdAt),
        id: gtCalls.some(([field, value]) => field === directMessages.id && value === after.id),
      },
      expected: { createdAt: true, id: true },
    });
  });
});

describe('dmMessageRepository thread follower helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockInsertOnConflictDoNothing.mockResolvedValue(undefined);
    mockInsertValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([]),
      onConflictDoNothing: mockInsertOnConflictDoNothing,
    });
    vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);

    mockDeleteWhere.mockResolvedValue(undefined);
    vi.mocked(db.delete).mockReturnValue({ where: mockDeleteWhere } as never);

    mockSelectFrom.mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    });
    vi.mocked(db.select).mockReturnValue({ from: mockSelectFrom } as never);
  });

  it('addDmThreadFollower inserts (rootId, userId) and uses onConflictDoNothing for idempotency', async () => {
    await dmMessageRepository.addDmThreadFollower('root-1', 'user-1');

    const values = mockInsertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    assert({
      given: 'an explicit DM follower add',
      should: 'insert the (rootMessageId, userId) pair with onConflictDoNothing',
      actual: {
        values,
        usedOnConflictDoNothing: mockInsertOnConflictDoNothing.mock.calls.length,
      },
      expected: {
        values: { rootMessageId: 'root-1', userId: 'user-1' },
        usedOnConflictDoNothing: 1,
      },
    });
  });

  it('removeDmThreadFollower deletes scoped to (rootId, userId) — never another user', async () => {
    await dmMessageRepository.removeDmThreadFollower('root-1', 'user-1');

    const eqCalls = vi.mocked(eq).mock.calls;
    assert({
      given: 'an explicit DM follower remove',
      should: 'WHERE on both rootMessageId AND userId so we never delete another user\'s follow row',
      actual: {
        scopedRoot: eqCalls.some(
          ([field, value]) => field === dmThreadFollowers.rootMessageId && value === 'root-1'
        ),
        scopedUser: eqCalls.some(
          ([field, value]) => field === dmThreadFollowers.userId && value === 'user-1'
        ),
      },
      expected: { scopedRoot: true, scopedUser: true },
    });
  });

  it('listDmThreadFollowers returns a flat array of user ids', async () => {
    const fromWhere = vi.fn().mockResolvedValueOnce([
      { userId: 'user-a' },
      { userId: 'user-b' },
    ]);
    mockSelectFrom.mockReturnValueOnce({ where: fromWhere });

    const result = await dmMessageRepository.listDmThreadFollowers('root-1');

    assert({
      given: 'a DM thread root with two followers',
      should: 'return a flat string[] of user ids',
      actual: result,
      expected: ['user-a', 'user-b'],
    });
  });
});

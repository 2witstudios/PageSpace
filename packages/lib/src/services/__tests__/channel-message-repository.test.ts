import { describe, it, expect, vi, beforeEach } from 'vitest';

// Riteway-style assert helper (matches packages/lib/src/auth/magic-link-service.test.ts).
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
  mockChannelMessagesFindMany,
  mockChannelMessagesFindFirst,
  mockReactionsFindFirst,
  mockFilesFindFirst,
  mockFollowersWhere,
  mockSelectFrom,
  mockInsertValues,
  mockInsertReturning,
  mockInsertOnConflictDoUpdate,
  mockInsertOnConflictDoNothing,
  mockUpdateSet,
  mockUpdateWhere,
  mockUpdateReturning,
  mockDeleteWhere,
  mockDeleteReturning,
  mockTransaction,
} = vi.hoisted(() => ({
  mockChannelMessagesFindMany: vi.fn(),
  mockChannelMessagesFindFirst: vi.fn(),
  mockReactionsFindFirst: vi.fn(),
  mockFilesFindFirst: vi.fn(),
  mockFollowersWhere: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockInsertValues: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockInsertOnConflictDoUpdate: vi.fn(),
  mockInsertOnConflictDoNothing: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockDeleteWhere: vi.fn(),
  mockDeleteReturning: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      channelMessages: {
        findMany: mockChannelMessagesFindMany,
        findFirst: mockChannelMessagesFindFirst,
      },
      channelMessageReactions: { findFirst: mockReactionsFindFirst },
      files: { findFirst: mockFilesFindFirst },
    },
    insert: vi.fn(() => ({ values: mockInsertValues })),
    update: vi.fn(() => ({ set: mockUpdateSet })),
    delete: vi.fn(() => ({ where: mockDeleteWhere })),
    select: vi.fn(() => ({ from: mockSelectFrom })),
    transaction: mockTransaction,
  },
}));

vi.mock('@pagespace/db/operators', () => {
  const sqlFn = Object.assign(
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
    isNull: vi.fn((field: unknown) => ({ op: 'isNull', field })),
    lt: vi.fn((field: unknown, value: unknown) => ({ op: 'lt', field, value })),
    or: vi.fn((...conditions: unknown[]) => ({ op: 'or', conditions })),
    sql: sqlFn,
  };
});

vi.mock('@pagespace/db/schema/chat', () => ({
  channelMessages: {
    id: 'channel_messages.id',
    pageId: 'channel_messages.pageId',
    userId: 'channel_messages.userId',
    content: 'channel_messages.content',
    fileId: 'channel_messages.fileId',
    attachmentMeta: 'channel_messages.attachmentMeta',
    isActive: 'channel_messages.isActive',
    editedAt: 'channel_messages.editedAt',
    createdAt: 'channel_messages.createdAt',
    parentId: 'channel_messages.parentId',
    replyCount: 'channel_messages.replyCount',
    lastReplyAt: 'channel_messages.lastReplyAt',
    mirroredFromId: 'channel_messages.mirroredFromId',
  },
  channelMessageReactions: {
    id: 'channel_message_reactions.id',
    messageId: 'channel_message_reactions.messageId',
    userId: 'channel_message_reactions.userId',
    emoji: 'channel_message_reactions.emoji',
  },
  channelReadStatus: {
    userId: 'channel_read_status.userId',
    channelId: 'channel_read_status.channelId',
    lastReadAt: 'channel_read_status.lastReadAt',
  },
  channelThreadFollowers: {
    rootMessageId: 'channel_thread_followers.rootMessageId',
    userId: 'channel_thread_followers.userId',
  },
}));

vi.mock('@pagespace/db/schema/storage', () => ({
  files: {
    id: 'files.id',
  },
}));

import { db } from '@pagespace/db/db';
import {
  channelMessages,
  channelMessageReactions,
  channelReadStatus,
  channelThreadFollowers,
} from '@pagespace/db/schema/chat';
import { and, asc, eq, gt, isNull, lt, or } from '@pagespace/db/operators';
import { channelMessageRepository } from '../channel-message-repository';

beforeEach(() => {
  vi.clearAllMocks();

  // Insert pipeline
  mockInsertOnConflictDoUpdate.mockResolvedValue(undefined);
  mockInsertOnConflictDoNothing.mockResolvedValue(undefined);
  mockInsertReturning.mockResolvedValue([{ id: 'msg-1' }]);
  mockInsertValues.mockReturnValue({
    returning: mockInsertReturning,
    onConflictDoUpdate: mockInsertOnConflictDoUpdate,
    onConflictDoNothing: mockInsertOnConflictDoNothing,
  });
  vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);

  // Update pipeline (resolves to a chainable .returning() too, for soft-delete tx)
  mockUpdateReturning.mockResolvedValue([{ parentId: null }]);
  mockUpdateWhere.mockReturnValue({
    returning: mockUpdateReturning,
    then: (resolve: (v: unknown) => unknown) => resolve(undefined),
  });
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  vi.mocked(db.update).mockReturnValue({ set: mockUpdateSet } as never);

  // Delete pipeline
  mockDeleteReturning.mockResolvedValue([{ id: 'reaction-1' }]);
  mockDeleteWhere.mockReturnValue({
    returning: mockDeleteReturning,
    then: (resolve: (v: unknown) => unknown) => resolve(undefined),
  });
  vi.mocked(db.delete).mockReturnValue({ where: mockDeleteWhere } as never);

  // Select pipeline (followers list)
  mockSelectFrom.mockReturnValue({
    where: vi.fn().mockResolvedValue([]),
  });
  vi.mocked(db.select).mockReturnValue({ from: mockSelectFrom } as never);

  // Transaction passes db itself as the tx so all chain mocks above apply
  // unchanged inside the callback.
  mockTransaction.mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) => cb(db)
  );
});

describe('channelMessageRepository.listChannelMessages', () => {
  it('filters out replies by requiring parentId IS NULL', async () => {
    mockChannelMessagesFindMany.mockResolvedValue([]);

    await channelMessageRepository.listChannelMessages({ pageId: 'page-1', limit: 10 });

    assert({
      given: 'a top-level message fetch',
      should: 'add a parentId IS NULL filter so thread replies do not leak into the main stream',
      actual: vi.mocked(isNull).mock.calls.some(
        ([field]) => field === channelMessages.parentId
      ),
      expected: true,
    });
  });

  it('omits the cursor branch when no cursor is supplied', async () => {
    mockChannelMessagesFindMany.mockResolvedValue([]);

    await channelMessageRepository.listChannelMessages({ pageId: 'page-1', limit: 10 });

    assert({
      given: 'a list call without a cursor',
      should: 'not build any (createdAt, id) cursor disjunction',
      actual: vi.mocked(or).mock.calls.length,
      expected: 0,
    });
  });

  it('builds a composite cursor disjunction when cursor is supplied', async () => {
    mockChannelMessagesFindMany.mockResolvedValue([]);
    const cursor = { createdAt: new Date('2026-01-01T00:00:00Z'), id: 'msg-cursor' };

    await channelMessageRepository.listChannelMessages({
      pageId: 'page-1',
      limit: 10,
      cursor,
    });

    const ltCalls = vi.mocked(lt).mock.calls;
    assert({
      given: 'a composite cursor (createdAt, id)',
      should: 'use lt() against both createdAt and id so pagination is stable across ties',
      actual: {
        createdAt: ltCalls.some(([field, value]) => field === channelMessages.createdAt && value === cursor.createdAt),
        id: ltCalls.some(([field, value]) => field === channelMessages.id && value === cursor.id),
      },
      expected: { createdAt: true, id: true },
    });
  });

  it('passes the supplied limit through unchanged so the route can fetch limit+1 for hasMore', async () => {
    mockChannelMessagesFindMany.mockResolvedValue([]);

    await channelMessageRepository.listChannelMessages({ pageId: 'page-1', limit: 51 });

    const call = mockChannelMessagesFindMany.mock.calls[0]?.[0] as { limit: number };
    assert({
      given: 'a limit value chosen by the route',
      should: 'forward it verbatim — the repository does not own pagination semantics',
      actual: call.limit,
      expected: 51,
    });
  });
});

describe('channelMessageRepository.findChannelMessageInPage', () => {
  it('scopes the lookup to a single page', async () => {
    mockChannelMessagesFindFirst.mockResolvedValueOnce({ id: 'msg-1', pageId: 'page-1' });

    await channelMessageRepository.findChannelMessageInPage({ messageId: 'msg-1', pageId: 'page-1' });

    const eqCalls = vi.mocked(eq).mock.calls;
    assert({
      given: 'a (messageId, pageId) tuple',
      should: 'add an eq predicate on pageId so a stolen message id from another channel cannot hit',
      actual: eqCalls.some(([field, value]) => field === channelMessages.pageId && value === 'page-1'),
      expected: true,
    });
  });

  it('returns null when the message belongs to a different page', async () => {
    mockChannelMessagesFindFirst.mockResolvedValueOnce(undefined);

    const result = await channelMessageRepository.findChannelMessageInPage({
      messageId: 'msg-1',
      pageId: 'wrong-page',
    });

    assert({
      given: 'a message id that does not match the requested page',
      should: 'return null so the route can render a 404',
      actual: result,
      expected: null,
    });
  });
});

describe('channelMessageRepository.loadChannelMessageWithRelations', () => {
  it('asks for user, file, and reactions-with-user relations so the route response stays rich', async () => {
    mockChannelMessagesFindFirst.mockResolvedValueOnce({ id: 'msg-1' });

    await channelMessageRepository.loadChannelMessageWithRelations('msg-1');

    const call = mockChannelMessagesFindFirst.mock.calls[0]?.[0] as {
      with: { user: unknown; file: unknown; reactions: { with: { user: unknown } } };
    };
    assert({
      given: 'a freshly created message id',
      should: 'load all three relations so the broadcast payload matches the route shape',
      actual: {
        hasUser: !!call.with.user,
        hasFile: !!call.with.file,
        hasReactionUser: !!call.with.reactions.with.user,
      },
      expected: { hasUser: true, hasFile: true, hasReactionUser: true },
    });
  });
});

describe('channelMessageRepository.fileExists', () => {
  it('returns true when the file row is present', async () => {
    mockFilesFindFirst.mockResolvedValueOnce({ id: 'file-1' });

    const result = await channelMessageRepository.fileExists('file-1');

    assert({
      given: 'an attachment id that resolves to a file row',
      should: 'return true so the route accepts the upload',
      actual: result,
      expected: true,
    });
  });

  it('returns false when the file row is missing', async () => {
    mockFilesFindFirst.mockResolvedValueOnce(undefined);

    const result = await channelMessageRepository.fileExists('missing-file');

    assert({
      given: 'an attachment id with no matching file row',
      should: 'return false so the route returns a 400 instead of orphaning the message',
      actual: result,
      expected: false,
    });
  });
});

describe('channelMessageRepository.insertChannelMessage', () => {
  it('writes pageId, userId, content, fileId, and attachmentMeta verbatim', async () => {
    mockInsertReturning.mockResolvedValueOnce([{ id: 'msg-1' }]);

    await channelMessageRepository.insertChannelMessage({
      pageId: 'page-1',
      userId: 'user-1',
      content: 'hello',
      fileId: 'file-1',
      attachmentMeta: { kind: 'image' } as never,
    });

    const values = mockInsertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    assert({
      given: 'an insert request with all fields populated',
      should: 'forward each field unchanged — the repository does not normalize input',
      actual: values,
      expected: {
        pageId: 'page-1',
        userId: 'user-1',
        content: 'hello',
        fileId: 'file-1',
        attachmentMeta: { kind: 'image' },
      },
    });
  });

  it('persists null fileId and null attachmentMeta when there is no attachment', async () => {
    mockInsertReturning.mockResolvedValueOnce([{ id: 'msg-2' }]);

    await channelMessageRepository.insertChannelMessage({
      pageId: 'page-1',
      userId: 'user-1',
      content: 'plain text',
      fileId: null,
      attachmentMeta: null,
    });

    const values = mockInsertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    assert({
      given: 'a text-only message',
      should: 'insert NULL into fileId and attachmentMeta rather than dropping the columns',
      actual: { fileId: values.fileId, attachmentMeta: values.attachmentMeta },
      expected: { fileId: null, attachmentMeta: null },
    });
  });
});

describe('channelMessageRepository.upsertChannelReadStatus', () => {
  it('upserts on (userId, channelId) so a sender-reads-own-message write is idempotent', async () => {
    const readAt = new Date('2026-05-04T12:00:00Z');

    await channelMessageRepository.upsertChannelReadStatus({
      userId: 'user-1',
      channelId: 'page-1',
      readAt,
    });

    const conflict = mockInsertOnConflictDoUpdate.mock.calls[0]?.[0] as {
      target: unknown[];
      set: { lastReadAt: Date };
    };
    assert({
      given: 'a sender posting in their own channel',
      should: 'target the (userId, channelId) composite and update lastReadAt',
      actual: {
        target: conflict.target,
        lastReadAt: conflict.set.lastReadAt,
      },
      expected: {
        target: [channelReadStatus.userId, channelReadStatus.channelId],
        lastReadAt: readAt,
      },
    });
  });
});

describe('channelMessageRepository.updateChannelMessageContent', () => {
  it('writes content + editedAt and scopes the update to the message id', async () => {
    const editedAt = new Date('2026-05-04T13:00:00Z');

    await channelMessageRepository.updateChannelMessageContent({
      messageId: 'msg-1',
      content: 'edited',
      editedAt,
    });

    const set = mockUpdateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    const eqCalls = vi.mocked(eq).mock.calls;
    assert({
      given: 'an edit request',
      should: 'set both content and editedAt and target the matching message id',
      actual: {
        set,
        whereOnId: eqCalls.some(([field, value]) => field === channelMessages.id && value === 'msg-1'),
      },
      expected: {
        set: { content: 'edited', editedAt },
        whereOnId: true,
      },
    });
  });
});

describe('channelMessageRepository.softDeleteChannelMessage', () => {
  it('flips isActive=false (a delete must not purge — soft only)', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ parentId: null }]);

    await channelMessageRepository.softDeleteChannelMessage('msg-1');

    const set = mockUpdateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    assert({
      given: 'a delete request for a top-level message',
      should: 'set isActive=false rather than removing the row, so retention/audit still has the data',
      actual: set,
      expected: { isActive: false },
    });
  });

  it('decrements the parent replyCount when the soft-deleted row is a thread reply', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ parentId: 'parent-1' }]);

    await channelMessageRepository.softDeleteChannelMessage('reply-1');

    // Two update calls: 1) flip isActive=false on the reply,
    // 2) replyCount = GREATEST(replyCount - 1, 0) on the parent.
    const setCalls = mockUpdateSet.mock.calls.map((c) => c[0] as Record<string, unknown>);
    assert({
      given: 'a soft-delete of a thread reply',
      should: 'issue two updates inside the same tx — one to flip isActive, one to decrement parent.replyCount',
      actual: {
        firstSet: setCalls[0],
        secondHasReplyCount: 'replyCount' in (setCalls[1] ?? {}),
      },
      expected: {
        firstSet: { isActive: false },
        secondHasReplyCount: true,
      },
    });
  });

  it('does NOT issue a parent-counter update when the row is top-level (parentId is null)', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ parentId: null }]);

    await channelMessageRepository.softDeleteChannelMessage('top-1');

    assert({
      given: 'a soft-delete of a top-level message (parentId IS NULL)',
      should: 'only run the isActive flip — never touch a parent counter',
      actual: mockUpdateSet.mock.calls.length,
      expected: 1,
    });
  });
});

describe('channelMessageRepository.restoreChannelMessage', () => {
  it('flips isActive=true when restoring a row', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ parentId: null }]);

    await channelMessageRepository.restoreChannelMessage('msg-1');

    const set = mockUpdateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    assert({
      given: 'a restore request',
      should: 'flip isActive back to true on the targeted row',
      actual: set,
      expected: { isActive: true },
    });
  });

  it('increments the parent replyCount when the restored row is a thread reply', async () => {
    mockUpdateReturning.mockResolvedValueOnce([{ parentId: 'parent-1' }]);

    await channelMessageRepository.restoreChannelMessage('reply-1');

    assert({
      given: 'a restore of a thread reply',
      should: 'run two updates — flip isActive=true, then increment parent.replyCount',
      actual: {
        count: mockUpdateSet.mock.calls.length,
        secondHasReplyCount: 'replyCount' in (mockUpdateSet.mock.calls[1]?.[0] as Record<string, unknown> ?? {}),
      },
      expected: { count: 2, secondHasReplyCount: true },
    });
  });
});

describe('channelMessageRepository.insertChannelThreadReply', () => {
  const baseInput = {
    parentId: 'parent-1',
    pageId: 'page-1',
    userId: 'user-replier',
    content: 'thread response',
    fileId: null,
    attachmentMeta: null,
  };

  it('rejects with parent_not_found when the parent row is missing or inactive', async () => {
    mockChannelMessagesFindFirst.mockResolvedValueOnce(undefined);

    const result = await channelMessageRepository.insertChannelThreadReply(baseInput);

    assert({
      given: 'a parent id that does not resolve to an active row',
      should: 'return parent_not_found WITHOUT inserting a reply or follower row',
      actual: { kind: result.kind, insertCount: mockInsertValues.mock.calls.length },
      expected: { kind: 'parent_not_found', insertCount: 0 },
    });
  });

  it('rejects with parent_wrong_page when the parent belongs to a different channel', async () => {
    mockChannelMessagesFindFirst.mockResolvedValueOnce({
      id: 'parent-1',
      pageId: 'other-page',
      parentId: null,
      userId: 'parent-author',
      isActive: true,
    });

    const result = await channelMessageRepository.insertChannelThreadReply(baseInput);

    assert({
      given: 'a parent id whose pageId differs from the request page',
      should: 'return parent_wrong_page so the route can 400 — never insert a reply scoped to the wrong channel',
      actual: { kind: result.kind, insertCount: mockInsertValues.mock.calls.length },
      expected: { kind: 'parent_wrong_page', insertCount: 0 },
    });
  });

  it('rejects with parent_not_top_level when the parent itself has parentId set (depth-2 attempt)', async () => {
    mockChannelMessagesFindFirst.mockResolvedValueOnce({
      id: 'parent-1',
      pageId: 'page-1',
      parentId: 'grandparent',
      userId: 'parent-author',
      isActive: true,
    });

    const result = await channelMessageRepository.insertChannelThreadReply(baseInput);

    assert({
      given: 'a parent that is itself a thread reply',
      should: 'return parent_not_top_level — threads are exactly one level deep',
      actual: { kind: result.kind, insertCount: mockInsertValues.mock.calls.length },
      expected: { kind: 'parent_not_top_level', insertCount: 0 },
    });
  });

  it('inserts the reply with parentId set, bumps replyCount + lastReplyAt, and upserts both followers', async () => {
    mockChannelMessagesFindFirst.mockResolvedValueOnce({
      id: 'parent-1',
      pageId: 'page-1',
      parentId: null,
      userId: 'user-parent',
      isActive: true,
    });
    const replyCreatedAt = new Date('2026-05-04T12:00:00Z');
    mockInsertReturning
      .mockResolvedValueOnce([
        { id: 'reply-1', createdAt: replyCreatedAt, parentId: 'parent-1' },
      ]);
    mockUpdateReturning.mockResolvedValueOnce([
      { replyCount: 1, lastReplyAt: replyCreatedAt },
    ]);

    const result = await channelMessageRepository.insertChannelThreadReply(baseInput);

    const replyValues = mockInsertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    const followerValues = mockInsertValues.mock.calls[1]?.[0] as Array<Record<string, unknown>>;
    const updateSet = mockUpdateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    assert({
      given: 'a happy-path thread reply with a distinct replier and parent author',
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

  it('dedupes followers when the parent author replies to their own thread (one follower row, not two)', async () => {
    mockChannelMessagesFindFirst.mockResolvedValueOnce({
      id: 'parent-1',
      pageId: 'page-1',
      parentId: null,
      userId: 'user-self',
      isActive: true,
    });
    mockInsertReturning.mockResolvedValueOnce([
      { id: 'reply-1', createdAt: new Date(), parentId: 'parent-1' },
    ]);
    mockUpdateReturning.mockResolvedValueOnce([
      { replyCount: 1, lastReplyAt: new Date() },
    ]);

    await channelMessageRepository.insertChannelThreadReply({
      ...baseInput,
      userId: 'user-self',
    });

    const followerValues = mockInsertValues.mock.calls[1]?.[0] as Array<Record<string, unknown>>;
    assert({
      given: 'a reply where the parent author and replier are the same user',
      should: 'send a single follower row to onConflictDoNothing — Postgres rejects duplicate rows in one INSERT even with ON CONFLICT',
      actual: followerValues,
      expected: [{ rootMessageId: 'parent-1', userId: 'user-self' }],
    });
  });

  it('writes a second top-level row with mirroredFromId set when alsoSendToParent is true', async () => {
    mockChannelMessagesFindFirst.mockResolvedValueOnce({
      id: 'parent-1',
      pageId: 'page-1',
      parentId: null,
      userId: 'user-parent',
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

    const result = await channelMessageRepository.insertChannelThreadReply({
      ...baseInput,
      alsoSendToParent: true,
    });

    // Three insert pipelines: 1) reply, 2) followers, 3) mirror top-level row.
    const insertCount = mockInsertValues.mock.calls.length;
    const mirrorValues = mockInsertValues.mock.calls[2]?.[0] as Record<string, unknown>;
    assert({
      given: 'an alsoSendToParent thread reply',
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

describe('channelMessageRepository.listChannelThreadReplies', () => {
  it('filters by parentId and asks for ascending order', async () => {
    mockChannelMessagesFindMany.mockResolvedValueOnce([]);

    await channelMessageRepository.listChannelThreadReplies({
      rootId: 'parent-1',
      limit: 50,
    });

    const eqCalls = vi.mocked(eq).mock.calls;
    const ascCalls = vi.mocked(asc).mock.calls;
    assert({
      given: 'a list-replies request for a thread root',
      should: 'WHERE parentId = root AND order ascending by (createdAt, id)',
      actual: {
        scopedToParent: eqCalls.some(
          ([field, value]) => field === channelMessages.parentId && value === 'parent-1'
        ),
        ascCount: ascCalls.length,
      },
      expected: { scopedToParent: true, ascCount: 2 },
    });
  });

  it('builds a strictly-greater-than composite cursor when after is supplied', async () => {
    mockChannelMessagesFindMany.mockResolvedValueOnce([]);
    const after = { createdAt: new Date('2026-05-04T12:00:00Z'), id: 'reply-cursor' };

    await channelMessageRepository.listChannelThreadReplies({
      rootId: 'parent-1',
      limit: 50,
      after,
    });

    const gtCalls = vi.mocked(gt).mock.calls;
    assert({
      given: 'an ascending-cursor pagination request',
      should: 'use gt() against both createdAt and id so the next page never re-emits the cursor row',
      actual: {
        createdAt: gtCalls.some(([field, value]) => field === channelMessages.createdAt && value === after.createdAt),
        id: gtCalls.some(([field, value]) => field === channelMessages.id && value === after.id),
      },
      expected: { createdAt: true, id: true },
    });
  });
});

describe('channelMessageRepository thread follower helpers', () => {
  it('addChannelThreadFollower inserts (rootId, userId) and uses onConflictDoNothing for idempotency', async () => {
    await channelMessageRepository.addChannelThreadFollower('root-1', 'user-1');

    const values = mockInsertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    assert({
      given: 'an explicit follower add',
      should: 'insert the (rootMessageId, userId) pair with onConflictDoNothing so a re-add is a no-op',
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

  it('removeChannelThreadFollower deletes scoped to (rootId, userId) — never another user', async () => {
    await channelMessageRepository.removeChannelThreadFollower('root-1', 'user-1');

    const eqCalls = vi.mocked(eq).mock.calls;
    assert({
      given: 'an explicit follower remove',
      should: 'WHERE on both rootMessageId AND userId so we never delete another user\'s follow row',
      actual: {
        scopedRoot: eqCalls.some(
          ([field, value]) => field === channelThreadFollowers.rootMessageId && value === 'root-1'
        ),
        scopedUser: eqCalls.some(
          ([field, value]) => field === channelThreadFollowers.userId && value === 'user-1'
        ),
      },
      expected: { scopedRoot: true, scopedUser: true },
    });
  });

  it('listChannelThreadFollowers returns a flat array of user ids — needed by inbox fanout', async () => {
    const fromWhere = vi.fn().mockResolvedValueOnce([
      { userId: 'user-a' },
      { userId: 'user-b' },
    ]);
    mockSelectFrom.mockReturnValueOnce({ where: fromWhere });

    const result = await channelMessageRepository.listChannelThreadFollowers('root-1');

    assert({
      given: 'a thread root with two followers',
      should: 'return a flat string[] of user ids — callers fan out inbox events without re-shaping',
      actual: result,
      expected: ['user-a', 'user-b'],
    });
  });
});

describe('channelMessageRepository.addChannelReaction', () => {
  it('writes (messageId, userId, emoji) verbatim and returns the inserted row', async () => {
    mockInsertReturning.mockResolvedValueOnce([{ id: 'reaction-1' }]);

    const result = await channelMessageRepository.addChannelReaction({
      messageId: 'msg-1',
      userId: 'user-1',
      emoji: '👍',
    });

    const values = mockInsertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    assert({
      given: 'a reaction add request',
      should: 'persist the triple (messageId, userId, emoji) and return the new row id',
      actual: { values, result },
      expected: {
        values: { messageId: 'msg-1', userId: 'user-1', emoji: '👍' },
        result: { id: 'reaction-1' },
      },
    });
  });
});

describe('channelMessageRepository.loadChannelReactionWithUser', () => {
  it('fetches the reaction with the user relation so broadcasts include name+id', async () => {
    mockReactionsFindFirst.mockResolvedValueOnce({ id: 'reaction-1', user: { id: 'u', name: 'n' } });

    await channelMessageRepository.loadChannelReactionWithUser('reaction-1');

    const call = mockReactionsFindFirst.mock.calls[0]?.[0] as {
      with: { user: { columns: Record<string, true> } };
    };
    assert({
      given: 'a freshly added reaction',
      should: 'load the user relation so the broadcast payload renders the actor without a re-fetch',
      actual: call.with.user.columns,
      expected: { id: true, name: true },
    });
  });
});

describe('channelMessageRepository.removeChannelReaction', () => {
  it('returns the count of rows actually removed so the route can 404 on no-op', async () => {
    mockDeleteReturning.mockResolvedValueOnce([]);

    const removed = await channelMessageRepository.removeChannelReaction({
      messageId: 'msg-1',
      userId: 'user-1',
      emoji: '👍',
    });

    assert({
      given: 'a delete that matched no rows',
      should: 'return 0 so the route can return 404 instead of pretending success',
      actual: removed,
      expected: 0,
    });
  });

  it('scopes the delete to (messageId, userId, emoji) — never deletes another user\'s reaction', async () => {
    mockDeleteReturning.mockResolvedValueOnce([{ id: 'reaction-1' }]);

    await channelMessageRepository.removeChannelReaction({
      messageId: 'msg-1',
      userId: 'user-1',
      emoji: '👍',
    });

    const eqCalls = vi.mocked(eq).mock.calls;
    const hasUserId = eqCalls.some(
      ([field, value]) => field === channelMessageReactions.userId && value === 'user-1'
    );
    const hasMessageId = eqCalls.some(
      ([field, value]) => field === channelMessageReactions.messageId && value === 'msg-1'
    );
    const hasEmoji = eqCalls.some(
      ([field, value]) => field === channelMessageReactions.emoji && value === '👍'
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
describe('channelMessageRepository surface', () => {
  it('exports the full set of functions the channel routes need today', () => {
    assert({
      given: 'the repository module',
      should: 'export the function set the channel routes call (top-level + reactions + threads)',
      actual: Object.keys(channelMessageRepository).sort(),
      expected: [
        'addChannelReaction',
        'addChannelThreadFollower',
        'fileExists',
        'findChannelMessageInPage',
        'insertChannelMessage',
        'insertChannelThreadReply',
        'listChannelMessages',
        'listChannelThreadFollowers',
        'listChannelThreadReplies',
        'loadChannelMessageWithRelations',
        'loadChannelReactionWithUser',
        'removeChannelReaction',
        'removeChannelThreadFollower',
        'restoreChannelMessage',
        'softDeleteChannelMessage',
        'updateChannelMessageContent',
        'upsertChannelReadStatus',
      ],
    });
  });
});

// Anchor: locks the parentId IS NULL semantics into the test suite even if the
// route refactor diverges in shape later. PR 3 will remove this filter only by
// changing the call signature to accept parentId — at which point this test
// must be deliberately updated.
describe('channelMessageRepository.listChannelMessages [thread-prep invariant]', () => {
  it('uses isNull(channelMessages.parentId) — not a different field — to scope to top-level', async () => {
    mockChannelMessagesFindMany.mockResolvedValue([]);

    await channelMessageRepository.listChannelMessages({ pageId: 'page-1', limit: 10 });

    assert({
      given: 'a top-level fetch (PR 1 semantics)',
      should: 'pass channelMessages.parentId to isNull — accidentally passing isActive or pageId would silently break thread isolation later',
      actual: vi.mocked(isNull).mock.calls.flat(),
      expected: [channelMessages.parentId],
    });
  });

  it('combines page filters with the parentId filter via and()', async () => {
    mockChannelMessagesFindMany.mockResolvedValue([]);

    await channelMessageRepository.listChannelMessages({ pageId: 'page-1', limit: 10 });

    assert({
      given: 'three top-level filters (pageId, isActive, parentId IS NULL)',
      should: 'compose them with and() — never with or()',
      actual: vi.mocked(and).mock.calls.length > 0,
      expected: true,
    });
  });
});

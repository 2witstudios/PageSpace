import { describe, it, expect, vi, beforeEach } from 'vitest';

// Boundary-level test double: see test-doubles/db.ts for the design rationale
// (no thenable Drizzle chain mocks; assertions read observable state, not the
// order of intermediate builder method calls).
import { testDbState } from './test-doubles/db';

vi.mock('@pagespace/db/db', async () => {
  const m = await import('./test-doubles/db');
  return { db: m.testDb };
});
vi.mock('@pagespace/db/operators', async () => {
  const m = await import('./test-doubles/db');
  return m.operators;
});
vi.mock('@pagespace/db/schema/chat', async () => {
  const m = await import('./test-doubles/db');
  return m.chatSchema;
});
vi.mock('@pagespace/db/schema/social', async () => {
  const m = await import('./test-doubles/db');
  return m.socialSchema;
});
vi.mock('@pagespace/db/schema/storage', async () => {
  const m = await import('./test-doubles/db');
  return m.storageSchema;
});

import { channelMessageRepository } from '../channel-message-repository';

interface AssertParams {
  given: string;
  should: string;
  actual: unknown;
  expected: unknown;
}

const assert = ({ given, should, actual, expected }: AssertParams): void => {
  expect(actual, `Given ${given}, should ${should}`).toEqual(expected);
};

beforeEach(() => {
  testDbState.reset();
});

describe('channelMessageRepository.listChannelMessages', () => {
  it('filters out replies by requiring parentId IS NULL', async () => {
    testDbState.seed('channelMessages', [
      { id: 'top-a', pageId: 'page-1', userId: 'u-1', content: 'a', isActive: true, parentId: null, createdAt: new Date('2026-05-01T00:00:00Z') },
      { id: 'reply-a', pageId: 'page-1', userId: 'u-1', content: 'reply', isActive: true, parentId: 'top-a', createdAt: new Date('2026-05-01T00:01:00Z') },
      { id: 'top-b', pageId: 'page-1', userId: 'u-1', content: 'b', isActive: true, parentId: null, createdAt: new Date('2026-05-01T00:02:00Z') },
    ]);

    const rows = await channelMessageRepository.listChannelMessages({ pageId: 'page-1', limit: 10 });

    assert({
      given: 'a top-level message fetch on a page that has both top-level rows and a thread reply',
      should: 'omit the reply — only top-level rows leak into the main stream',
      actual: rows.map((r) => r.id).sort(),
      expected: ['top-a', 'top-b'],
    });
  });

  it('omits the cursor branch when no cursor is supplied', async () => {
    const earliest = new Date('2026-05-01T00:00:00Z');
    const middle = new Date('2026-05-01T00:01:00Z');
    const latest = new Date('2026-05-01T00:02:00Z');
    testDbState.seed('channelMessages', [
      { id: 'a', pageId: 'page-1', isActive: true, parentId: null, createdAt: earliest },
      { id: 'b', pageId: 'page-1', isActive: true, parentId: null, createdAt: middle },
      { id: 'c', pageId: 'page-1', isActive: true, parentId: null, createdAt: latest },
    ]);

    const rows = await channelMessageRepository.listChannelMessages({ pageId: 'page-1', limit: 10 });

    assert({
      given: 'a list call without a cursor',
      should: 'return every active top-level row newest-first — no cursor exclusion is applied',
      actual: rows.map((r) => r.id),
      expected: ['c', 'b', 'a'],
    });
  });

  it('builds a composite cursor disjunction when cursor is supplied', async () => {
    const t = new Date('2026-05-01T12:00:00Z');
    const tBefore = new Date('2026-05-01T11:59:00Z');
    const tAfter = new Date('2026-05-01T12:01:00Z');
    testDbState.seed('channelMessages', [
      // Same createdAt as the cursor row — id ordering is the tiebreaker.
      { id: 'tie-before', pageId: 'page-1', isActive: true, parentId: null, createdAt: t },
      { id: 'tie-cursor', pageId: 'page-1', isActive: true, parentId: null, createdAt: t },
      { id: 'tie-zafter', pageId: 'page-1', isActive: true, parentId: null, createdAt: t },
      // Strictly older row — should be returned by the cursor.
      { id: 'older', pageId: 'page-1', isActive: true, parentId: null, createdAt: tBefore },
      // Strictly newer row — should be excluded.
      { id: 'newer', pageId: 'page-1', isActive: true, parentId: null, createdAt: tAfter },
    ]);

    const rows = await channelMessageRepository.listChannelMessages({
      pageId: 'page-1',
      limit: 10,
      cursor: { createdAt: t, id: 'tie-cursor' },
    });

    assert({
      given: 'a composite cursor (createdAt, id) at the tie row',
      should: 'return rows strictly older by createdAt OR same-createdAt with strictly smaller id — never the cursor row, never anything newer',
      actual: rows.map((r) => r.id).sort(),
      expected: ['older', 'tie-before'],
    });
  });

  it('passes the supplied limit through unchanged so the route can fetch limit+1 for hasMore', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `m-${i}`,
      pageId: 'page-1',
      isActive: true,
      parentId: null,
      createdAt: new Date(2026, 4, 1, 12, i),
    }));
    testDbState.seed('channelMessages', rows);

    const result = await channelMessageRepository.listChannelMessages({ pageId: 'page-1', limit: 3 });

    assert({
      given: 'a limit value chosen by the route',
      should: 'forward it verbatim — return at most that many rows',
      actual: result.length,
      expected: 3,
    });
  });
});

describe('channelMessageRepository.findChannelMessageInPage', () => {
  it('scopes the lookup to a single page', async () => {
    testDbState.seed('channelMessages', [
      { id: 'msg-1', pageId: 'page-1', isActive: true, content: 'hi' },
      { id: 'msg-1-other', pageId: 'page-other', isActive: true, content: 'leak' },
    ]);

    const result = await channelMessageRepository.findChannelMessageInPage({ messageId: 'msg-1', pageId: 'page-1' });

    assert({
      given: 'a (messageId, pageId) tuple',
      should: 'return the row from the requested page only — never the other page row, even with the same id',
      actual: result?.pageId,
      expected: 'page-1',
    });
  });

  it('returns null when the message belongs to a different page', async () => {
    testDbState.seed('channelMessages', [
      { id: 'msg-1', pageId: 'page-1', isActive: true, content: 'hi' },
    ]);

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
    testDbState.seed('users', [
      { id: 'u-1', name: 'Alice', image: '/avatar.png' },
      { id: 'u-2', name: 'Bob' },
    ]);
    testDbState.seed('files', [
      { id: 'file-1', mimeType: 'image/png', sizeBytes: 1024 },
    ]);
    testDbState.seed('channelMessages', [
      { id: 'msg-1', pageId: 'page-1', userId: 'u-1', fileId: 'file-1', isActive: true, content: 'hi' },
    ]);
    testDbState.seed('channelMessageReactions', [
      { id: 'rx-1', messageId: 'msg-1', userId: 'u-2', emoji: '👍' },
    ]);

    const result = await channelMessageRepository.loadChannelMessageWithRelations('msg-1');

    assert({
      given: 'a freshly created message id with linked user/file/reactor',
      should: 'load all three relations so the broadcast payload renders without a re-fetch',
      actual: {
        userId: (result?.user as { id: string } | null)?.id,
        fileId: (result?.file as { id: string } | null)?.id,
        reactionUser: (result?.reactions as Array<{ user: { name: string } }> | undefined)?.[0]?.user?.name,
      },
      expected: { userId: 'u-1', fileId: 'file-1', reactionUser: 'Bob' },
    });
  });
});

describe('channelMessageRepository.fileExists', () => {
  it('returns true when the file row is present', async () => {
    testDbState.seed('files', [{ id: 'file-1', mimeType: 'image/png' }]);

    const result = await channelMessageRepository.fileExists('file-1');

    assert({
      given: 'an attachment id that resolves to a file row',
      should: 'return true so the route accepts the upload',
      actual: result,
      expected: true,
    });
  });

  it('returns false when the file row is missing', async () => {
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
    await channelMessageRepository.insertChannelMessage({
      pageId: 'page-1',
      userId: 'user-1',
      content: 'hello',
      fileId: 'file-1',
      attachmentMeta: { kind: 'image' } as never,
    });

    const inserted = testDbState.rows('channelMessages')[0];
    assert({
      given: 'an insert request with all fields populated',
      should: 'persist each field unchanged — the repository does not normalize input',
      actual: {
        pageId: inserted.pageId,
        userId: inserted.userId,
        content: inserted.content,
        fileId: inserted.fileId,
        attachmentMeta: inserted.attachmentMeta,
      },
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
    await channelMessageRepository.insertChannelMessage({
      pageId: 'page-1',
      userId: 'user-1',
      content: 'plain text',
      fileId: null,
      attachmentMeta: null,
    });

    const inserted = testDbState.rows('channelMessages')[0];
    assert({
      given: 'a text-only message',
      should: 'insert NULL into fileId and attachmentMeta rather than dropping the columns',
      actual: { fileId: inserted.fileId, attachmentMeta: inserted.attachmentMeta },
      expected: { fileId: null, attachmentMeta: null },
    });
  });

  it('persists an explicit quotedMessageId on the row when provided', async () => {
    await channelMessageRepository.insertChannelMessage({
      pageId: 'page-1',
      userId: 'user-1',
      content: 'inline quote reply',
      fileId: null,
      attachmentMeta: null,
      quotedMessageId: 'quoted-msg-1',
    });

    const inserted = testDbState.rows('channelMessages')[0];
    assert({
      given: 'an insert request with quotedMessageId set',
      should: 'forward the value verbatim so the new row links to the quoted source',
      actual: inserted.quotedMessageId,
      expected: 'quoted-msg-1',
    });
  });

  it('persists null quotedMessageId when the caller omits the field', async () => {
    await channelMessageRepository.insertChannelMessage({
      pageId: 'page-1',
      userId: 'user-1',
      content: 'plain top-level message',
      fileId: null,
      attachmentMeta: null,
    });

    const inserted = testDbState.rows('channelMessages')[0];
    assert({
      given: 'a top-level message with no quote context',
      should: 'still write the column as null rather than dropping it from the payload',
      actual: inserted.quotedMessageId,
      expected: null,
    });
  });
});

describe('channelMessageRepository.upsertChannelReadStatus', () => {
  it('upserts on (userId, channelId) so a sender-reads-own-message write is idempotent', async () => {
    const earlier = new Date('2026-05-04T11:00:00Z');
    const later = new Date('2026-05-04T12:00:00Z');

    await channelMessageRepository.upsertChannelReadStatus({
      userId: 'user-1',
      channelId: 'page-1',
      readAt: earlier,
    });
    await channelMessageRepository.upsertChannelReadStatus({
      userId: 'user-1',
      channelId: 'page-1',
      readAt: later,
    });

    const rows = testDbState.rows('channelReadStatus');
    assert({
      given: 'two read-status writes for the same (userId, channelId)',
      should: 'collapse to one row, with lastReadAt updated to the later timestamp',
      actual: { rowCount: rows.length, lastReadAt: rows[0]?.lastReadAt },
      expected: { rowCount: 1, lastReadAt: later },
    });
  });
});

describe('channelMessageRepository.updateChannelMessageContent', () => {
  it('writes content + editedAt and scopes the update to the message id', async () => {
    const editedAt = new Date('2026-05-04T13:00:00Z');
    testDbState.seed('channelMessages', [
      { id: 'msg-1', pageId: 'page-1', userId: 'u-1', content: 'orig', isActive: true, editedAt: null },
      { id: 'msg-2', pageId: 'page-1', userId: 'u-1', content: 'untouched', isActive: true, editedAt: null },
    ]);

    await channelMessageRepository.updateChannelMessageContent({
      messageId: 'msg-1',
      content: 'edited',
      editedAt,
    });

    const rows = testDbState.rows('channelMessages');
    assert({
      given: 'an edit request',
      should: 'set both content and editedAt on the targeted row only — the other row is untouched',
      actual: {
        target: rows.find((r) => r.id === 'msg-1'),
        other: rows.find((r) => r.id === 'msg-2'),
      },
      expected: {
        target: expect.objectContaining({ content: 'edited', editedAt }),
        other: expect.objectContaining({ content: 'untouched', editedAt: null }),
      },
    });
  });
});

describe('channelMessageRepository.softDeleteChannelMessage', () => {
  it('flips isActive=false and returns 1 row affected for a fresh delete', async () => {
    testDbState.seed('channelMessages', [
      { id: 'msg-1', pageId: 'page-1', isActive: true, parentId: null, replyCount: 0 },
    ]);

    const count = await channelMessageRepository.softDeleteChannelMessage('msg-1');

    const rows = testDbState.rows('channelMessages');
    assert({
      given: 'a delete request for a top-level message',
      should: 'set isActive=false on the targeted row and return 1 row affected so the route can audit + broadcast',
      actual: { isActive: rows[0].isActive, count },
      expected: { isActive: false, count: 1 },
    });
  });

  it('returns 0 affected rows on a double soft-delete (idempotency guard for routes)', async () => {
    testDbState.seed('channelMessages', [
      { id: 'msg-1', pageId: 'page-1', isActive: false, parentId: null, replyCount: 0 },
    ]);

    const count = await channelMessageRepository.softDeleteChannelMessage('msg-1');

    assert({
      given: 'a soft-delete of an already-inactive message',
      should: 'return 0 so the route can 404 instead of re-broadcasting message_deleted',
      actual: count,
      expected: 0,
    });
  });

  it('decrements the parent replyCount when the soft-deleted row is a thread reply, scoped to the returned parentId', async () => {
    testDbState.seed('channelMessages', [
      { id: 'parent-1', pageId: 'page-1', isActive: true, parentId: null, replyCount: 3 },
      { id: 'sibling-parent', pageId: 'page-1', isActive: true, parentId: null, replyCount: 5 },
      { id: 'reply-1', pageId: 'page-1', isActive: true, parentId: 'parent-1', replyCount: 0 },
    ]);

    await channelMessageRepository.softDeleteChannelMessage('reply-1');

    const rows = testDbState.rows('channelMessages');
    assert({
      given: 'a soft-delete of a thread reply',
      should: 'decrement the targeted parent.replyCount by exactly 1, never touch sibling parents, and tombstone the reply',
      actual: {
        parent: rows.find((r) => r.id === 'parent-1')?.replyCount,
        sibling: rows.find((r) => r.id === 'sibling-parent')?.replyCount,
        replyActive: rows.find((r) => r.id === 'reply-1')?.isActive,
      },
      expected: { parent: 2, sibling: 5, replyActive: false },
    });
  });

  it('does NOT issue a parent-counter update when the row is top-level (parentId is null)', async () => {
    testDbState.seed('channelMessages', [
      { id: 'top-1', pageId: 'page-1', isActive: true, parentId: null, replyCount: 7 },
    ]);

    await channelMessageRepository.softDeleteChannelMessage('top-1');

    const rows = testDbState.rows('channelMessages');
    assert({
      given: 'a soft-delete of a top-level message (parentId IS NULL)',
      should: 'flip isActive but never touch its own replyCount or any other row',
      actual: { isActive: rows[0].isActive, replyCount: rows[0].replyCount, count: rows.length },
      expected: { isActive: false, replyCount: 7, count: 1 },
    });
  });
});

describe('channelMessageRepository.restoreChannelMessage', () => {
  it('flips isActive=true when restoring a row and returns 1 row affected', async () => {
    testDbState.seed('channelMessages', [
      { id: 'msg-1', pageId: 'page-1', isActive: false, parentId: null, replyCount: 0 },
    ]);

    const count = await channelMessageRepository.restoreChannelMessage('msg-1');

    const rows = testDbState.rows('channelMessages');
    assert({
      given: 'a restore request for a tombstoned top-level row',
      should: 'flip isActive back to true on the targeted row and return 1',
      actual: { isActive: rows[0].isActive, count },
      expected: { isActive: true, count: 1 },
    });
  });

  it('increments the parent replyCount when the restored row is a thread reply AND the parent is still active', async () => {
    testDbState.seed('channelMessages', [
      { id: 'parent-1', pageId: 'page-1', isActive: true, parentId: null, replyCount: 1 },
      { id: 'reply-1', pageId: 'page-1', isActive: false, parentId: 'parent-1', replyCount: 0 },
    ]);

    const count = await channelMessageRepository.restoreChannelMessage('reply-1');

    const rows = testDbState.rows('channelMessages');
    assert({
      given: 'a restore of a thread reply whose parent is still active',
      should: 'restore the reply and bump the active parent.replyCount by 1',
      actual: {
        count,
        replyActive: rows.find((r) => r.id === 'reply-1')?.isActive,
        parentReplyCount: rows.find((r) => r.id === 'parent-1')?.replyCount,
      },
      expected: { count: 1, replyActive: true, parentReplyCount: 2 },
    });
  });

  it('does NOT increment the parent counter when the parent has been soft-deleted in the meantime, but still returns 1 row restored', async () => {
    testDbState.seed('channelMessages', [
      { id: 'parent-1', pageId: 'page-1', isActive: false, parentId: null, replyCount: 5 },
      { id: 'reply-1', pageId: 'page-1', isActive: false, parentId: 'parent-1', replyCount: 0 },
    ]);

    const count = await channelMessageRepository.restoreChannelMessage('reply-1');

    const rows = testDbState.rows('channelMessages');
    assert({
      given: 'a restore of a thread reply whose parent is itself soft-deleted',
      should: 'restore the reply but leave the tombstoned parent counter untouched (so a future parent restore does not over-count)',
      actual: {
        count,
        replyActive: rows.find((r) => r.id === 'reply-1')?.isActive,
        parentReplyCount: rows.find((r) => r.id === 'parent-1')?.replyCount,
      },
      expected: { count: 1, replyActive: true, parentReplyCount: 5 },
    });
  });

  it('locks the parent row for the duration of the restore tx (SELECT ... FOR UPDATE) so a concurrent soft-delete cannot race the bump', async () => {
    testDbState.seed('channelMessages', [
      { id: 'parent-1', pageId: 'page-1', isActive: true, parentId: null, replyCount: 1 },
      { id: 'reply-1', pageId: 'page-1', isActive: false, parentId: 'parent-1', replyCount: 0 },
    ]);

    await channelMessageRepository.restoreChannelMessage('reply-1');

    assert({
      given: 'a restore of a thread reply whose parent must be re-validated under lock',
      should: 'invoke .for("update") against channelMessages exactly once — the lock blocks a concurrent softDelete until the bump commits',
      actual: testDbState.selectsForUpdate('channelMessages').length,
      expected: 1,
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

  const seedActiveParent = (overrides: Partial<Record<string, unknown>> = {}) => {
    testDbState.seed('channelMessages', [
      {
        id: 'parent-1',
        pageId: 'page-1',
        userId: 'user-parent',
        parentId: null,
        isActive: true,
        replyCount: 0,
        ...overrides,
      },
    ]);
  };

  it('locks the parent row for the duration of the tx (SELECT ... FOR UPDATE) so a concurrent soft-delete cannot orphan the reply', async () => {
    seedActiveParent();

    await channelMessageRepository.insertChannelThreadReply(baseInput);

    assert({
      given: 'a parent validation read inside the insert tx',
      should: 'invoke .for("update") against channelMessages exactly once — the lock blocks a concurrent softDelete until this tx commits',
      actual: testDbState.selectsForUpdate('channelMessages').length,
      expected: 1,
    });
  });

  it('rejects with parent_not_found when the parent row is missing', async () => {
    const result = await channelMessageRepository.insertChannelThreadReply(baseInput);

    assert({
      given: 'a parent id that does not resolve to any row',
      should: 'return parent_not_found WITHOUT inserting a reply or follower row',
      actual: {
        kind: result.kind,
        replyCount: testDbState.count('channelMessages'),
        followerCount: testDbState.count('channelThreadFollowers'),
      },
      expected: { kind: 'parent_not_found', replyCount: 0, followerCount: 0 },
    });
  });

  it('rejects with parent_not_found when the parent row exists but is soft-deleted (isActive=false)', async () => {
    seedActiveParent({ isActive: false });

    const result = await channelMessageRepository.insertChannelThreadReply(baseInput);

    assert({
      given: 'a parent that has been soft-deleted',
      should: 'return parent_not_found — clients cannot reply into a tombstoned thread',
      actual: {
        kind: result.kind,
        // The seeded parent stays the only row — no reply was added.
        rowCount: testDbState.count('channelMessages'),
      },
      expected: { kind: 'parent_not_found', rowCount: 1 },
    });
  });

  it('rejects with parent_wrong_page when the parent belongs to a different channel', async () => {
    seedActiveParent({ pageId: 'other-page' });

    const result = await channelMessageRepository.insertChannelThreadReply(baseInput);

    assert({
      given: 'a parent id whose pageId differs from the request page',
      should: 'return parent_wrong_page so the route can 400 — never insert a reply scoped to the wrong channel',
      actual: { kind: result.kind, rowCount: testDbState.count('channelMessages') },
      expected: { kind: 'parent_wrong_page', rowCount: 1 },
    });
  });

  it('rejects with parent_not_top_level when the parent itself has parentId set (depth-2 attempt)', async () => {
    seedActiveParent({ parentId: 'grandparent' });

    const result = await channelMessageRepository.insertChannelThreadReply(baseInput);

    assert({
      given: 'a parent that is itself a thread reply',
      should: 'return parent_not_top_level — threads are exactly one level deep',
      actual: { kind: result.kind, rowCount: testDbState.count('channelMessages') },
      expected: { kind: 'parent_not_top_level', rowCount: 1 },
    });
  });

  it('inserts the reply with parentId set, bumps replyCount + lastReplyAt, and upserts both followers', async () => {
    seedActiveParent();

    const result = await channelMessageRepository.insertChannelThreadReply(baseInput);

    const messages = testDbState.rows('channelMessages');
    const followers = testDbState.rows('channelThreadFollowers');
    const reply = messages.find((r) => r.parentId === 'parent-1');
    const parent = messages.find((r) => r.id === 'parent-1');
    assert({
      given: 'a happy-path thread reply with a distinct replier and parent author',
      should: 'insert the reply with parentId=parent, bump parent.replyCount, set lastReplyAt, and add a follower row for both the parent author and the replier',
      actual: {
        kind: result.kind,
        replyParentId: reply?.parentId,
        parentReplyCount: parent?.replyCount,
        parentLastReplyAt: parent?.lastReplyAt,
        followerUserIds: followers.map((f) => f.userId).sort(),
      },
      expected: {
        kind: 'ok',
        replyParentId: 'parent-1',
        parentReplyCount: 1,
        parentLastReplyAt: reply?.createdAt,
        followerUserIds: ['user-parent', 'user-replier'],
      },
    });
  });

  it('writes a second top-level row with mirroredFromId set when alsoSendToParent is true', async () => {
    seedActiveParent();

    const result = await channelMessageRepository.insertChannelThreadReply({
      ...baseInput,
      alsoSendToParent: true,
    });

    const messages = testDbState.rows('channelMessages');
    const reply = messages.find((r) => r.parentId === 'parent-1');
    const mirror = messages.find((r) => r.mirroredFromId === reply?.id);
    assert({
      given: 'an alsoSendToParent thread reply',
      should: 'write a second top-level row (parentId IS NULL) with mirroredFromId pointing at the reply',
      actual: {
        kind: result.kind,
        // Parent + reply + mirror.
        rowCount: messages.length,
        mirrorParentId: mirror?.parentId,
        mirrorMirroredFromId: mirror?.mirroredFromId,
        resultMirrorId: result.kind === 'ok' ? result.mirror?.id : null,
      },
      expected: {
        kind: 'ok',
        rowCount: 3,
        mirrorParentId: null,
        mirrorMirroredFromId: reply?.id,
        resultMirrorId: mirror?.id,
      },
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases (PR 6b — added per audit findings)
  // -------------------------------------------------------------------------

  it('upserts exactly two follower rows for a reply with distinct parent author and replier', async () => {
    seedActiveParent();

    await channelMessageRepository.insertChannelThreadReply(baseInput);

    const followers = testDbState.rows('channelThreadFollowers');
    assert({
      given: 'a thread reply where the parent author and the replier are different users',
      should: 'leave exactly two rows in channelThreadFollowers, one for each — and both keyed to the root',
      actual: {
        rowCount: followers.length,
        rows: followers
          .map((f) => ({ rootMessageId: f.rootMessageId, userId: f.userId }))
          .sort((a, b) => String(a.userId).localeCompare(String(b.userId))),
      },
      expected: {
        rowCount: 2,
        rows: [
          { rootMessageId: 'parent-1', userId: 'user-parent' },
          { rootMessageId: 'parent-1', userId: 'user-replier' },
        ],
      },
    });
  });

  it('upserts exactly one follower row when the parent author replies to their own thread (self-reply dedup)', async () => {
    seedActiveParent({ userId: 'user-self' });

    await channelMessageRepository.insertChannelThreadReply({
      ...baseInput,
      userId: 'user-self',
    });

    const followers = testDbState.rows('channelThreadFollowers');
    assert({
      given: 'a thread reply where the parent author and the replier are the same user',
      should: 'collapse to a single follower row — the impl dedupes before INSERT to avoid Postgres rejecting two identical rows under onConflictDoNothing',
      actual: followers.map((f) => ({ rootMessageId: f.rootMessageId, userId: f.userId })),
      expected: [{ rootMessageId: 'parent-1', userId: 'user-self' }],
    });
  });

  it('rolls the entire transaction back when the follower upsert step throws — no reply, no follower, parent counter unchanged', async () => {
    const seededLastReplyAt = new Date('2026-04-01T00:00:00Z');
    seedActiveParent({ replyCount: 7, lastReplyAt: seededLastReplyAt });
    testDbState.failBefore('insert', 'channelThreadFollowers');

    await expect(
      channelMessageRepository.insertChannelThreadReply(baseInput)
    ).rejects.toThrow();

    const messages = testDbState.rows('channelMessages');
    const followers = testDbState.rows('channelThreadFollowers');
    const parent = messages.find((r) => r.id === 'parent-1');
    assert({
      given: 'an insertChannelThreadReply call where the follower upsert step fails inside the transaction',
      should: 'roll back the reply insert AND the parent.replyCount + lastReplyAt bumps — only the seeded parent remains, every counter as-seeded, no followers',
      actual: {
        rowCount: messages.length,
        parentReplyCount: parent?.replyCount,
        parentLastReplyAt: parent?.lastReplyAt,
        followerCount: followers.length,
      },
      expected: {
        rowCount: 1,
        parentReplyCount: 7,
        parentLastReplyAt: seededLastReplyAt,
        followerCount: 0,
      },
    });
  });

  it('rolls the entire transaction back when alsoSendToParent mirror-insert throws — reply rolled back, no mirror, parent counter unchanged', async () => {
    seedActiveParent({ replyCount: 4 });
    // The reply is the first channelMessages insert; the mirror is the second
    // (after the followers insert hits channelThreadFollowers). Skip the first
    // and fail the second so we exercise the rollback after a successful reply
    // write.
    testDbState.failBefore('insert', 'channelMessages', { skip: 1 });

    await expect(
      channelMessageRepository.insertChannelThreadReply({
        ...baseInput,
        alsoSendToParent: true,
      })
    ).rejects.toThrow();

    const messages = testDbState.rows('channelMessages');
    const followers = testDbState.rows('channelThreadFollowers');
    const parent = messages.find((r) => r.id === 'parent-1');
    assert({
      given: 'an alsoSendToParent reply where the mirror insert step throws inside the transaction',
      should: 'roll back EVERY write — no thread reply, no mirror, no follower rows, parent counter exactly as seeded',
      actual: {
        rowCount: messages.length,
        parentReplyCount: parent?.replyCount,
        followerCount: followers.length,
      },
      expected: { rowCount: 1, parentReplyCount: 4, followerCount: 0 },
    });
  });

  it('soft-deleting a reply decrements parent.replyCount; restoring it (parent still active) increments it back', async () => {
    seedActiveParent({ replyCount: 3 });
    testDbState.seed('channelMessages', [
      { id: 'reply-1', pageId: 'page-1', userId: 'user-replier', parentId: 'parent-1', isActive: true, replyCount: 0 },
    ]);

    await channelMessageRepository.softDeleteChannelMessage('reply-1');
    const afterDelete = testDbState.rows('channelMessages').find((r) => r.id === 'parent-1')?.replyCount;
    await channelMessageRepository.restoreChannelMessage('reply-1');
    const afterRestore = testDbState.rows('channelMessages').find((r) => r.id === 'parent-1')?.replyCount;

    assert({
      given: 'a parent with replyCount=3 and an active reply, then a soft-delete followed by a restore',
      should: 'decrement parent.replyCount to 2 on delete, then increment back to 3 on restore (parent stays active)',
      actual: { afterDelete, afterRestore },
      expected: { afterDelete: 2, afterRestore: 3 },
    });
  });

  it('restoring a reply when the parent itself has been soft-deleted in the meantime does NOT bump the tombstoned parent counter', async () => {
    // Parent active with 3 replies. Soft-delete a reply (parent → 2). Then
    // soft-delete the parent (parent stays at 2 internally, but tombstoned).
    // Restoring the reply should NOT bump the tombstoned parent's counter
    // back to 3 — see channel-message-repository.ts:213-247 for the FOR UPDATE
    // rationale.
    testDbState.seed('channelMessages', [
      { id: 'parent-1', pageId: 'page-1', userId: 'user-parent', parentId: null, isActive: true, replyCount: 2 },
      { id: 'reply-1', pageId: 'page-1', userId: 'user-replier', parentId: 'parent-1', isActive: false, replyCount: 0 },
    ]);
    // Now soft-delete the parent so it is itself tombstoned.
    await channelMessageRepository.softDeleteChannelMessage('parent-1');
    const parentBeforeRestore = testDbState.rows('channelMessages').find((r) => r.id === 'parent-1');
    expect(parentBeforeRestore?.isActive).toBe(false);

    await channelMessageRepository.restoreChannelMessage('reply-1');

    const rows = testDbState.rows('channelMessages');
    const parent = rows.find((r) => r.id === 'parent-1');
    const reply = rows.find((r) => r.id === 'reply-1');
    assert({
      given: 'a restore of a reply whose parent has been soft-deleted in the meantime',
      should: 'restore the reply (isActive=true) but leave the tombstoned parent.replyCount exactly where it was',
      actual: {
        replyActive: reply?.isActive,
        parentActive: parent?.isActive,
        parentReplyCount: parent?.replyCount,
      },
      expected: { replyActive: true, parentActive: false, parentReplyCount: 2 },
    });
  });
});

describe('channelMessageRepository.listChannelThreadReplies', () => {
  it('filters by parentId and isActive=true and returns rows ascending by (createdAt, id)', async () => {
    const t0 = new Date('2026-05-04T12:00:00Z');
    const t1 = new Date('2026-05-04T12:01:00Z');
    const t2 = new Date('2026-05-04T12:02:00Z');
    testDbState.seed('channelMessages', [
      { id: 'parent-1', pageId: 'page-1', isActive: true, parentId: null },
      { id: 'r-3', pageId: 'page-1', isActive: true, parentId: 'parent-1', createdAt: t2 },
      { id: 'r-1', pageId: 'page-1', isActive: true, parentId: 'parent-1', createdAt: t0 },
      { id: 'r-2', pageId: 'page-1', isActive: true, parentId: 'parent-1', createdAt: t1 },
      { id: 'r-deleted', pageId: 'page-1', isActive: false, parentId: 'parent-1', createdAt: t1 },
      { id: 'other-parent-reply', pageId: 'page-1', isActive: true, parentId: 'other', createdAt: t1 },
    ]);

    const result = await channelMessageRepository.listChannelThreadReplies({ rootId: 'parent-1', limit: 50 });

    assert({
      given: 'a list-replies request for a thread root with active+deleted replies and an unrelated reply on another parent',
      should: 'return only the parent-1 active replies, ordered ascending by (createdAt, id)',
      actual: result.map((r) => r.id),
      expected: ['r-1', 'r-2', 'r-3'],
    });
  });

  it('builds a strictly-greater-than composite cursor when after is supplied', async () => {
    const t0 = new Date('2026-05-04T12:00:00Z');
    const t1 = new Date('2026-05-04T12:01:00Z');
    testDbState.seed('channelMessages', [
      { id: 'r-1', pageId: 'page-1', isActive: true, parentId: 'parent-1', createdAt: t0 },
      { id: 'r-2-cursor', pageId: 'page-1', isActive: true, parentId: 'parent-1', createdAt: t1 },
      { id: 'r-3', pageId: 'page-1', isActive: true, parentId: 'parent-1', createdAt: t1 },
      { id: 'r-4', pageId: 'page-1', isActive: true, parentId: 'parent-1', createdAt: new Date('2026-05-04T12:02:00Z') },
    ]);

    const result = await channelMessageRepository.listChannelThreadReplies({
      rootId: 'parent-1',
      limit: 50,
      after: { createdAt: t1, id: 'r-2-cursor' },
    });

    assert({
      given: 'an ascending-cursor pagination request at (t1, r-2-cursor)',
      should: 'return rows strictly newer by createdAt OR same-createdAt with strictly larger id — never the cursor row, never anything older',
      actual: result.map((r) => r.id).sort(),
      expected: ['r-3', 'r-4'],
    });
  });
});

describe('channelMessageRepository thread follower helpers', () => {
  it('addChannelThreadFollower inserts (rootId, userId) and is idempotent under a re-add', async () => {
    await channelMessageRepository.addChannelThreadFollower('root-1', 'user-1');
    await channelMessageRepository.addChannelThreadFollower('root-1', 'user-1');

    const rows = testDbState.rows('channelThreadFollowers');
    assert({
      given: 'two adds of the same (rootId, userId)',
      should: 'persist exactly one row — onConflictDoNothing makes the second add a no-op',
      actual: rows.map((r) => ({ rootMessageId: r.rootMessageId, userId: r.userId })),
      expected: [{ rootMessageId: 'root-1', userId: 'user-1' }],
    });
  });

  it('removeChannelThreadFollower deletes scoped to (rootId, userId) — never another user', async () => {
    testDbState.seed('channelThreadFollowers', [
      { rootMessageId: 'root-1', userId: 'user-1' },
      { rootMessageId: 'root-1', userId: 'user-other' },
      { rootMessageId: 'root-other', userId: 'user-1' },
    ]);

    await channelMessageRepository.removeChannelThreadFollower('root-1', 'user-1');

    const remaining = testDbState
      .rows('channelThreadFollowers')
      .map((r) => `${r.rootMessageId}:${r.userId}`)
      .sort();
    assert({
      given: 'a remove of (root-1, user-1) when other follower rows exist',
      should: 'delete only the matching tuple — leave (root-1, user-other) and (root-other, user-1) intact',
      actual: remaining,
      expected: ['root-1:user-other', 'root-other:user-1'],
    });
  });

  it('listChannelThreadFollowers returns a flat array of user ids — needed by inbox fanout', async () => {
    testDbState.seed('channelThreadFollowers', [
      { rootMessageId: 'root-1', userId: 'user-a' },
      { rootMessageId: 'root-1', userId: 'user-b' },
      { rootMessageId: 'root-other', userId: 'user-c' },
    ]);

    const result = await channelMessageRepository.listChannelThreadFollowers('root-1');

    assert({
      given: 'a thread root with two followers and an unrelated follower on another root',
      should: 'return a flat string[] of user ids scoped to the requested root only',
      actual: result.sort(),
      expected: ['user-a', 'user-b'],
    });
  });
});

describe('channelMessageRepository.addChannelReaction', () => {
  it('writes (messageId, userId, emoji) verbatim and returns the inserted row', async () => {
    const result = await channelMessageRepository.addChannelReaction({
      messageId: 'msg-1',
      userId: 'user-1',
      emoji: '👍',
    });

    const rows = testDbState.rows('channelMessageReactions');
    assert({
      given: 'a reaction add request',
      should: 'persist the triple (messageId, userId, emoji) and return the inserted row',
      actual: {
        rowCount: rows.length,
        persisted: { messageId: rows[0].messageId, userId: rows[0].userId, emoji: rows[0].emoji },
        returned: { messageId: result.messageId, userId: result.userId, emoji: result.emoji },
      },
      expected: {
        rowCount: 1,
        persisted: { messageId: 'msg-1', userId: 'user-1', emoji: '👍' },
        returned: { messageId: 'msg-1', userId: 'user-1', emoji: '👍' },
      },
    });
  });
});

describe('channelMessageRepository.loadChannelReactionWithUser', () => {
  it('fetches the reaction with the user relation so broadcasts include name+id', async () => {
    testDbState.seed('users', [{ id: 'u-1', name: 'Alice' }]);
    testDbState.seed('channelMessageReactions', [
      { id: 'rx-1', messageId: 'msg-1', userId: 'u-1', emoji: '👍' },
    ]);

    const result = await channelMessageRepository.loadChannelReactionWithUser('rx-1');

    assert({
      given: 'a freshly added reaction',
      should: 'load the user relation so the broadcast payload renders the actor without a re-fetch',
      actual: (result?.user as { id: string; name: string } | null),
      expected: { id: 'u-1', name: 'Alice' },
    });
  });
});

describe('channelMessageRepository.removeChannelReaction', () => {
  it('returns the count of rows actually removed so the route can 404 on no-op', async () => {
    const removed = await channelMessageRepository.removeChannelReaction({
      messageId: 'msg-1',
      userId: 'user-1',
      emoji: '👍',
    });

    assert({
      given: 'a delete that matched no rows (table is empty)',
      should: 'return 0 so the route can return 404 instead of pretending success',
      actual: removed,
      expected: 0,
    });
  });

  it('scopes the delete to (messageId, userId, emoji) — never deletes another user\'s reaction', async () => {
    testDbState.seed('channelMessageReactions', [
      { id: 'rx-mine', messageId: 'msg-1', userId: 'user-1', emoji: '👍' },
      { id: 'rx-other-user', messageId: 'msg-1', userId: 'user-other', emoji: '👍' },
      { id: 'rx-other-msg', messageId: 'msg-other', userId: 'user-1', emoji: '👍' },
      { id: 'rx-other-emoji', messageId: 'msg-1', userId: 'user-1', emoji: '🎉' },
    ]);

    const removed = await channelMessageRepository.removeChannelReaction({
      messageId: 'msg-1',
      userId: 'user-1',
      emoji: '👍',
    });

    const remaining = testDbState
      .rows('channelMessageReactions')
      .map((r) => r.id)
      .sort();
    assert({
      given: 'a reaction-removal request when reactions for other users / messages / emojis exist',
      should: 'delete only the (msg-1, user-1, 👍) row, return 1, and leave the three unrelated rows intact',
      actual: { removed, remaining },
      expected: { removed: 1, remaining: ['rx-other-emoji', 'rx-other-msg', 'rx-other-user'] },
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

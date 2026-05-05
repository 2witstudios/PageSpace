import { describe, it, expect, vi, beforeEach } from 'vitest';

// Boundary-level test double: see test-doubles/db.ts for the design rationale.
import { testDb, testDbState } from './test-doubles/db';

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

import { dmMessageRepository } from '../dm-message-repository';

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

describe('dmMessageRepository.softDeleteMessage', () => {
  it('records deletedAt without falsifying the read receipt', async () => {
    testDbState.seed('directMessages', [
      { id: 'msg-1', conversationId: 'conv-1', senderId: 'u-1', isActive: true, isRead: true, readAt: new Date('2026-05-01T10:00:00Z'), parentId: null, replyCount: 0 },
    ]);

    const count = await dmMessageRepository.softDeleteMessage('msg-1');

    const row = testDbState.rows('directMessages')[0];
    assert({
      given: 'a soft-delete of an active DM with a prior read receipt',
      should: 'flip isActive=false and stamp deletedAt — the read flags must remain truthful evidence the recipient saw it',
      actual: {
        count,
        isActive: row.isActive,
        deletedAtIsDate: row.deletedAt instanceof Date,
        isRead: row.isRead,
        readAt: row.readAt,
      },
      expected: {
        count: 1,
        isActive: false,
        deletedAtIsDate: true,
        isRead: true,
        readAt: new Date('2026-05-01T10:00:00Z'),
      },
    });
  });

  it('decrements parent replyCount when the soft-deleted row is a thread reply', async () => {
    testDbState.seed('directMessages', [
      { id: 'parent-1', conversationId: 'conv-1', senderId: 'u-parent', isActive: true, parentId: null, replyCount: 3 },
      { id: 'reply-1', conversationId: 'conv-1', senderId: 'u-replier', isActive: true, parentId: 'parent-1', replyCount: 0 },
    ]);

    await dmMessageRepository.softDeleteMessage('reply-1');

    const rows = testDbState.rows('directMessages');
    assert({
      given: 'a soft-delete of a DM thread reply with parent.replyCount=3',
      should: 'decrement the parent counter to 2 in the same transaction as the reply tombstone',
      actual: {
        replyActive: rows.find((r) => r.id === 'reply-1')?.isActive,
        parentReplyCount: rows.find((r) => r.id === 'parent-1')?.replyCount,
      },
      expected: { replyActive: false, parentReplyCount: 2 },
    });
  });

  it('does not issue a parent-counter update when the row is top-level (parentId is null)', async () => {
    testDbState.seed('directMessages', [
      { id: 'top-1', conversationId: 'conv-1', senderId: 'u-1', isActive: true, parentId: null, replyCount: 9 },
    ]);

    await dmMessageRepository.softDeleteMessage('top-1');

    const row = testDbState.rows('directMessages')[0];
    assert({
      given: 'a soft-delete of a top-level DM (parentId IS NULL)',
      should: 'flip isActive but never touch its own replyCount',
      actual: { isActive: row.isActive, replyCount: row.replyCount },
      expected: { isActive: false, replyCount: 9 },
    });
  });

  it('returns 0 when the message is already inactive', async () => {
    testDbState.seed('directMessages', [
      { id: 'msg-1', conversationId: 'conv-1', senderId: 'u-1', isActive: false, parentId: null, replyCount: 0 },
    ]);

    const count = await dmMessageRepository.softDeleteMessage('msg-1');

    assert({
      given: 'a soft-delete of an already-inactive DM',
      should: 'return 0 so the route can 404 instead of re-broadcasting',
      actual: count,
      expected: 0,
    });
  });
});

describe('dmMessageRepository.restoreDmMessage', () => {
  it('flips isActive=true and resets deletedAt; bumps parent.replyCount when the parent is still active', async () => {
    testDbState.seed('directMessages', [
      { id: 'parent-1', conversationId: 'conv-1', senderId: 'u-parent', isActive: true, parentId: null, replyCount: 1 },
      { id: 'reply-1', conversationId: 'conv-1', senderId: 'u-replier', isActive: false, deletedAt: new Date('2026-04-01T00:00:00Z'), parentId: 'parent-1', replyCount: 0 },
    ]);

    const count = await dmMessageRepository.restoreDmMessage('reply-1');

    const rows = testDbState.rows('directMessages');
    const reply = rows.find((r) => r.id === 'reply-1');
    const parent = rows.find((r) => r.id === 'parent-1');
    assert({
      given: 'a restore of a DM thread reply whose parent is still active',
      should: 'flip the reply isActive=true, NULL deletedAt, and bump parent.replyCount to 2 in the same tx',
      actual: {
        count,
        replyActive: reply?.isActive,
        // deletedAt MUST be reset on restore — otherwise the retention purge
        // (filters by deletedAt < olderThan) could either skip the row forever
        // or purge it unexpectedly when re-soft-deleted.
        replyDeletedAt: reply?.deletedAt,
        parentReplyCount: parent?.replyCount,
      },
      expected: { count: 1, replyActive: true, replyDeletedAt: null, parentReplyCount: 2 },
    });
  });

  it('does NOT bump the parent counter when the parent has been soft-deleted in the meantime, but still returns 1', async () => {
    testDbState.seed('directMessages', [
      { id: 'parent-1', conversationId: 'conv-1', senderId: 'u-parent', isActive: false, parentId: null, replyCount: 5 },
      { id: 'reply-1', conversationId: 'conv-1', senderId: 'u-replier', isActive: false, parentId: 'parent-1', replyCount: 0 },
    ]);

    const count = await dmMessageRepository.restoreDmMessage('reply-1');

    const parent = testDbState.rows('directMessages').find((r) => r.id === 'parent-1');
    assert({
      given: 'a restore of a DM thread reply whose parent is itself soft-deleted',
      should: 'restore the reply but leave the tombstoned parent counter exactly where it was',
      actual: { count, parentReplyCount: parent?.replyCount },
      expected: { count: 1, parentReplyCount: 5 },
    });
  });
});

describe('dmMessageRepository.purgeInactiveMessages', () => {
  it('purges only DMs older than the cutoff and returns the row count', async () => {
    const cutoff = new Date('2026-04-01T00:00:00Z');
    const old = new Date('2026-03-01T00:00:00Z');
    const recent = new Date('2026-05-01T00:00:00Z');
    testDbState.seed('directMessages', [
      { id: 'old-purge-me', conversationId: 'conv-1', senderId: 'u-1', isActive: false, deletedAt: old, parentId: null, fileId: 'file-1' },
      { id: 'recent-keep', conversationId: 'conv-1', senderId: 'u-1', isActive: false, deletedAt: recent, parentId: null, fileId: null },
      { id: 'active-keep', conversationId: 'conv-1', senderId: 'u-1', isActive: true, deletedAt: null, parentId: null, fileId: null },
    ]);

    const count = await dmMessageRepository.purgeInactiveMessages(cutoff);

    const remaining = testDbState
      .rows('directMessages')
      .map((r) => r.id)
      .sort();
    assert({
      given: 'one stale tombstone, one fresh tombstone, and one active DM',
      should: 'hard-delete only the stale tombstone (count 1) and leave both other rows in place',
      actual: { count, remaining },
      expected: { count: 1, remaining: ['active-keep', 'recent-keep'] },
    });
  });
});

describe('dmMessageRepository.insertDmThreadReply', () => {
  const baseInput = {
    parentId: 'parent-1',
    conversationId: 'conv-1',
    senderId: 'user-replier',
    content: 'thread response',
    fileId: null,
    attachmentMeta: null,
  };

  const seedActiveParent = (overrides: Partial<Record<string, unknown>> = {}) => {
    testDbState.seed('directMessages', [
      {
        id: 'parent-1',
        conversationId: 'conv-1',
        senderId: 'user-parent',
        parentId: null,
        isActive: true,
        replyCount: 0,
        lastReplyAt: null,
        ...overrides,
      },
    ]);
  };

  it('rejects with parent_not_found when the parent is missing', async () => {
    const result = await dmMessageRepository.insertDmThreadReply(baseInput);

    assert({
      given: 'a parent id that does not resolve to any row',
      should: 'return parent_not_found WITHOUT inserting a reply or follower row',
      actual: {
        kind: result.kind,
        rowCount: testDbState.count('directMessages'),
        followerCount: testDbState.count('dmThreadFollowers'),
      },
      expected: { kind: 'parent_not_found', rowCount: 0, followerCount: 0 },
    });
  });

  it('rejects with parent_not_found when the parent row exists but is soft-deleted (isActive=false)', async () => {
    seedActiveParent({ isActive: false });

    const result = await dmMessageRepository.insertDmThreadReply(baseInput);

    assert({
      given: 'a DM parent that has been soft-deleted',
      should: 'return parent_not_found — clients cannot reply into a tombstoned thread',
      actual: { kind: result.kind, rowCount: testDbState.count('directMessages') },
      expected: { kind: 'parent_not_found', rowCount: 1 },
    });
  });

  it('rejects with parent_wrong_conversation when the parent belongs to a different conversation', async () => {
    seedActiveParent({ conversationId: 'other-conv' });

    const result = await dmMessageRepository.insertDmThreadReply(baseInput);

    assert({
      given: 'a parent id whose conversationId differs from the request conversation',
      should: 'return parent_wrong_conversation so the route can 400',
      actual: { kind: result.kind, rowCount: testDbState.count('directMessages') },
      expected: { kind: 'parent_wrong_conversation', rowCount: 1 },
    });
  });

  it('rejects with parent_not_top_level when the parent itself has parentId set (depth-2 attempt)', async () => {
    seedActiveParent({ parentId: 'grandparent' });

    const result = await dmMessageRepository.insertDmThreadReply(baseInput);

    assert({
      given: 'a DM parent that is itself a thread reply',
      should: 'return parent_not_top_level — DM threads are exactly one level deep',
      actual: { kind: result.kind, rowCount: testDbState.count('directMessages') },
      expected: { kind: 'parent_not_top_level', rowCount: 1 },
    });
  });

  it('inserts the reply with parentId set, bumps replyCount + lastReplyAt, and upserts both followers', async () => {
    seedActiveParent();

    const result = await dmMessageRepository.insertDmThreadReply(baseInput);

    const messages = testDbState.rows('directMessages');
    const followers = testDbState.rows('dmThreadFollowers');
    const reply = messages.find((r) => r.parentId === 'parent-1');
    const parent = messages.find((r) => r.id === 'parent-1');
    assert({
      given: 'a happy-path DM thread reply with a distinct replier and parent author',
      should: 'insert the reply with parentId, bump parent.replyCount, set lastReplyAt, and add follower rows for parent author + replier',
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

    const result = await dmMessageRepository.insertDmThreadReply({
      ...baseInput,
      alsoSendToParent: true,
    });

    const messages = testDbState.rows('directMessages');
    const reply = messages.find((r) => r.parentId === 'parent-1');
    const mirror = messages.find((r) => r.mirroredFromId === reply?.id);
    assert({
      given: 'an alsoSendToParent DM thread reply',
      should: 'write a second top-level row (parentId IS NULL) with mirroredFromId pointing at the reply',
      actual: {
        kind: result.kind,
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

    await dmMessageRepository.insertDmThreadReply(baseInput);

    const followers = testDbState.rows('dmThreadFollowers');
    assert({
      given: 'a DM thread reply where the parent author and the replier are different users',
      should: 'leave exactly two rows in dmThreadFollowers, one for each — and both keyed to the root',
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

  it('upserts exactly one follower row when the parent author replies to their own DM thread (self-reply dedup)', async () => {
    seedActiveParent({ senderId: 'user-self' });

    await dmMessageRepository.insertDmThreadReply({
      ...baseInput,
      senderId: 'user-self',
    });

    const followers = testDbState.rows('dmThreadFollowers');
    assert({
      given: 'a DM reply where the parent author and the replier are the same user',
      should: 'collapse to a single follower row — Postgres rejects two identical rows in the same INSERT, even with onConflictDoNothing',
      actual: followers.map((f) => ({ rootMessageId: f.rootMessageId, userId: f.userId })),
      expected: [{ rootMessageId: 'parent-1', userId: 'user-self' }],
    });
  });

  it('rolls the entire transaction back when the follower upsert step throws — no reply, no follower, parent counter unchanged', async () => {
    const seededLastReplyAt = new Date('2026-04-01T00:00:00Z');
    seedActiveParent({ replyCount: 7, lastReplyAt: seededLastReplyAt });
    testDbState.failBefore('insert', 'dmThreadFollowers');

    await expect(
      dmMessageRepository.insertDmThreadReply(baseInput)
    ).rejects.toThrow();

    const messages = testDbState.rows('directMessages');
    const followers = testDbState.rows('dmThreadFollowers');
    const parent = messages.find((r) => r.id === 'parent-1');
    assert({
      given: 'an insertDmThreadReply call where the follower upsert step fails inside the transaction',
      should: 'roll back every write — only the seeded parent remains, replyCount + lastReplyAt as-seeded, no followers',
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

  it('rolls the entire transaction back when alsoSendToParent mirror-insert throws — no reply, no mirror, parent counter unchanged', async () => {
    seedActiveParent({ replyCount: 4 });
    // The reply is the first directMessages insert; the mirror is the second
    // (the followers insert hits dmThreadFollowers). Skip the first and fail
    // the second so we exercise rollback after a successful reply write.
    testDbState.failBefore('insert', 'directMessages', { skip: 1 });

    await expect(
      dmMessageRepository.insertDmThreadReply({
        ...baseInput,
        alsoSendToParent: true,
      })
    ).rejects.toThrow();

    const messages = testDbState.rows('directMessages');
    const followers = testDbState.rows('dmThreadFollowers');
    const parent = messages.find((r) => r.id === 'parent-1');
    assert({
      given: 'an alsoSendToParent DM reply where the mirror insert step throws inside the transaction',
      should: 'roll back EVERY write — no thread reply, no mirror, no follower rows, parent counter exactly as seeded',
      actual: {
        rowCount: messages.length,
        parentReplyCount: parent?.replyCount,
        followerCount: followers.length,
      },
      expected: { rowCount: 1, parentReplyCount: 4, followerCount: 0 },
    });
  });

  it('soft-deleting a DM reply decrements parent.replyCount; restoring it (parent still active) increments it back', async () => {
    seedActiveParent({ replyCount: 3 });
    testDbState.seed('directMessages', [
      { id: 'reply-1', conversationId: 'conv-1', senderId: 'user-replier', parentId: 'parent-1', isActive: true, replyCount: 0 },
    ]);

    await dmMessageRepository.softDeleteMessage('reply-1');
    const afterDelete = testDbState.rows('directMessages').find((r) => r.id === 'parent-1')?.replyCount;
    await dmMessageRepository.restoreDmMessage('reply-1');
    const afterRestore = testDbState.rows('directMessages').find((r) => r.id === 'parent-1')?.replyCount;

    assert({
      given: 'a parent with replyCount=3 and an active DM reply, then a soft-delete followed by a restore',
      should: 'decrement parent.replyCount to 2 on delete, then increment back to 3 on restore (parent stays active)',
      actual: { afterDelete, afterRestore },
      expected: { afterDelete: 2, afterRestore: 3 },
    });
  });

  it('restoring a DM reply when the parent itself has been soft-deleted in the meantime does NOT bump the tombstoned parent counter', async () => {
    testDbState.seed('directMessages', [
      { id: 'parent-1', conversationId: 'conv-1', senderId: 'user-parent', parentId: null, isActive: true, replyCount: 2 },
      { id: 'reply-1', conversationId: 'conv-1', senderId: 'user-replier', parentId: 'parent-1', isActive: false, replyCount: 0 },
    ]);
    await dmMessageRepository.softDeleteMessage('parent-1');
    const parentBeforeRestore = testDbState.rows('directMessages').find((r) => r.id === 'parent-1');
    expect(parentBeforeRestore?.isActive).toBe(false);

    await dmMessageRepository.restoreDmMessage('reply-1');

    const rows = testDbState.rows('directMessages');
    const parent = rows.find((r) => r.id === 'parent-1');
    const reply = rows.find((r) => r.id === 'reply-1');
    assert({
      given: 'a restore of a DM reply whose parent has been soft-deleted in the meantime',
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

describe('dmMessageRepository.listActiveMessages [reactions parity]', () => {
  it('joins the reactions relation with the user columns the broadcast payload needs', async () => {
    testDbState.seed('users', [{ id: 'u-1', name: 'Alice' }]);
    testDbState.seed('directMessages', [
      { id: 'msg-1', conversationId: 'conv-1', senderId: 'u-1', isActive: true, parentId: null, createdAt: new Date('2026-05-04T12:00:00Z') },
    ]);
    testDbState.seed('dmMessageReactions', [
      { id: 'rx-1', messageId: 'msg-1', userId: 'u-1', emoji: '👍' },
    ]);

    const rows = await dmMessageRepository.listActiveMessages({ conversationId: 'conv-1', limit: 50 });

    const msg = rows[0] as { reactions: Array<{ user: { id: string; name: string } | null }> };
    assert({
      given: 'a DM list fetch on a conversation with a reaction',
      should: 'return reactions joined with user.id and user.name so the DM page renders chips identically to channels',
      actual: {
        reactionCount: msg.reactions?.length,
        user: msg.reactions?.[0]?.user,
      },
      expected: { reactionCount: 1, user: { id: 'u-1', name: 'Alice' } },
    });
  });

  it('hydrates sender, file, and reactions.user on each row — the dmMessageWith parity contract with channels', async () => {
    testDbState.seed('users', [
      { id: 'u-sender', name: 'Author', image: '/avatar.png' },
      { id: 'u-reactor', name: 'Reactor', image: null },
    ]);
    testDbState.seed('files', [
      { id: 'file-1', mimeType: 'image/png', sizeBytes: 2048 },
    ]);
    testDbState.seed('directMessages', [
      {
        id: 'msg-1', conversationId: 'conv-1', senderId: 'u-sender',
        isActive: true, parentId: null, fileId: 'file-1',
        createdAt: new Date('2026-05-04T12:00:00Z'),
      },
    ]);
    testDbState.seed('dmMessageReactions', [
      { id: 'rx-1', messageId: 'msg-1', userId: 'u-reactor', emoji: '🎉' },
    ]);

    const rows = await dmMessageRepository.listActiveMessages({ conversationId: 'conv-1', limit: 50 });

    const msg = rows[0] as {
      sender: { id: string; name: string; image: string | null } | null;
      file: { id: string; mimeType: string; sizeBytes: number } | null;
      reactions: Array<{ user: { id: string; name: string } | null }>;
    };
    assert({
      given: 'a DM list fetch where the message has both an attachment and a reaction by another user',
      should: 'hydrate sender (id, name, image), file (id, mimeType, sizeBytes), and reactions.user (id, name) — the same column whitelist channel-message-repository.messageWith uses, so the DM panel renders parity with channels without a re-fetch',
      actual: {
        sender: msg.sender,
        file: msg.file,
        reactionUser: msg.reactions[0]?.user,
      },
      expected: {
        sender: { id: 'u-sender', name: 'Author', image: '/avatar.png' },
        file: { id: 'file-1', mimeType: 'image/png', sizeBytes: 2048 },
        reactionUser: { id: 'u-reactor', name: 'Reactor' },
      },
    });
  });
});

describe('dmMessageRepository.listActiveMessages [thread-isolation]', () => {
  it('filters out replies by requiring parentId IS NULL — thread replies must NEVER leak into the main DM stream', async () => {
    testDbState.seed('directMessages', [
      { id: 'top-a', conversationId: 'conv-1', senderId: 'u-1', isActive: true, parentId: null, createdAt: new Date('2026-05-01T00:00:00Z') },
      { id: 'reply-leak', conversationId: 'conv-1', senderId: 'u-1', isActive: true, parentId: 'top-a', createdAt: new Date('2026-05-01T00:01:00Z') },
      { id: 'top-b', conversationId: 'conv-1', senderId: 'u-2', isActive: true, parentId: null, createdAt: new Date('2026-05-01T00:02:00Z') },
    ]);

    const rows = await dmMessageRepository.listActiveMessages({ conversationId: 'conv-1', limit: 50 });

    assert({
      given: 'a top-level DM messages fetch where a thread reply also exists',
      should: 'omit the reply — only top-level rows leak into the main stream',
      actual: rows.map((r) => r.id).sort(),
      expected: ['top-a', 'top-b'],
    });
  });
});

describe('dmMessageRepository.listDmThreadReplies', () => {
  it('filters by parentId AND isActive=true and orders ascending by (createdAt, id)', async () => {
    const t0 = new Date('2026-05-04T12:00:00Z');
    const t1 = new Date('2026-05-04T12:01:00Z');
    const t2 = new Date('2026-05-04T12:02:00Z');
    testDbState.seed('directMessages', [
      { id: 'parent-1', conversationId: 'conv-1', senderId: 'u-1', isActive: true, parentId: null },
      { id: 'r-3', conversationId: 'conv-1', senderId: 'u-1', isActive: true, parentId: 'parent-1', createdAt: t2 },
      { id: 'r-1', conversationId: 'conv-1', senderId: 'u-1', isActive: true, parentId: 'parent-1', createdAt: t0 },
      { id: 'r-2', conversationId: 'conv-1', senderId: 'u-1', isActive: true, parentId: 'parent-1', createdAt: t1 },
      { id: 'r-deleted', conversationId: 'conv-1', senderId: 'u-1', isActive: false, parentId: 'parent-1', createdAt: t1 },
      { id: 'other-parent-reply', conversationId: 'conv-1', senderId: 'u-1', isActive: true, parentId: 'other', createdAt: t1 },
    ]);

    const result = await dmMessageRepository.listDmThreadReplies({ rootId: 'parent-1', limit: 50 });

    assert({
      given: 'a DM list-replies request for a thread root with active+deleted replies and an unrelated reply on another parent',
      should: 'return only the parent-1 active replies, ordered ascending by (createdAt, id)',
      actual: result.map((r) => r.id),
      expected: ['r-1', 'r-2', 'r-3'],
    });
  });

  it('builds a strictly-greater-than composite cursor when after is supplied', async () => {
    const t0 = new Date('2026-05-04T12:00:00Z');
    const t1 = new Date('2026-05-04T12:01:00Z');
    testDbState.seed('directMessages', [
      { id: 'r-1', conversationId: 'conv-1', senderId: 'u-1', isActive: true, parentId: 'parent-1', createdAt: t0 },
      { id: 'r-2-cursor', conversationId: 'conv-1', senderId: 'u-1', isActive: true, parentId: 'parent-1', createdAt: t1 },
      { id: 'r-3', conversationId: 'conv-1', senderId: 'u-1', isActive: true, parentId: 'parent-1', createdAt: t1 },
      { id: 'r-4', conversationId: 'conv-1', senderId: 'u-1', isActive: true, parentId: 'parent-1', createdAt: new Date('2026-05-04T12:02:00Z') },
    ]);

    const result = await dmMessageRepository.listDmThreadReplies({
      rootId: 'parent-1',
      limit: 50,
      after: { createdAt: t1, id: 'r-2-cursor' },
    });

    assert({
      given: 'an ascending-cursor DM pagination request at (t1, r-2-cursor)',
      should: 'return rows strictly newer by createdAt OR same-createdAt with strictly larger id — never the cursor row, never anything older',
      actual: result.map((r) => r.id).sort(),
      expected: ['r-3', 'r-4'],
    });
  });

  it('hydrates sender, file, and reactions on each thread reply — the parity contract with channel replies', async () => {
    testDbState.seed('users', [
      { id: 'u-replier', name: 'Replier', image: '/r.png' },
      { id: 'u-reactor', name: 'Reactor', image: null },
    ]);
    testDbState.seed('files', [
      { id: 'file-att', mimeType: 'application/pdf', sizeBytes: 9001 },
    ]);
    testDbState.seed('directMessages', [
      {
        id: 'reply-1', conversationId: 'conv-1', senderId: 'u-replier',
        isActive: true, parentId: 'parent-1', fileId: 'file-att',
        createdAt: new Date('2026-05-04T12:00:00Z'),
      },
    ]);
    testDbState.seed('dmMessageReactions', [
      { id: 'rx-1', messageId: 'reply-1', userId: 'u-reactor', emoji: '👀' },
    ]);

    const rows = await dmMessageRepository.listDmThreadReplies({ rootId: 'parent-1', limit: 50 });

    const reply = rows[0] as unknown as {
      sender: { id: string; name: string; image: string | null } | null;
      file: { id: string; mimeType: string; sizeBytes: number } | null;
      reactions: Array<{ user: { id: string; name: string } | null }>;
    };
    assert({
      given: 'a DM thread reply with an attachment and a reaction by a different user',
      should: 'return the reply with sender, file, and reactions.user hydrated using the same column whitelist as the channel side, so the thread panel renders without a follow-up fetch',
      actual: {
        sender: reply.sender,
        file: reply.file,
        reactionUser: reply.reactions[0]?.user,
      },
      expected: {
        sender: { id: 'u-replier', name: 'Replier', image: '/r.png' },
        file: { id: 'file-att', mimeType: 'application/pdf', sizeBytes: 9001 },
        reactionUser: { id: 'u-reactor', name: 'Reactor' },
      },
    });
  });
});

describe('dmMessageRepository thread follower helpers', () => {
  it('addDmThreadFollower inserts (rootId, userId) and is idempotent under a re-add', async () => {
    await dmMessageRepository.addDmThreadFollower('root-1', 'user-1');
    await dmMessageRepository.addDmThreadFollower('root-1', 'user-1');

    const rows = testDbState.rows('dmThreadFollowers');
    assert({
      given: 'two DM follower adds for the same (rootId, userId)',
      should: 'persist exactly one row — onConflictDoNothing makes the second add a no-op',
      actual: rows.map((r) => ({ rootMessageId: r.rootMessageId, userId: r.userId })),
      expected: [{ rootMessageId: 'root-1', userId: 'user-1' }],
    });
  });

  it('removeDmThreadFollower deletes scoped to (rootId, userId) — never another user', async () => {
    testDbState.seed('dmThreadFollowers', [
      { rootMessageId: 'root-1', userId: 'user-1' },
      { rootMessageId: 'root-1', userId: 'user-other' },
      { rootMessageId: 'root-other', userId: 'user-1' },
    ]);

    await dmMessageRepository.removeDmThreadFollower('root-1', 'user-1');

    const remaining = testDbState
      .rows('dmThreadFollowers')
      .map((r) => `${r.rootMessageId}:${r.userId}`)
      .sort();
    assert({
      given: 'a remove of (root-1, user-1) when other follower rows exist',
      should: 'delete only the matching tuple — leave (root-1, user-other) and (root-other, user-1) intact',
      actual: remaining,
      expected: ['root-1:user-other', 'root-other:user-1'],
    });
  });

  it('listDmThreadFollowers returns a flat array of user ids', async () => {
    testDbState.seed('dmThreadFollowers', [
      { rootMessageId: 'root-1', userId: 'user-a' },
      { rootMessageId: 'root-1', userId: 'user-b' },
      { rootMessageId: 'root-other', userId: 'user-c' },
    ]);

    const result = await dmMessageRepository.listDmThreadFollowers('root-1');

    assert({
      given: 'a DM thread root with two followers and an unrelated follower on another root',
      should: 'return a flat string[] of user ids scoped to the requested root only',
      actual: result.sort(),
      expected: ['user-a', 'user-b'],
    });
  });
});

describe('dmMessageRepository.addDmReaction', () => {
  it('writes (messageId, userId, emoji) verbatim and returns the inserted row', async () => {
    const result = await dmMessageRepository.addDmReaction({
      messageId: 'msg-1',
      userId: 'user-1',
      emoji: '👍',
    });

    const rows = testDbState.rows('dmMessageReactions');
    assert({
      given: 'a DM reaction add request',
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

describe('dmMessageRepository.loadDmReactionWithUser', () => {
  it('fetches the reaction with the user relation so broadcasts include name+id without a re-fetch', async () => {
    testDbState.seed('users', [{ id: 'u-1', name: 'Alice' }]);
    testDbState.seed('dmMessageReactions', [
      { id: 'rx-1', messageId: 'msg-1', userId: 'u-1', emoji: '👍' },
    ]);

    const result = await dmMessageRepository.loadDmReactionWithUser('rx-1');

    assert({
      given: 'a freshly added DM reaction',
      should: 'load the user relation (id, name) so the broadcast payload renders the actor without an extra round-trip',
      actual: (result?.user as { id: string; name: string } | null),
      expected: { id: 'u-1', name: 'Alice' },
    });
  });
});

describe('dmMessageRepository.removeDmReaction', () => {
  it('returns 0 when the delete matched no rows so the route can 404 on no-op', async () => {
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
    testDbState.seed('dmMessageReactions', [
      { id: 'rx-mine', messageId: 'msg-1', userId: 'user-1', emoji: '👍' },
      { id: 'rx-other-user', messageId: 'msg-1', userId: 'user-other', emoji: '👍' },
      { id: 'rx-other-msg', messageId: 'msg-other', userId: 'user-1', emoji: '👍' },
      { id: 'rx-other-emoji', messageId: 'msg-1', userId: 'user-1', emoji: '🎉' },
    ]);

    const removed = await dmMessageRepository.removeDmReaction({
      messageId: 'msg-1',
      userId: 'user-1',
      emoji: '👍',
    });

    const remaining = testDbState
      .rows('dmMessageReactions')
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

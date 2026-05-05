/**
 * Persistence seam for the channel message pipeline.
 *
 * Tests mock this module to assert validation outcomes and the insert/update
 * payloads without touching the ORM chain (per unit-test-rubric §4).
 *
 * Mirrors `dm-message-repository.ts` for the channel side.
 *
 * @module @pagespace/lib/services/channel-message-repository
 */

import { db } from '@pagespace/db/db';
import { and, asc, desc, eq, gt, isNull, lt, or, sql, type InferSelectModel } from '@pagespace/db/operators';
import {
  channelMessages,
  channelMessageReactions,
  channelReadStatus,
  channelThreadFollowers,
} from '@pagespace/db/schema/chat';
import { files, type AttachmentMeta } from '@pagespace/db/schema/storage';

export type ChannelMessageRow = InferSelectModel<typeof channelMessages>;
export type ChannelReactionRow = InferSelectModel<typeof channelMessageReactions>;

const messageWith = {
  user: {
    columns: {
      id: true,
      name: true,
      image: true,
    },
  },
  file: {
    columns: {
      id: true,
      mimeType: true,
      sizeBytes: true,
    },
  },
  reactions: {
    with: {
      user: {
        columns: {
          id: true,
          name: true,
        },
      },
    },
  },
} as const;

export interface ListChannelMessagesInput {
  pageId: string;
  limit: number;
  // Composite cursor: only rows strictly older than (createdAt, id) are returned.
  cursor?: { createdAt: Date; id: string };
}

async function listChannelMessages(input: ListChannelMessagesInput) {
  const conditions = [
    eq(channelMessages.pageId, input.pageId),
    eq(channelMessages.isActive, true),
    // Top-level only. Threads are exactly one level deep, and reply visibility
    // is owned by the thread panel — never the main message stream.
    isNull(channelMessages.parentId),
  ];

  if (input.cursor) {
    conditions.push(
      or(
        lt(channelMessages.createdAt, input.cursor.createdAt),
        and(
          eq(channelMessages.createdAt, input.cursor.createdAt),
          lt(channelMessages.id, input.cursor.id)
        )
      )!
    );
  }

  return db.query.channelMessages.findMany({
    where: and(...conditions),
    with: messageWith,
    orderBy: [desc(channelMessages.createdAt), desc(channelMessages.id)],
    limit: input.limit,
  });
}

export interface FindChannelMessageInPageInput {
  messageId: string;
  pageId: string;
}

async function findChannelMessageInPage(
  input: FindChannelMessageInPageInput
): Promise<ChannelMessageRow | null> {
  const row = await db.query.channelMessages.findFirst({
    where: and(
      eq(channelMessages.id, input.messageId),
      eq(channelMessages.pageId, input.pageId)
    ),
  });
  return row ?? null;
}

async function loadChannelMessageWithRelations(id: string) {
  return db.query.channelMessages.findFirst({
    where: eq(channelMessages.id, id),
    with: messageWith,
  });
}

async function fileExists(fileId: string): Promise<boolean> {
  const row = await db.query.files.findFirst({
    where: eq(files.id, fileId),
    columns: { id: true },
  });
  return row !== undefined;
}

export interface InsertChannelMessageInput {
  pageId: string;
  userId: string;
  content: string;
  fileId: string | null;
  attachmentMeta: AttachmentMeta | null;
}

async function insertChannelMessage(
  input: InsertChannelMessageInput
): Promise<ChannelMessageRow> {
  const [row] = await db
    .insert(channelMessages)
    .values({
      pageId: input.pageId,
      userId: input.userId,
      content: input.content,
      fileId: input.fileId,
      attachmentMeta: input.attachmentMeta,
    })
    .returning();
  return row;
}

export interface UpsertChannelReadStatusInput {
  userId: string;
  channelId: string;
  readAt: Date;
}

async function upsertChannelReadStatus(
  input: UpsertChannelReadStatusInput
): Promise<void> {
  await db
    .insert(channelReadStatus)
    .values({
      userId: input.userId,
      channelId: input.channelId,
      lastReadAt: input.readAt,
    })
    .onConflictDoUpdate({
      target: [channelReadStatus.userId, channelReadStatus.channelId],
      set: { lastReadAt: input.readAt },
    });
}

export interface UpdateChannelMessageContentInput {
  messageId: string;
  content: string;
  editedAt: Date;
}

async function updateChannelMessageContent(
  input: UpdateChannelMessageContentInput
): Promise<void> {
  await db
    .update(channelMessages)
    .set({ content: input.content, editedAt: input.editedAt })
    .where(eq(channelMessages.id, input.messageId));
}

async function softDeleteChannelMessage(messageId: string): Promise<void> {
  // Soft-deleting a thread reply must decrement the parent's replyCount in the
  // same transaction so the footer count never drifts above the real number of
  // visible replies. GREATEST(... - 1, 0) guards against a double soft-delete
  // racing the counter into negative territory.
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(channelMessages)
      .set({ isActive: false })
      .where(
        and(
          eq(channelMessages.id, messageId),
          eq(channelMessages.isActive, true)
        )
      )
      .returning({ parentId: channelMessages.parentId });

    if (row?.parentId) {
      await tx
        .update(channelMessages)
        .set({
          replyCount: sql`GREATEST(${channelMessages.replyCount} - 1, 0)`,
        })
        .where(eq(channelMessages.id, row.parentId));
    }
  });
}

async function restoreChannelMessage(messageId: string): Promise<void> {
  // Mirror of softDeleteChannelMessage: flips isActive back to true and
  // increments the parent's replyCount when the row is a thread reply.
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(channelMessages)
      .set({ isActive: true })
      .where(
        and(
          eq(channelMessages.id, messageId),
          eq(channelMessages.isActive, false)
        )
      )
      .returning({ parentId: channelMessages.parentId });

    if (row?.parentId) {
      await tx
        .update(channelMessages)
        .set({
          replyCount: sql`${channelMessages.replyCount} + 1`,
        })
        .where(eq(channelMessages.id, row.parentId));
    }
  });
}

export interface ChannelReactionInput {
  messageId: string;
  userId: string;
  emoji: string;
}

async function addChannelReaction(
  input: ChannelReactionInput
): Promise<ChannelReactionRow> {
  const [row] = await db
    .insert(channelMessageReactions)
    .values({
      messageId: input.messageId,
      userId: input.userId,
      emoji: input.emoji,
    })
    .returning();
  return row;
}

async function loadChannelReactionWithUser(reactionId: string) {
  return db.query.channelMessageReactions.findFirst({
    where: eq(channelMessageReactions.id, reactionId),
    with: {
      user: {
        columns: {
          id: true,
          name: true,
        },
      },
    },
  });
}

async function removeChannelReaction(
  input: ChannelReactionInput
): Promise<number> {
  const result = await db
    .delete(channelMessageReactions)
    .where(
      and(
        eq(channelMessageReactions.messageId, input.messageId),
        eq(channelMessageReactions.userId, input.userId),
        eq(channelMessageReactions.emoji, input.emoji)
      )
    )
    .returning({ id: channelMessageReactions.id });
  return result.length;
}

// ---------------------------------------------------------------------------
// Thread reply helpers
// ---------------------------------------------------------------------------

export interface InsertChannelThreadReplyInput {
  parentId: string;
  pageId: string;
  userId: string;
  content: string;
  fileId: string | null;
  attachmentMeta: AttachmentMeta | null;
  alsoSendToParent?: boolean;
}

export type InsertChannelThreadReplyResult =
  | {
      kind: 'ok';
      reply: ChannelMessageRow;
      mirror: ChannelMessageRow | null;
      rootId: string;
      replyCount: number;
      lastReplyAt: Date;
    }
  | { kind: 'parent_not_found' }
  | { kind: 'parent_wrong_page' }
  | { kind: 'parent_not_top_level' };

async function insertChannelThreadReply(
  input: InsertChannelThreadReplyInput
): Promise<InsertChannelThreadReplyResult> {
  return db.transaction(async (tx) => {
    const parent = await tx.query.channelMessages.findFirst({
      where: eq(channelMessages.id, input.parentId),
      columns: {
        id: true,
        pageId: true,
        parentId: true,
        userId: true,
        isActive: true,
      },
    });

    if (!parent || !parent.isActive) {
      return { kind: 'parent_not_found' };
    }
    if (parent.pageId !== input.pageId) {
      return { kind: 'parent_wrong_page' };
    }
    if (parent.parentId !== null) {
      return { kind: 'parent_not_top_level' };
    }

    const [reply] = await tx
      .insert(channelMessages)
      .values({
        pageId: input.pageId,
        userId: input.userId,
        content: input.content,
        fileId: input.fileId,
        attachmentMeta: input.attachmentMeta,
        parentId: input.parentId,
      })
      .returning();

    const [updatedParent] = await tx
      .update(channelMessages)
      .set({
        replyCount: sql`${channelMessages.replyCount} + 1`,
        lastReplyAt: reply.createdAt,
      })
      .where(eq(channelMessages.id, input.parentId))
      .returning({
        replyCount: channelMessages.replyCount,
        lastReplyAt: channelMessages.lastReplyAt,
      });

    // Dedupe parent author + replier so onConflictDoNothing never sees two
    // identical rows in the same INSERT (Postgres rejects that even with
    // onConflictDoNothing in some driver paths).
    const followerRows =
      parent.userId === input.userId
        ? [{ rootMessageId: input.parentId, userId: input.userId }]
        : [
            { rootMessageId: input.parentId, userId: parent.userId },
            { rootMessageId: input.parentId, userId: input.userId },
          ];

    await tx
      .insert(channelThreadFollowers)
      .values(followerRows)
      .onConflictDoNothing();

    let mirror: ChannelMessageRow | null = null;
    if (input.alsoSendToParent) {
      const [mirrorRow] = await tx
        .insert(channelMessages)
        .values({
          pageId: input.pageId,
          userId: input.userId,
          content: input.content,
          fileId: input.fileId,
          attachmentMeta: input.attachmentMeta,
          mirroredFromId: reply.id,
        })
        .returning();
      mirror = mirrorRow;
    }

    return {
      kind: 'ok',
      reply,
      mirror,
      rootId: input.parentId,
      replyCount: updatedParent.replyCount,
      lastReplyAt: updatedParent.lastReplyAt!,
    };
  });
}

export interface ListChannelThreadRepliesInput {
  rootId: string;
  limit: number;
  // Composite cursor: only rows strictly newer than (createdAt, id) are returned.
  after?: { createdAt: Date; id: string };
}

async function listChannelThreadReplies(
  input: ListChannelThreadRepliesInput
) {
  const conditions = [
    eq(channelMessages.parentId, input.rootId),
    eq(channelMessages.isActive, true),
  ];

  if (input.after) {
    conditions.push(
      or(
        gt(channelMessages.createdAt, input.after.createdAt),
        and(
          eq(channelMessages.createdAt, input.after.createdAt),
          gt(channelMessages.id, input.after.id)
        )
      )!
    );
  }

  return db.query.channelMessages.findMany({
    where: and(...conditions),
    with: messageWith,
    orderBy: [asc(channelMessages.createdAt), asc(channelMessages.id)],
    limit: input.limit,
  });
}

async function addChannelThreadFollower(
  rootId: string,
  userId: string
): Promise<void> {
  await db
    .insert(channelThreadFollowers)
    .values({ rootMessageId: rootId, userId })
    .onConflictDoNothing();
}

async function removeChannelThreadFollower(
  rootId: string,
  userId: string
): Promise<void> {
  await db
    .delete(channelThreadFollowers)
    .where(
      and(
        eq(channelThreadFollowers.rootMessageId, rootId),
        eq(channelThreadFollowers.userId, userId)
      )
    );
}

async function listChannelThreadFollowers(rootId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: channelThreadFollowers.userId })
    .from(channelThreadFollowers)
    .where(eq(channelThreadFollowers.rootMessageId, rootId));
  return rows.map((row) => row.userId);
}

export const channelMessageRepository = {
  listChannelMessages,
  findChannelMessageInPage,
  loadChannelMessageWithRelations,
  fileExists,
  insertChannelMessage,
  upsertChannelReadStatus,
  updateChannelMessageContent,
  softDeleteChannelMessage,
  restoreChannelMessage,
  addChannelReaction,
  loadChannelReactionWithUser,
  removeChannelReaction,
  insertChannelThreadReply,
  listChannelThreadReplies,
  addChannelThreadFollower,
  removeChannelThreadFollower,
  listChannelThreadFollowers,
};

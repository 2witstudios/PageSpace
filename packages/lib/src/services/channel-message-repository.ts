/**
 * Persistence seam for the channel message pipeline.
 *
 * Tests mock this module to assert validation outcomes and the insert/update
 * payloads without touching the ORM chain (per unit-test-rubric §4).
 *
 * Mirrors `dm-message-repository.ts` for the channel side. Keep the function
 * surface narrow — only what the channel route handlers need today. Thread
 * helpers (insertThreadReply, follower upserts) ship in PR 3.
 *
 * @module @pagespace/lib/services/channel-message-repository
 */

import { db } from '@pagespace/db/db';
import { and, desc, eq, isNull, lt, or, type InferSelectModel } from '@pagespace/db/operators';
import { channelMessages, channelMessageReactions, channelReadStatus } from '@pagespace/db/schema/chat';
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
  await db
    .update(channelMessages)
    .set({ isActive: false })
    .where(eq(channelMessages.id, messageId));
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

export const channelMessageRepository = {
  listChannelMessages,
  findChannelMessageInPage,
  loadChannelMessageWithRelations,
  fileExists,
  insertChannelMessage,
  upsertChannelReadStatus,
  updateChannelMessageContent,
  softDeleteChannelMessage,
  addChannelReaction,
  loadChannelReactionWithUser,
  removeChannelReaction,
};

/**
 * Persistence seam for the DM message POST pipeline.
 *
 * Tests mock this module to assert validation outcomes and the insert/update
 * payloads without touching the ORM chain (per unit-test-rubric §4).
 *
 * @module @pagespace/lib/services/dm-message-repository
 */

import { db } from '@pagespace/db/db';
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, sql, type InferSelectModel } from '@pagespace/db/operators';
import { dmConversations, directMessages, dmMessageReactions, dmThreadFollowers } from '@pagespace/db/schema/social';
import { fileConversations, files, type AttachmentMeta } from '@pagespace/db/schema/storage';

// Mirrors `messageWith` in channel-message-repository.ts. Kept duplicated
// because the author relation is named differently (`sender` here vs `user`
// there) and the column lists are short enough that a shared helper would
// only obscure the intent.
const dmMessageWith = {
  sender: {
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

export interface DmConversationParticipants {
  id: string;
  participant1Id: string;
  participant2Id: string;
}

async function findConversationForParticipant(
  conversationId: string,
  userId: string
): Promise<DmConversationParticipants | null> {
  const row = await db.query.dmConversations.findFirst({
    where: and(
      eq(dmConversations.id, conversationId),
      or(
        eq(dmConversations.participant1Id, userId),
        eq(dmConversations.participant2Id, userId)
      )
    ),
    columns: {
      id: true,
      participant1Id: true,
      participant2Id: true,
    },
  });

  return row ?? null;
}

export type AttachmentValidation =
  | { kind: 'ok' }
  | { kind: 'not_found' }
  | { kind: 'wrong_owner' }
  | { kind: 'not_linked' };

export interface ValidateAttachmentForDmInput {
  fileId: string;
  conversationId: string;
  senderId: string;
}

async function validateAttachmentForDm(
  input: ValidateAttachmentForDmInput
): Promise<AttachmentValidation> {
  const { fileId, conversationId, senderId } = input;

  const file = await db.query.files.findFirst({
    where: eq(files.id, fileId),
    columns: { id: true, createdBy: true },
  });

  if (!file) {
    return { kind: 'not_found' };
  }

  if (file.createdBy !== senderId) {
    return { kind: 'wrong_owner' };
  }

  const link = await db.query.fileConversations.findFirst({
    where: and(
      eq(fileConversations.fileId, fileId),
      eq(fileConversations.conversationId, conversationId)
    ),
    columns: { fileId: true },
  });

  if (!link) {
    return { kind: 'not_linked' };
  }

  return { kind: 'ok' };
}

export interface InsertDmMessageInput {
  conversationId: string;
  senderId: string;
  content: string;
  fileId: string | null;
  attachmentMeta: AttachmentMeta | null;
  quotedMessageId?: string | null;
}

export type DmMessageRow = InferSelectModel<typeof directMessages>;

async function insertDmMessage(input: InsertDmMessageInput): Promise<DmMessageRow> {
  const [row] = await db
    .insert(directMessages)
    .values({
      conversationId: input.conversationId,
      senderId: input.senderId,
      content: input.content,
      fileId: input.fileId,
      attachmentMeta: input.attachmentMeta,
      quotedMessageId: input.quotedMessageId ?? null,
    })
    .returning();
  return row;
}

export interface UpdateConversationLastMessageInput {
  conversationId: string;
  lastMessageAt: Date;
  lastMessagePreview: string;
}

async function updateConversationLastMessage(
  input: UpdateConversationLastMessageInput
): Promise<void> {
  // Guard against out-of-order writes: only apply when the stored timestamp
  // is null or strictly older than the new row's createdAt. Two concurrent
  // sends can otherwise let an older message overwrite the inbox preview.
  await db
    .update(dmConversations)
    .set({
      lastMessageAt: input.lastMessageAt,
      lastMessagePreview: input.lastMessagePreview,
    })
    .where(
      and(
        eq(dmConversations.id, input.conversationId),
        or(
          isNull(dmConversations.lastMessageAt),
          lt(dmConversations.lastMessageAt, input.lastMessageAt)
        )
      )
    );
}

export interface ActiveMessageLookupInput {
  messageId: string;
  conversationId: string;
}

async function findActiveMessage(
  input: ActiveMessageLookupInput
): Promise<DmMessageRow | null> {
  const row = await db.query.directMessages.findFirst({
    where: and(
      eq(directMessages.id, input.messageId),
      eq(directMessages.conversationId, input.conversationId),
      eq(directMessages.isActive, true)
    ),
  });
  return row ?? null;
}

/**
 * Look up a DM message by id + conversationId WITHOUT filtering on isActive.
 *
 * Use this for operations that need to act on a message regardless of its
 * tombstone state — e.g. unfollowing a thread after the parent has been soft
 * deleted (`findActiveMessage` would return null and a stale subscription
 * could never be cleared).
 */
async function findMessageInConversation(
  input: ActiveMessageLookupInput
): Promise<DmMessageRow | null> {
  const row = await db.query.directMessages.findFirst({
    where: and(
      eq(directMessages.id, input.messageId),
      eq(directMessages.conversationId, input.conversationId)
    ),
  });
  return row ?? null;
}

async function softDeleteMessage(messageId: string): Promise<number> {
  // Soft-deleting a thread reply must decrement the parent's replyCount in the
  // same transaction so the footer count never drifts above the real number of
  // visible replies. GREATEST guards against a double soft-delete racing the
  // counter into negative territory.
  return db.transaction(async (tx) => {
    const result = await tx
      .update(directMessages)
      .set({
        isActive: false,
        deletedAt: new Date(),
      })
      .where(
        and(
          eq(directMessages.id, messageId),
          eq(directMessages.isActive, true)
        )
      )
      .returning({ id: directMessages.id, parentId: directMessages.parentId });

    const row = result[0];
    if (row?.parentId) {
      await tx
        .update(directMessages)
        .set({
          replyCount: sql`GREATEST(${directMessages.replyCount} - 1, 0)`,
        })
        .where(eq(directMessages.id, row.parentId));
    }

    return result.length;
  });
}

async function restoreDmMessage(messageId: string): Promise<number> {
  // Mirror of softDeleteMessage. The parent counter is only bumped when the
  // parent itself is still active — restoring an orphaned reply whose parent
  // was deleted in the meantime must NOT inflate a tombstone's count. The
  // parent re-read uses SELECT ... FOR UPDATE so a concurrent
  // softDeleteMessage(parentId) blocks until our bump commits — the race the
  // insert-side lock prevents on the way in.
  return db.transaction(async (tx) => {
    const result = await tx
      .update(directMessages)
      .set({
        isActive: true,
        deletedAt: null,
      })
      .where(
        and(
          eq(directMessages.id, messageId),
          eq(directMessages.isActive, false)
        )
      )
      .returning({ id: directMessages.id, parentId: directMessages.parentId });

    const row = result[0];
    if (row?.parentId) {
      const [parent] = await tx
        .select({ id: directMessages.id, isActive: directMessages.isActive })
        .from(directMessages)
        .where(eq(directMessages.id, row.parentId))
        .for('update');
      if (parent?.isActive) {
        await tx
          .update(directMessages)
          .set({
            replyCount: sql`${directMessages.replyCount} + 1`,
          })
          .where(eq(directMessages.id, row.parentId));
      }
    }

    return result.length;
  });
}

async function purgeInactiveMessages(olderThan: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const purgedMessages = await tx
      .delete(directMessages)
      .where(
        and(
          eq(directMessages.isActive, false),
          isNotNull(directMessages.deletedAt),
          lt(directMessages.deletedAt, olderThan)
        )
      )
      .returning({
        id: directMessages.id,
        conversationId: directMessages.conversationId,
        fileId: directMessages.fileId,
      });

    const purgedAttachmentPairs = purgedMessages.flatMap((message) =>
      message.fileId
        ? [{ fileId: message.fileId, conversationId: message.conversationId }]
        : []
    );

    if (purgedAttachmentPairs.length > 0) {
      await tx.execute(sql`
        WITH purged_pairs("fileId", "conversationId") AS (
          VALUES ${sql.join(
            purgedAttachmentPairs.map((pair) => sql`(${pair.fileId}, ${pair.conversationId})`),
            sql`, `
          )}
        )
        DELETE FROM file_conversations fc
        USING purged_pairs pp
        WHERE fc."fileId" = pp."fileId"
          AND fc."conversationId" = pp."conversationId"
          AND NOT EXISTS (
            SELECT 1
            FROM direct_messages dm
            WHERE dm."fileId" = fc."fileId"
              AND dm."conversationId" = fc."conversationId"
          )
      `);
    }

    return purgedMessages.length;
  });
}

export interface EditActiveMessageInput {
  messageId: string;
  content: string;
  editedAt: Date;
}

async function editActiveMessage(input: EditActiveMessageInput): Promise<number> {
  const result = await db
    .update(directMessages)
    .set({ content: input.content, isEdited: true, editedAt: input.editedAt })
    .where(
      and(
        eq(directMessages.id, input.messageId),
        eq(directMessages.isActive, true)
      )
    )
    .returning({ id: directMessages.id });
  return result.length;
}

export interface ListActiveMessagesInput {
  conversationId: string;
  limit: number;
  before?: Date;
}

async function listActiveMessages(input: ListActiveMessagesInput) {
  const baseFilters = [
    eq(directMessages.conversationId, input.conversationId),
    eq(directMessages.isActive, true),
    // Top-level only. Threads are exactly one level deep, and reply visibility
    // is owned by the thread panel — never the main DM stream.
    isNull(directMessages.parentId),
  ];

  if (input.before) {
    baseFilters.push(lt(directMessages.createdAt, input.before));
  }

  return db.query.directMessages.findMany({
    where: and(...baseFilters),
    with: dmMessageWith,
    orderBy: [desc(directMessages.createdAt)],
    limit: input.limit,
  });
}

export interface MarkMessagesReadInput {
  conversationId: string;
  otherUserId: string;
  readAt: Date;
}

async function markActiveMessagesRead(
  input: MarkMessagesReadInput
): Promise<void> {
  await db
    .update(directMessages)
    .set({ isRead: true, readAt: input.readAt })
    .where(
      and(
        eq(directMessages.conversationId, input.conversationId),
        eq(directMessages.senderId, input.otherUserId),
        eq(directMessages.isRead, false),
        eq(directMessages.isActive, true)
      )
    );
}

export interface UpdateLastReadInput {
  conversationId: string;
  participantSide: 'participant1' | 'participant2';
  readAt: Date;
}

async function updateConversationLastRead(
  input: UpdateLastReadInput
): Promise<void> {
  const updateField = input.participantSide === 'participant1'
    ? { participant1LastRead: input.readAt }
    : { participant2LastRead: input.readAt };

  await db
    .update(dmConversations)
    .set(updateField)
    .where(eq(dmConversations.id, input.conversationId));
}

// ---------------------------------------------------------------------------
// Thread reply helpers
// ---------------------------------------------------------------------------

export interface InsertDmThreadReplyInput {
  parentId: string;
  conversationId: string;
  senderId: string;
  content: string;
  fileId: string | null;
  attachmentMeta: AttachmentMeta | null;
  alsoSendToParent?: boolean;
}

export type InsertDmThreadReplyResult =
  | {
      kind: 'ok';
      reply: DmMessageRow;
      mirror: DmMessageRow | null;
      rootId: string;
      replyCount: number;
      lastReplyAt: Date;
    }
  | { kind: 'parent_not_found' }
  | { kind: 'parent_wrong_conversation' }
  | { kind: 'parent_not_top_level' };

async function insertDmThreadReply(
  input: InsertDmThreadReplyInput
): Promise<InsertDmThreadReplyResult> {
  return db.transaction(async (tx) => {
    // SELECT ... FOR UPDATE locks the parent row for the rest of this tx so a
    // concurrent softDeleteMessage(parentId) blocks until our INSERT and
    // replyCount UPDATE commit. Without this lock, the parent could flip
    // isActive=false between validation and INSERT, leaving an orphaned reply
    // attached to a tombstoned parent.
    const [parent] = await tx
      .select({
        id: directMessages.id,
        conversationId: directMessages.conversationId,
        parentId: directMessages.parentId,
        senderId: directMessages.senderId,
        isActive: directMessages.isActive,
      })
      .from(directMessages)
      .where(eq(directMessages.id, input.parentId))
      .for('update');

    if (!parent || !parent.isActive) {
      return { kind: 'parent_not_found' };
    }
    if (parent.conversationId !== input.conversationId) {
      return { kind: 'parent_wrong_conversation' };
    }
    if (parent.parentId !== null) {
      return { kind: 'parent_not_top_level' };
    }

    const [reply] = await tx
      .insert(directMessages)
      .values({
        conversationId: input.conversationId,
        senderId: input.senderId,
        content: input.content,
        fileId: input.fileId,
        attachmentMeta: input.attachmentMeta,
        parentId: input.parentId,
      })
      .returning();

    const [updatedParent] = await tx
      .update(directMessages)
      .set({
        replyCount: sql`${directMessages.replyCount} + 1`,
        lastReplyAt: reply.createdAt,
      })
      .where(eq(directMessages.id, input.parentId))
      .returning({
        replyCount: directMessages.replyCount,
        lastReplyAt: directMessages.lastReplyAt,
      });

    const followerRows =
      parent.senderId === input.senderId
        ? [{ rootMessageId: input.parentId, userId: input.senderId }]
        : [
            { rootMessageId: input.parentId, userId: parent.senderId },
            { rootMessageId: input.parentId, userId: input.senderId },
          ];

    await tx
      .insert(dmThreadFollowers)
      .values(followerRows)
      .onConflictDoNothing();

    let mirror: DmMessageRow | null = null;
    if (input.alsoSendToParent) {
      const [mirrorRow] = await tx
        .insert(directMessages)
        .values({
          conversationId: input.conversationId,
          senderId: input.senderId,
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
      // We just SET lastReplyAt = reply.createdAt above, so the RETURNING value
      // is non-null. Falling back to reply.createdAt makes that explicit
      // instead of relying on a non-null assertion.
      lastReplyAt: updatedParent.lastReplyAt ?? reply.createdAt,
    };
  });
}

export interface ListDmThreadRepliesInput {
  rootId: string;
  limit: number;
  // Composite cursor: only rows strictly newer than (createdAt, id) are returned.
  after?: { createdAt: Date; id: string };
}

export type DmMessageWithRelations = Awaited<ReturnType<typeof listDmThreadReplies>>[number];

async function listDmThreadReplies(
  input: ListDmThreadRepliesInput
) {
  const conditions = [
    eq(directMessages.parentId, input.rootId),
    eq(directMessages.isActive, true),
  ];

  if (input.after) {
    conditions.push(
      or(
        gt(directMessages.createdAt, input.after.createdAt),
        and(
          eq(directMessages.createdAt, input.after.createdAt),
          gt(directMessages.id, input.after.id)
        )
      )!
    );
  }

  return db.query.directMessages.findMany({
    where: and(...conditions),
    with: dmMessageWith,
    orderBy: [asc(directMessages.createdAt), asc(directMessages.id)],
    limit: input.limit,
  });
}

async function addDmThreadFollower(
  rootId: string,
  userId: string
): Promise<void> {
  await db
    .insert(dmThreadFollowers)
    .values({ rootMessageId: rootId, userId })
    .onConflictDoNothing();
}

async function removeDmThreadFollower(
  rootId: string,
  userId: string
): Promise<void> {
  await db
    .delete(dmThreadFollowers)
    .where(
      and(
        eq(dmThreadFollowers.rootMessageId, rootId),
        eq(dmThreadFollowers.userId, userId)
      )
    );
}

async function listDmThreadFollowers(rootId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: dmThreadFollowers.userId })
    .from(dmThreadFollowers)
    .where(eq(dmThreadFollowers.rootMessageId, rootId));
  return rows.map((row) => row.userId);
}

// ---------------------------------------------------------------------------
// Reactions parity (PR 2 of 5)
//
// Mirrors the reaction surface from `channel-message-repository.ts` so the DM
// route can reach feature parity. The reaction route uses the existing
// `findActiveMessage` helper for the existence check so soft-deleted DMs
// (isActive=false) cannot accept new reactions or have reactions removed —
// keeping reaction visibility consistent with `listActiveMessages`.
// ---------------------------------------------------------------------------

export type DmReactionRow = InferSelectModel<typeof dmMessageReactions>;

export interface DmReactionInput {
  messageId: string;
  userId: string;
  emoji: string;
}

async function addDmReaction(input: DmReactionInput): Promise<DmReactionRow> {
  const [row] = await db
    .insert(dmMessageReactions)
    .values({
      messageId: input.messageId,
      userId: input.userId,
      emoji: input.emoji,
    })
    .returning();
  return row;
}

async function loadDmReactionWithUser(reactionId: string) {
  return db.query.dmMessageReactions.findFirst({
    where: eq(dmMessageReactions.id, reactionId),
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

async function removeDmReaction(input: DmReactionInput): Promise<number> {
  const result = await db
    .delete(dmMessageReactions)
    .where(
      and(
        eq(dmMessageReactions.messageId, input.messageId),
        eq(dmMessageReactions.userId, input.userId),
        eq(dmMessageReactions.emoji, input.emoji)
      )
    )
    .returning({ id: dmMessageReactions.id });
  return result.length;
}

export const dmMessageRepository = {
  findConversationForParticipant,
  validateAttachmentForDm,
  insertDmMessage,
  updateConversationLastMessage,
  findActiveMessage,
  findMessageInConversation,
  softDeleteMessage,
  restoreDmMessage,
  purgeInactiveMessages,
  editActiveMessage,
  listActiveMessages,
  markActiveMessagesRead,
  updateConversationLastRead,
  insertDmThreadReply,
  listDmThreadReplies,
  addDmThreadFollower,
  removeDmThreadFollower,
  listDmThreadFollowers,
  addDmReaction,
  loadDmReactionWithUser,
  removeDmReaction,
};

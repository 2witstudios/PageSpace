/**
 * Persistence seam for the DM message POST pipeline.
 *
 * Tests mock this module to assert validation outcomes and the insert/update
 * payloads without touching the ORM chain (per unit-test-rubric §4).
 *
 * @module @pagespace/lib/services/dm-message-repository
 */

import { db } from '@pagespace/db/db';
import { and, desc, eq, isNotNull, isNull, lt, or, sql, type InferSelectModel } from '@pagespace/db/operators';
import { dmConversations, directMessages, dmMessageReactions } from '@pagespace/db/schema/social';
import { fileConversations, files, type AttachmentMeta } from '@pagespace/db/schema/storage';

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

async function softDeleteMessage(messageId: string): Promise<number> {
  const result = await db
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
    .returning({ id: directMessages.id });
  return result.length;
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
  ];

  if (input.before) {
    baseFilters.push(lt(directMessages.createdAt, input.before));
  }

  return db.query.directMessages.findMany({
    where: and(...baseFilters),
    with: {
      reactions: {
        with: {
          user: { columns: { id: true, name: true } },
        },
      },
    },
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
// Reactions parity (PR 2 of 5)
//
// Mirrors the reaction surface from `channel-message-repository.ts` so the DM
// route can reach feature parity. Kept in a clearly-marked section at the end
// of the module so PR 3 (thread replies) merges cleanly above.
// ---------------------------------------------------------------------------

export interface FindDmMessageInConversationInput {
  messageId: string;
  conversationId: string;
}

export type DmReactionRow = InferSelectModel<typeof dmMessageReactions>;

async function findDmMessageInConversation(
  input: FindDmMessageInConversationInput
): Promise<DmMessageRow | null> {
  const row = await db.query.directMessages.findFirst({
    where: and(
      eq(directMessages.id, input.messageId),
      eq(directMessages.conversationId, input.conversationId)
    ),
  });
  return row ?? null;
}

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
  softDeleteMessage,
  purgeInactiveMessages,
  editActiveMessage,
  listActiveMessages,
  markActiveMessagesRead,
  updateConversationLastRead,
  findDmMessageInConversation,
  addDmReaction,
  loadDmReactionWithUser,
  removeDmReaction,
};

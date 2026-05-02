/**
 * Persistence seam for the DM message POST pipeline.
 *
 * Tests mock this module to assert validation outcomes and the insert/update
 * payloads without touching the ORM chain (per unit-test-rubric §4).
 *
 * @module @pagespace/lib/services/dm-message-repository
 */

import { db } from '@pagespace/db/db';
import { and, eq, or, type InferSelectModel } from '@pagespace/db/operators';
import { dmConversations, directMessages } from '@pagespace/db/schema/social';
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
  await db
    .update(dmConversations)
    .set({
      lastMessageAt: input.lastMessageAt,
      lastMessagePreview: input.lastMessagePreview,
    })
    .where(eq(dmConversations.id, input.conversationId));
}

export const dmMessageRepository = {
  findConversationForParticipant,
  validateAttachmentForDm,
  insertDmMessage,
  updateConversationLastMessage,
};

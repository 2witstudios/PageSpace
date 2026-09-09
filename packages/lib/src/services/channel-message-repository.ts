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
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type InferSelectModel } from '@pagespace/db/operators';
import {
  channelMessages,
  channelMessageAttachments,
  channelMessageReactions,
  channelReadStatus,
  channelThreadFollowers,
  type ChannelMessageAiMeta,
} from '@pagespace/db/schema/chat';
import { files } from '@pagespace/db/schema/storage';
import { MAX_MESSAGE_ATTACHMENTS, type MessageAttachmentInput } from './attachment-upload-core';
import { decryptField } from '../encryption/field-crypto';
import { deriveLatestTimestamp } from './message-derived-state';

export type ChannelMessageRow = InferSelectModel<typeof channelMessages>;
export type ChannelReactionRow = InferSelectModel<typeof channelMessageReactions>;

/**
 * Decrypt the joined author/reactor `name` PII on a loaded message row in place
 * (GDPR #965). `messageWith` joins `users.name`, which is AES-GCM ciphertext at
 * rest, so every channel-message read must decrypt it at this seam before the
 * row reaches a route/AI tool/broadcast. Legacy plaintext passes through
 * unchanged. Mutates in place to preserve the precise Drizzle-inferred type.
 */
async function decryptMessageRowPii(
  row:
    | {
        user?: { name: string | null } | null;
        reactions?: Array<{ user?: { name: string | null } | null }> | null;
      }
    | null
    | undefined,
): Promise<void> {
  if (!row) return;
  if (row.user && row.user.name != null) {
    row.user.name = await decryptField(row.user.name);
  }
  if (row.reactions) {
    await Promise.all(
      row.reactions.map(async (r) => {
        if (r.user && r.user.name != null) {
          r.user.name = await decryptField(r.user.name);
        }
      }),
    );
  }
}

const messageWith = {
  user: {
    columns: {
      id: true,
      name: true,
      image: true,
    },
  },
  // Legacy single-attachment relation. Still read so a row written by a pod on
  // the previous build (which set only channel_messages.fileId) still renders;
  // goes away with the columns themselves.
  file: {
    columns: {
      id: true,
      mimeType: true,
      sizeBytes: true,
    },
  },
  // Shaped exactly like `reactions` above — a bare nested `with`. The rows
  // carry `position`; ordering is applied where they are consumed rather than
  // in this shared clause, which is `as const` and so cannot contextually type
  // an orderBy callback.
  attachments: {
    with: {
      file: {
        columns: {
          id: true,
          mimeType: true,
          sizeBytes: true,
        },
      },
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
  mirroredFrom: {
    columns: { parentId: true },
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

  const rows = await db.query.channelMessages.findMany({
    where: and(...conditions),
    with: messageWith,
    orderBy: [desc(channelMessages.createdAt), desc(channelMessages.id)],
    limit: input.limit,
  });
  await Promise.all(rows.map(decryptMessageRowPii));
  return rows;
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
  const row = await db.query.channelMessages.findFirst({
    where: eq(channelMessages.id, id),
    with: messageWith,
  });
  await decryptMessageRowPii(row);
  return row;
}

export interface InsertChannelMessageInput {
  pageId: string;
  userId: string;
  content: string;
  attachments: MessageAttachmentInput[];
  quotedMessageId?: string | null;
  // Optional aiMeta passthrough — the channel webhook publisher (and any future
  // top-level non-human-authored post) needs this the same way
  // insertChannelThreadReply already does for replies.
  aiMeta?: ChannelMessageAiMeta | null;
}

export type InsertChannelMessageResult =
  | { kind: 'ok'; message: ChannelMessageRow }
  | { kind: 'not_found' }
  | { kind: 'too_many_attachments' };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type ChannelAttachmentLockResult = { kind: 'ok' } | { kind: 'not_found' };

/**
 * Lock every attached file row with SELECT ... FOR UPDATE, in one statement
 * ordered by id. Shared by insertChannelMessageWithAttachment and
 * insertChannelThreadReply (the top-level and thread-reply attachment paths)
 * so the two call sites can't drift out of sync with each other — mirrors the
 * `lockDriveRolesInOrder` shared-lock-helper pattern in drive-role-service.ts.
 * Channels have no `fileConversations`-equivalent link table, so this only
 * locks `files`, unlike the DM side's `lockAndValidateDmAttachments`.
 *
 * The ORDER BY is load-bearing now that a message can carry several files: two
 * concurrent sends sharing files {A, B} would otherwise be free to take
 * A-then-B and B-then-A and deadlock. Every path that locks these rows uses the
 * same global order — message rows, then `files` by id asc, then (on the DM
 * side) `file_conversations` by fileId asc.
 *
 * Callers with no attachments should skip calling this entirely — it always
 * locks, so it must stay conditional on a non-empty list at the call site.
 */
async function lockAndValidateChannelAttachments(
  tx: Tx,
  fileIds: string[]
): Promise<ChannelAttachmentLockResult> {
  // The same file may legitimately appear twice in one message: files.id is a
  // content hash, so attaching the same photo twice yields one id. Lock the
  // distinct set, but compare against that same distinct set.
  const unique = [...new Set(fileIds)].sort();

  const rows = await tx
    .select({ id: files.id })
    .from(files)
    .where(inArray(files.id, unique))
    .orderBy(asc(files.id))
    .for('update');

  if (rows.length !== unique.length) {
    return { kind: 'not_found' };
  }

  return { kind: 'ok' };
}

/**
 * Write the attachment rows for a just-inserted message, in the order the
 * client supplied them (which is the display order, and is unrelated to the
 * sorted order the file rows were locked in).
 */
async function insertChannelAttachmentRows(
  tx: Tx,
  messageId: string,
  attachments: MessageAttachmentInput[]
): Promise<void> {
  if (attachments.length === 0) return;
  await tx.insert(channelMessageAttachments).values(
    attachments.map((attachment, position) => ({
      messageId,
      fileId: attachment.fileId,
      attachmentMeta: attachment.attachmentMeta,
      position,
    }))
  );
}

/**
 * Validates the attachment (if any) and inserts the top-level channel
 * message in one transaction. The SELECT ... FOR UPDATE lock on `files`
 * blocks a concurrent delete of that row until this tx commits, so the
 * insert can never land pointing at a fileId that vanished mid-request.
 */
async function insertChannelMessageWithAttachment(
  input: InsertChannelMessageInput
): Promise<InsertChannelMessageResult> {
  if (input.attachments.length > MAX_MESSAGE_ATTACHMENTS) {
    return { kind: 'too_many_attachments' };
  }

  return db.transaction(async (tx) => {
    if (input.attachments.length > 0) {
      const check = await lockAndValidateChannelAttachments(
        tx,
        input.attachments.map((a) => a.fileId)
      );
      if (check.kind !== 'ok') {
        return check;
      }
    }

    const [row] = await tx
      .insert(channelMessages)
      .values({
        pageId: input.pageId,
        userId: input.userId,
        content: input.content,
        // Legacy columns keep carrying the first attachment so readers we have
        // not migrated yet (SDK, CLI, processor) keep working. Note this does
        // NOT protect attachments 1..N from the file reaper — the `file_pages`
        // link written at upload time does. Dropping these columns is a
        // separate, later change.
        fileId: input.attachments[0]?.fileId ?? null,
        attachmentMeta: input.attachments[0]?.attachmentMeta ?? null,
        quotedMessageId: input.quotedMessageId ?? null,
        aiMeta: input.aiMeta ?? undefined,
      })
      .returning();

    await insertChannelAttachmentRows(tx, row.id, input.attachments);

    return { kind: 'ok', message: row };
  });
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
  // Optional aiMeta replacement for non-human-authored messages whose
  // metadata changes on edit (thread replies already support this on insert).
  aiMeta?: ChannelMessageAiMeta | null;
}

/**
 * The "message mutated" recompute for a channel thread's `lastReplyAt`
 * (#2153). Soft-delete/restore of a reply calls this after adjusting
 * `replyCount` so the timestamp always points at a surviving reply instead
 * of a tombstoned one. Mirrors `recomputeThreadLastReply` in
 * `dm-message-repository.ts`, including the parent-row lock: two concurrent
 * reply deletes under the same parent can otherwise each snapshot
 * "surviving replies" before the other's tombstone commits, and the later
 * commit can silently restore `lastReplyAt` to an already-deleted reply.
 */
async function recomputeThreadLastReply(tx: Tx, parentId: string): Promise<void> {
  await tx
    .select({ id: channelMessages.id })
    .from(channelMessages)
    .where(eq(channelMessages.id, parentId))
    .for('update');

  const replies = await tx
    .select({ createdAt: channelMessages.createdAt })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.parentId, parentId),
        eq(channelMessages.isActive, true)
      )
    );

  await tx
    .update(channelMessages)
    .set({ lastReplyAt: deriveLatestTimestamp(replies.map((r) => r.createdAt)) })
    .where(eq(channelMessages.id, parentId));
}

interface ChannelMirrorEditPropagationInput {
  id: string;
  content: string;
  editedAt: Date;
  mirroredFromId: string | null;
}

/**
 * Propagate an edit to the other half of a `mirroredFromId` pair (#2153) —
 * a thread reply and its "Also send to channel" top-level mirror must never
 * disagree after one side is edited. Mirrors `propagateMirrorEdit` in
 * `dm-message-repository.ts`. Deliberately excludes `aiMeta`: that field
 * describes the sender of the specific row being edited, not shared content,
 * so it must never be copied across to the other row.
 */
async function propagateChannelMirrorEdit(
  tx: Tx,
  edited: ChannelMirrorEditPropagationInput
): Promise<void> {
  const patch = { content: edited.content, editedAt: edited.editedAt };
  if (edited.mirroredFromId) {
    await tx
      .update(channelMessages)
      .set(patch)
      .where(eq(channelMessages.id, edited.mirroredFromId));
    return;
  }
  await tx
    .update(channelMessages)
    .set(patch)
    .where(eq(channelMessages.mirroredFromId, edited.id));
}

async function updateChannelMessageContent(
  input: UpdateChannelMessageContentInput
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(channelMessages)
      .set({
        content: input.content,
        editedAt: input.editedAt,
        ...(input.aiMeta !== undefined ? { aiMeta: input.aiMeta } : {}),
      })
      .where(eq(channelMessages.id, input.messageId))
      .returning({
        id: channelMessages.id,
        mirroredFromId: channelMessages.mirroredFromId,
      });

    if (!row) return;

    await propagateChannelMirrorEdit(tx, {
      id: row.id,
      content: input.content,
      editedAt: input.editedAt,
      mirroredFromId: row.mirroredFromId,
    });
  });
}

async function softDeleteChannelMessage(messageId: string): Promise<number> {
  // Soft-deleting a thread reply must decrement the parent's replyCount in the
  // same transaction so the footer count never drifts above the real number of
  // visible replies. The `isActive=true` filter makes a double soft-delete a
  // no-op (returns 0 affected rows), and GREATEST(... - 1, 0) guards against
  // any drift that snuck in before this filter existed.
  return db.transaction(async (tx) => {
    const result = await tx
      .update(channelMessages)
      .set({ isActive: false })
      .where(
        and(
          eq(channelMessages.id, messageId),
          eq(channelMessages.isActive, true)
        )
      )
      .returning({ parentId: channelMessages.parentId });

    const row = result[0];
    if (row?.parentId) {
      await tx
        .update(channelMessages)
        .set({
          replyCount: sql`GREATEST(${channelMessages.replyCount} - 1, 0)`,
        })
        .where(eq(channelMessages.id, row.parentId));
      // The deleted row was itself a reply — its parent's lastReplyAt may
      // have pointed at the row we just tombstoned (#2153).
      await recomputeThreadLastReply(tx, row.parentId);
    }

    return result.length;
  });
}

async function restoreChannelMessage(messageId: string): Promise<number> {
  // Mirror of softDeleteChannelMessage. The parent counter is only bumped when
  // the parent itself is still active — restoring an orphaned reply whose
  // parent was deleted in the meantime must NOT inflate a tombstone's count.
  // The parent re-read uses SELECT ... FOR UPDATE so a concurrent
  // softDeleteChannelMessage(parentId) blocks until our bump commits — the
  // race the insert-side lock prevents on the way in.
  return db.transaction(async (tx) => {
    const result = await tx
      .update(channelMessages)
      .set({ isActive: true })
      .where(
        and(
          eq(channelMessages.id, messageId),
          eq(channelMessages.isActive, false)
        )
      )
      .returning({ parentId: channelMessages.parentId });

    const row = result[0];
    if (row?.parentId) {
      const [parent] = await tx
        .select({ id: channelMessages.id, isActive: channelMessages.isActive })
        .from(channelMessages)
        .where(eq(channelMessages.id, row.parentId))
        .for('update');
      if (parent?.isActive) {
        await tx
          .update(channelMessages)
          .set({
            replyCount: sql`${channelMessages.replyCount} + 1`,
          })
          .where(eq(channelMessages.id, row.parentId));
        // Mirrors the counter bump's own guard — only move lastReplyAt
        // forward for a parent that's still active (#2153).
        await recomputeThreadLastReply(tx, row.parentId);
      }
    }

    return result.length;
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
  const row = await db.query.channelMessageReactions.findFirst({
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
  // Decrypt the reactor's name PII at the edge (GDPR #965).
  if (row?.user && row.user.name != null) {
    row.user.name = await decryptField(row.user.name);
  }
  return row;
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
  attachments: MessageAttachmentInput[];
  alsoSendToParent?: boolean;
  // Optional aiMeta passthrough — agent-authored replies (mention responder)
  // need senderType + senderName so the rendered row reads "AgentTitle (User)"
  // instead of the user's display name. Auto-follow logic is unchanged: PR 3
  // upserts (parentAuthor, replier) regardless of aiMeta, and aiMeta only
  // affects how the reply itself is shown.
  aiMeta?: ChannelMessageAiMeta | null;
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
  | { kind: 'parent_not_top_level' }
  | { kind: 'not_found' }
  | { kind: 'too_many_attachments' };

/**
 * Locks the parent row, then (if anything is attached) the file rows via
 * `lockAndValidateChannelAttachments`, before inserting the reply and its
 * optional `alsoSendToParent` mirror — all inside one transaction. Mirrors
 * `insertDmThreadReply`'s lock ordering (parent -> files); channels have no
 * `fileConversations`-equivalent link table, so there's nothing to lock
 * beyond the files themselves. The lock is taken once and covers both the
 * reply and the mirror row, since both reference the same input.attachments
 * inside this same transaction.
 */
async function insertChannelThreadReply(
  input: InsertChannelThreadReplyInput
): Promise<InsertChannelThreadReplyResult> {
  if (input.attachments.length > MAX_MESSAGE_ATTACHMENTS) {
    return { kind: 'too_many_attachments' };
  }

  return db.transaction(async (tx) => {
    // SELECT ... FOR UPDATE locks the parent row for the rest of this tx so a
    // concurrent softDeleteChannelMessage(parentId) blocks until our INSERT and
    // replyCount UPDATE commit. Without this lock, the parent could flip
    // isActive=false between validation and INSERT, leaving an orphaned reply
    // attached to a tombstoned parent.
    const [parent] = await tx
      .select({
        id: channelMessages.id,
        pageId: channelMessages.pageId,
        parentId: channelMessages.parentId,
        userId: channelMessages.userId,
        isActive: channelMessages.isActive,
      })
      .from(channelMessages)
      .where(eq(channelMessages.id, input.parentId))
      .for('update');

    if (!parent || !parent.isActive) {
      return { kind: 'parent_not_found' };
    }
    if (parent.pageId !== input.pageId) {
      return { kind: 'parent_wrong_page' };
    }
    if (parent.parentId !== null) {
      return { kind: 'parent_not_top_level' };
    }

    if (input.attachments.length > 0) {
      const check = await lockAndValidateChannelAttachments(
        tx,
        input.attachments.map((a) => a.fileId)
      );
      if (check.kind !== 'ok') {
        return check;
      }
    }

    const [reply] = await tx
      .insert(channelMessages)
      .values({
        pageId: input.pageId,
        userId: input.userId,
        content: input.content,
        fileId: input.attachments[0]?.fileId ?? null,
        attachmentMeta: input.attachments[0]?.attachmentMeta ?? null,
        parentId: input.parentId,
        aiMeta: input.aiMeta ?? undefined,
      })
      .returning();

    await insertChannelAttachmentRows(tx, reply.id, input.attachments);

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
          fileId: input.attachments[0]?.fileId ?? null,
          attachmentMeta: input.attachments[0]?.attachmentMeta ?? null,
          mirroredFromId: reply.id,
        })
        .returning();
      // The mirror is a distinct message row, so it needs its own attachment
      // rows — the same files, in the same display order.
      await insertChannelAttachmentRows(tx, mirrorRow.id, input.attachments);
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

  const rows = await db.query.channelMessages.findMany({
    where: and(...conditions),
    with: messageWith,
    orderBy: [asc(channelMessages.createdAt), asc(channelMessages.id)],
    limit: input.limit,
  });
  await Promise.all(rows.map(decryptMessageRowPii));
  return rows;
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
  insertChannelMessageWithAttachment,
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

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
import { decryptField } from '../encryption/field-crypto';
import { deriveConversationLastMessage, deriveLatestTimestamp } from './message-derived-state';

/**
 * Decrypt the joined sender/reactor `name` PII on a loaded DM row in place
 * (GDPR #965). `dmMessageWith` joins `users.name` (AES-GCM ciphertext at rest),
 * so every DM read must decrypt it at this seam. Legacy plaintext passes through.
 */
async function decryptDmRowPii(
  row:
    | {
        sender?: { name: string | null } | null;
        reactions?: Array<{ user?: { name: string | null } | null }> | null;
      }
    | null
    | undefined,
): Promise<void> {
  if (!row) return;
  if (row.sender && row.sender.name != null) {
    row.sender.name = await decryptField(row.sender.name);
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
  mirroredFrom: {
    columns: { parentId: true },
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

export interface InsertDmMessageInput {
  conversationId: string;
  senderId: string;
  content: string;
  fileId: string | null;
  attachmentMeta: AttachmentMeta | null;
  quotedMessageId?: string | null;
}

export type DmMessageRow = InferSelectModel<typeof directMessages>;

export type InsertDmMessageResult =
  | { kind: 'ok'; message: DmMessageRow }
  | { kind: 'not_found' }
  | { kind: 'wrong_owner' }
  | { kind: 'not_linked' };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type DmAttachmentLockResult =
  | { kind: 'ok' }
  | { kind: 'not_found' }
  | { kind: 'wrong_owner' }
  | { kind: 'not_linked' };

/**
 * Lock the file row, then (if owned) the file-conversation link row, with
 * SELECT ... FOR UPDATE. Shared by insertDmMessageWithAttachment and
 * insertDmThreadReply (the top-level and thread-reply attachment paths) so
 * the two call sites can't drift out of sync with each other — mirrors the
 * `lockDriveRolesInOrder` shared-lock-helper pattern in drive-role-service.ts.
 *
 * The locks are one half of a two-sided protocol with `purgeInactiveMessages`:
 * purge locks the same link rows (FOR UPDATE) before its orphan-check DELETE,
 * so whichever side wins the lock, the loser observes the winner's committed
 * state — a caller that loses sees the link already gone and rejects with
 * `not_linked`; a purge that loses re-checks with a fresh snapshot and sees
 * the message the caller committed, keeping the link. The lock alone would
 * NOT be enough: a single blocked DELETE keeps its pre-block snapshot, which
 * is why purge re-checks in a separate statement.
 *
 * Callers without a fileId should skip calling this entirely — it always
 * locks, so it must stay conditional on `input.fileId` at the call site.
 */
async function lockAndValidateDmAttachment(
  tx: Tx,
  input: { fileId: string; senderId: string; conversationId: string }
): Promise<DmAttachmentLockResult> {
  const [file] = await tx
    .select({ id: files.id, createdBy: files.createdBy })
    .from(files)
    .where(eq(files.id, input.fileId))
    .for('update');

  if (!file) {
    return { kind: 'not_found' };
  }
  if (file.createdBy !== input.senderId) {
    return { kind: 'wrong_owner' };
  }

  const [link] = await tx
    .select({ fileId: fileConversations.fileId })
    .from(fileConversations)
    .where(
      and(
        eq(fileConversations.fileId, input.fileId),
        eq(fileConversations.conversationId, input.conversationId)
      )
    )
    .for('update');

  if (!link) {
    return { kind: 'not_linked' };
  }

  return { kind: 'ok' };
}

/**
 * Validates the attachment (if any) and inserts the top-level DM in one
 * transaction. Without this, a validate-then-insert-later split lets a
 * concurrent `purgeInactiveMessages` orphan-link cleanup delete the
 * `fileConversations` row between our validation read and the INSERT. See
 * `lockAndValidateDmAttachment`'s doc comment for the full lock protocol.
 */
async function insertDmMessageWithAttachment(
  input: InsertDmMessageInput
): Promise<InsertDmMessageResult> {
  return db.transaction(async (tx) => {
    if (input.fileId) {
      const check = await lockAndValidateDmAttachment(tx, {
        fileId: input.fileId,
        senderId: input.senderId,
        conversationId: input.conversationId,
      });
      if (check.kind !== 'ok') {
        return check;
      }
    }

    const [row] = await tx
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

    await recomputeConversationLastMessage(tx, input.conversationId);

    return { kind: 'ok', message: row };
  });
}

/**
 * The single "message mutated" recompute for `dmConversations.lastMessageAt`
 * / `lastMessagePreview` (#2153). Every mutation that can change which
 * top-level message is newest — insert, edit, soft-delete, restore, purge —
 * calls this instead of writing the derived fields ad hoc, so none of them
 * can drift from the surviving rows.
 *
 * Locks the conversation row FIRST, before reading the surviving messages.
 * Without this, two concurrent recomputes for the same conversation (e.g.
 * two concurrent sends) can each snapshot "newest message" before the
 * other's insert commits — whichever recompute commits last then silently
 * overwrites a fresher preview with a stale one, and nothing repairs it
 * until the next mutation touches that conversation. The lock forces
 * concurrent recomputes to serialize: the second one only proceeds after
 * the first commits, at which point its own SELECT sees the first's
 * already-committed row too. Mirrors the `SELECT ... FOR UPDATE` pattern
 * `restoreDmMessage` already uses to serialize a parent-row bump against a
 * concurrent soft-delete.
 */
async function recomputeConversationLastMessage(
  tx: Tx,
  conversationId: string
): Promise<void> {
  await tx
    .select({ id: dmConversations.id })
    .from(dmConversations)
    .where(eq(dmConversations.id, conversationId))
    .for('update');

  const [newest] = await tx
    .select({
      createdAt: directMessages.createdAt,
      content: directMessages.content,
      attachmentMeta: directMessages.attachmentMeta,
    })
    .from(directMessages)
    .where(
      and(
        eq(directMessages.conversationId, conversationId),
        eq(directMessages.isActive, true),
        isNull(directMessages.parentId)
      )
    )
    .orderBy(desc(directMessages.createdAt))
    .limit(1);

  const derived = deriveConversationLastMessage(newest ?? null);

  await tx
    .update(dmConversations)
    .set({
      lastMessageAt: derived.lastMessageAt,
      lastMessagePreview: derived.lastMessagePreview,
    })
    .where(eq(dmConversations.id, conversationId));
}

/**
 * The "message mutated" recompute for a DM thread's `lastReplyAt` (#2153).
 * Soft-delete/restore of a reply calls this after adjusting `replyCount` so
 * the timestamp always points at a surviving reply instead of a tombstoned
 * one.
 *
 * Locks the parent row first, for the same reason
 * `recomputeConversationLastMessage` locks the conversation row: two
 * concurrent reply deletes under the same parent can otherwise each
 * snapshot "surviving replies" before the other's tombstone commits, and
 * the later commit can silently restore `lastReplyAt` to an
 * already-deleted reply.
 */
async function recomputeThreadLastReply(tx: Tx, parentId: string): Promise<void> {
  await tx
    .select({ id: directMessages.id })
    .from(directMessages)
    .where(eq(directMessages.id, parentId))
    .for('update');

  const replies = await tx
    .select({ createdAt: directMessages.createdAt })
    .from(directMessages)
    .where(
      and(
        eq(directMessages.parentId, parentId),
        eq(directMessages.isActive, true)
      )
    );

  await tx
    .update(directMessages)
    .set({ lastReplyAt: deriveLatestTimestamp(replies.map((r) => r.createdAt)) })
    .where(eq(directMessages.id, parentId));
}

interface MirrorEditPropagationInput {
  id: string;
  content: string;
  isEdited: boolean;
  editedAt: Date;
  mirroredFromId: string | null;
}

/**
 * Propagate an edit to the other half of a `mirroredFromId` pair (#2153) —
 * a thread reply and its "Also send to DM" top-level mirror must never
 * disagree after one side is edited. Whichever side was edited, this finds
 * and updates its sibling: if the edited row itself carries
 * `mirroredFromId`, it IS the mirror, so update the source reply; otherwise
 * look for a mirror row pointing back at the edited row. A message with no
 * mirror relationship in either direction makes the second branch a no-op
 * (zero rows match).
 */
async function propagateMirrorEdit(
  tx: Tx,
  edited: MirrorEditPropagationInput
): Promise<void> {
  const patch = {
    content: edited.content,
    isEdited: edited.isEdited,
    editedAt: edited.editedAt,
  };
  if (edited.mirroredFromId) {
    await tx
      .update(directMessages)
      .set(patch)
      .where(eq(directMessages.id, edited.mirroredFromId));
    return;
  }
  await tx
    .update(directMessages)
    .set(patch)
    .where(eq(directMessages.mirroredFromId, edited.id));
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
      .returning({
        id: directMessages.id,
        parentId: directMessages.parentId,
        conversationId: directMessages.conversationId,
      });

    const row = result[0];
    if (row?.parentId) {
      await tx
        .update(directMessages)
        .set({
          replyCount: sql`GREATEST(${directMessages.replyCount} - 1, 0)`,
        })
        .where(eq(directMessages.id, row.parentId));
      // The deleted row was itself a reply — its parent's lastReplyAt may
      // have pointed at the row we just tombstoned (#2153).
      await recomputeThreadLastReply(tx, row.parentId);
    }
    if (row) {
      // Recompute unconditionally, not just for a top-level delete — a
      // tombstoned mirror row is also top-level (parentId === null) and
      // must repair the inbox preview the same way a plain top-level
      // delete does.
      await recomputeConversationLastMessage(tx, row.conversationId);
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
      .returning({
        id: directMessages.id,
        parentId: directMessages.parentId,
        conversationId: directMessages.conversationId,
      });

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
        // Mirrors the counter bump's own guard — only move lastReplyAt
        // forward for a parent that's still active (#2153).
        await recomputeThreadLastReply(tx, row.parentId);
      }
    }
    if (row) {
      await recomputeConversationLastMessage(tx, row.conversationId);
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
      const pairValues = () =>
        sql.join(
          purgedAttachmentPairs.map((pair) => sql`(${pair.fileId}, ${pair.conversationId})`),
          sql`, `
        );

      // Lock the candidate link rows BEFORE the orphan-check DELETE. A
      // concurrent top-level send (insertDmMessageWithAttachment) holds
      // FOR UPDATE on its link row while inserting the message, so this
      // SELECT blocks until that send commits. The DELETE below then runs
      // as a separate statement with a fresh READ COMMITTED snapshot, so
      // its NOT EXISTS sees the just-committed message and keeps the link.
      // Folding the lock into the DELETE would not work: a DELETE keeps
      // the snapshot it took before blocking, so its NOT EXISTS could miss
      // a message that committed while it waited and still drop the link.
      await tx.execute(sql`
        SELECT 1
        FROM file_conversations fc
        JOIN (VALUES ${pairValues()}) AS pp("fileId", "conversationId")
          ON fc."fileId" = pp."fileId"
         AND fc."conversationId" = pp."conversationId"
        FOR UPDATE OF fc
      `);

      await tx.execute(sql`
        WITH purged_pairs("fileId", "conversationId") AS (
          VALUES ${pairValues()}
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

    // Repair any conversation whose preview drifted before this fix existed
    // — a purge is exactly the kind of non-insert mutation path the issue
    // calls out as able to skip the bump silently (#2153).
    const purgedConversationIds = new Set(purgedMessages.map((m) => m.conversationId));
    for (const conversationId of purgedConversationIds) {
      await recomputeConversationLastMessage(tx, conversationId);
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
  return db.transaction(async (tx) => {
    const result = await tx
      .update(directMessages)
      .set({ content: input.content, isEdited: true, editedAt: input.editedAt })
      .where(
        and(
          eq(directMessages.id, input.messageId),
          eq(directMessages.isActive, true)
        )
      )
      .returning({
        id: directMessages.id,
        conversationId: directMessages.conversationId,
        mirroredFromId: directMessages.mirroredFromId,
      });

    const row = result[0];
    if (!row) return 0;

    // The edited row may itself be a mirror, or may have its own mirror
    // (#2153) — propagate either way so the two copies can't disagree.
    await propagateMirrorEdit(tx, {
      id: row.id,
      content: input.content,
      isEdited: true,
      editedAt: input.editedAt,
      mirroredFromId: row.mirroredFromId,
    });

    // Whichever side changed content might be the top-level message the
    // conversation preview is derived from — recompute unconditionally
    // rather than threading a "was this row top-level" check through here.
    await recomputeConversationLastMessage(tx, row.conversationId);

    return result.length;
  });
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

  const rows = await db.query.directMessages.findMany({
    where: and(...baseFilters),
    with: dmMessageWith,
    orderBy: [desc(directMessages.createdAt)],
    limit: input.limit,
  });
  await Promise.all(rows.map(decryptDmRowPii));
  return rows;
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
  | { kind: 'parent_not_top_level' }
  | { kind: 'not_found' }
  | { kind: 'wrong_owner' }
  | { kind: 'not_linked' };

/**
 * Locks the parent row, then (if a fileId is attached) the file + link rows
 * via `lockAndValidateDmAttachment`, before inserting the reply and its
 * optional `alsoSendToParent` mirror — all inside one transaction. Lock order
 * is parent -> files -> fileConversations, which never conflicts with
 * `insertDmMessageWithAttachment` (files -> fileConversations, no parent
 * lock) or `purgeInactiveMessages` (fileConversations only, never a
 * parent/directMessages row), so this can't introduce a deadlock.
 *
 * The file/link lock is taken once and covers both the reply and the mirror
 * row: both reference the same input.fileId within this same transaction, so
 * a single FOR UPDATE on each row is sufficient for both inserts.
 */
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

    if (input.fileId) {
      const check = await lockAndValidateDmAttachment(tx, {
        fileId: input.fileId,
        senderId: input.senderId,
        conversationId: input.conversationId,
      });
      if (check.kind !== 'ok') {
        return check;
      }
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
      // The mirror is a top-level row and behaves like a regular send —
      // recompute the conversation preview from it (#2153). A thread-only
      // reply (no mirror) intentionally does NOT reach this — it doesn't
      // touch the top-level stream the preview is derived from.
      await recomputeConversationLastMessage(tx, input.conversationId);
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

  const rows = await db.query.directMessages.findMany({
    where: and(...conditions),
    with: dmMessageWith,
    orderBy: [asc(directMessages.createdAt), asc(directMessages.id)],
    limit: input.limit,
  });
  await Promise.all(rows.map(decryptDmRowPii));
  return rows;
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
  const row = await db.query.dmMessageReactions.findFirst({
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
  // Decrypt the reactor's name PII at the edge (GDPR #965) — this row is
  // broadcast and returned to clients (legacy plaintext passes through).
  if (row?.user && row.user.name != null) {
    row.user.name = await decryptField(row.user.name);
  }
  return row;
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
  insertDmMessageWithAttachment,
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

/**
 * Pure derivations for the denormalized message metadata (#2153).
 *
 * `dmConversations.lastMessageAt`/`lastMessagePreview` and thread
 * `lastReplyAt` are copies derived from the surviving active message rows.
 * These functions are the single source for computing those values — the
 * repository shells fetch the surviving rows and apply what these return, so
 * every mutation path (insert, edit, delete, restore, purge, stream
 * recovery) recomputes the same way instead of re-implementing the bump at
 * each insert site and forgetting it at each non-insert site.
 *
 * @module @pagespace/lib/services/message-derived-state
 */

import type { AttachmentMeta } from '@pagespace/db/schema/storage';

/**
 * Inbox preview for a message: trimmed content (truncated at 100 chars),
 * falling back to an attachment placeholder, falling back to ''.
 * Shared by the DM send route (notification/broadcast payloads) and the
 * conversation recompute so the two can never derive different previews.
 */
export function buildLastMessagePreview(
  content: string,
  attachmentMeta: AttachmentMeta | null
): string {
  const trimmed = content.trim();
  if (trimmed.length > 0) {
    return trimmed.length > 100 ? trimmed.substring(0, 100) + '...' : trimmed;
  }
  if (attachmentMeta) {
    const isImage = attachmentMeta.mimeType.startsWith('image/');
    return isImage
      ? `[image: ${attachmentMeta.originalName}]`
      : `[file: ${attachmentMeta.originalName}]`;
  }
  return '';
}

export interface NewestConversationMessage {
  createdAt: Date;
  content: string;
  attachmentMeta: AttachmentMeta | null;
}

export interface ConversationLastMessageState {
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
}

/**
 * Derive a DM conversation's inbox fields from its newest surviving active
 * top-level message. `null` (nothing survives) clears both fields so deleted
 * content cannot linger in the inbox.
 */
export function deriveConversationLastMessage(
  newest: NewestConversationMessage | null
): ConversationLastMessageState {
  if (!newest) {
    return { lastMessageAt: null, lastMessagePreview: null };
  }
  return {
    lastMessageAt: newest.createdAt,
    lastMessagePreview: buildLastMessagePreview(newest.content, newest.attachmentMeta),
  };
}

/**
 * Latest of the surviving timestamps, or `null` when none survive. Used for
 * thread `lastReplyAt` (from the active replies) and global
 * `conversations.lastMessageAt` (from the active messages).
 */
export function deriveLatestTimestamp(timestamps: readonly Date[]): Date | null {
  let latest: Date | null = null;
  for (const t of timestamps) {
    if (latest === null || t.getTime() > latest.getTime()) {
      latest = t;
    }
  }
  return latest;
}

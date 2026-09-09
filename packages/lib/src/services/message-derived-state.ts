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
  attachmentMeta: AttachmentMeta | AttachmentMeta[] | null
): string {
  const trimmed = content.trim();
  if (trimmed.length > 0) {
    return trimmed.length > 100 ? trimmed.substring(0, 100) + '...' : trimmed;
  }

  // Accepts a single meta so the legacy single-attachment call sites keep
  // working unchanged while N-attachment callers pass the whole array.
  const attachments = attachmentMeta === null
    ? []
    : Array.isArray(attachmentMeta)
      ? attachmentMeta
      : [attachmentMeta];

  if (attachments.length === 1) {
    const only = attachments[0];
    return only.mimeType.startsWith('image/')
      ? `[image: ${only.originalName}]`
      : `[file: ${only.originalName}]`;
  }

  if (attachments.length > 1) {
    const images = attachments.filter((a) => a.mimeType.startsWith('image/')).length;
    // Name the count rather than one arbitrary filename — "[image: a.png]" for
    // a five-photo send reads as though four of them went missing.
    if (images === attachments.length) return `[${images} images]`;
    if (images === 0) return `[${attachments.length} files]`;
    return `[${attachments.length} attachments]`;
  }

  return '';
}

export interface NewestConversationMessage {
  createdAt: Date;
  content: string;
  attachmentMeta: AttachmentMeta | AttachmentMeta[] | null;
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

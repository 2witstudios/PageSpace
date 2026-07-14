import { applyMessageDelete } from '@/lib/ai/streams/applyMessageDelete';
import type { ConversationMessagesById } from './seedEmpty';

export interface ApplyConversationDeleteEvent {
  conversationId: string;
  messageId: string;
}

/**
 * Applies a remote delete broadcast to a conversation's messages and
 * optimisticSends, reusing `applyMessageDelete`.
 *
 * Always records the delete in `pendingMutationsSinceLoad`, regardless of
 * which array (if either) actually lost the id locally. There's no
 * ordering guarantee between this broadcast and any load's DB snapshot, so
 * a delete that's currently a local no-op still needs to be replayed onto
 * a load response that might independently include the row:
 * - The id was only in `optimisticSends` (an unconfirmed send that had
 *   *already been persisted* server-side by the time it was deleted, just
 *   not yet reconciled into `messages` locally) — an in-flight load's
 *   snapshot can legitimately include it.
 * - The id wasn't locally known at all yet (e.g. sent and deleted before
 *   this client observed either event) — an in-flight load's stale
 *   snapshot can still include it.
 * Replaying a delete for an id a load's snapshot doesn't contain is a safe
 * no-op (`applyMessageDelete` itself no-ops on a missing id).
 */
export const applyConversationDelete = (
  byConversationId: ConversationMessagesById,
  event: ApplyConversationDeleteEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId];
  if (!existing) return byConversationId;

  return {
    ...byConversationId,
    [event.conversationId]: {
      ...existing,
      messages: applyMessageDelete(existing.messages, event.messageId),
      optimisticSends: applyMessageDelete(existing.optimisticSends, event.messageId),
      pendingMutationsSinceLoad: [
        ...existing.pendingMutationsSinceLoad,
        { type: 'delete', messageId: event.messageId },
      ],
    },
  };
};

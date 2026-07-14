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
 * Records the delete in `pendingMutationsSinceLoad` only when it actually
 * removed a *confirmed* message: there is no ordering guarantee between this
 * broadcast and any load's DB snapshot, so `applyLoad` replays pending
 * mutations onto its snapshot rather than this function invalidating the
 * load outright. A delete that only removed an optimistic (unconfirmed) send
 * needs no replay — an unconfirmed message can never appear in a DB
 * snapshot in the first place.
 */
export const applyConversationDelete = (
  byConversationId: ConversationMessagesById,
  event: ApplyConversationDeleteEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId];
  if (!existing) return byConversationId;

  const messages = applyMessageDelete(existing.messages, event.messageId);
  const optimisticSends = applyMessageDelete(existing.optimisticSends, event.messageId);
  if (messages === existing.messages && optimisticSends === existing.optimisticSends) return byConversationId;

  const pendingMutationsSinceLoad =
    messages === existing.messages
      ? existing.pendingMutationsSinceLoad
      : [...existing.pendingMutationsSinceLoad, { type: 'delete' as const, messageId: event.messageId }];

  return {
    ...byConversationId,
    [event.conversationId]: { ...existing, messages, optimisticSends, pendingMutationsSinceLoad },
  };
};

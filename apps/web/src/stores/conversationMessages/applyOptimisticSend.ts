import type { UIMessage } from 'ai';
import { seedEmpty } from './seedEmpty';
import type { ConversationMessagesById } from './seedEmpty';

export interface ApplyOptimisticSendEvent {
  conversationId: string;
  message: UIMessage;
}

/**
 * Appends a client-minted user message to `optimisticSends` in send order.
 * No-ops when the id already appears in `messages` or `optimisticSends` —
 * a caller retrying a send (or a duplicate dispatch) must not duplicate the
 * bubble.
 */
export const applyOptimisticSend = (
  byConversationId: ConversationMessagesById,
  event: ApplyOptimisticSendEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId] ?? seedEmpty();
  const alreadyPresent =
    existing.messages.some((m) => m.id === event.message.id) ||
    existing.optimisticSends.some((m) => m.id === event.message.id);
  if (alreadyPresent) return byConversationId;

  return {
    ...byConversationId,
    [event.conversationId]: {
      ...existing,
      optimisticSends: [...existing.optimisticSends, event.message],
    },
  };
};

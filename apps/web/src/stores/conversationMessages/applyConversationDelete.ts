import { applyMessageDelete } from '@/lib/ai/streams/applyMessageDelete';
import type { ConversationMessagesById } from './seedEmpty';

export interface ApplyConversationDeleteEvent {
  conversationId: string;
  messageId: string;
}

/** Applies a remote delete broadcast to a conversation's messages and optimisticSends, reusing `applyMessageDelete`. */
export const applyConversationDelete = (
  byConversationId: ConversationMessagesById,
  event: ApplyConversationDeleteEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId];
  if (!existing) return byConversationId;

  const messages = applyMessageDelete(existing.messages, event.messageId);
  const optimisticSends = applyMessageDelete(existing.optimisticSends, event.messageId);
  if (messages === existing.messages && optimisticSends === existing.optimisticSends) return byConversationId;

  return {
    ...byConversationId,
    [event.conversationId]: { ...existing, messages, optimisticSends },
  };
};

import { applyMessageEdit, type MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';
import type { ConversationMessagesById } from './seedEmpty';

export interface ApplyConversationEditEvent {
  conversationId: string;
  payload: MessageEditPayload;
}

/** Applies a remote edit broadcast to a conversation's confirmed messages, reusing `applyMessageEdit`. */
export const applyConversationEdit = (
  byConversationId: ConversationMessagesById,
  event: ApplyConversationEditEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId];
  if (!existing) return byConversationId;

  const messages = applyMessageEdit(existing.messages, event.payload);
  if (messages === existing.messages) return byConversationId;

  return {
    ...byConversationId,
    [event.conversationId]: { ...existing, messages },
  };
};

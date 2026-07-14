import { applyMessageEdit, type MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';
import type { ConversationMessagesById } from './seedEmpty';

export interface ApplyConversationEditEvent {
  conversationId: string;
  payload: MessageEditPayload;
}

/**
 * Applies a remote edit broadcast to a conversation's confirmed messages,
 * reusing `applyMessageEdit`.
 *
 * Bumps `loadGeneration` on an actual change: a load already in flight was
 * snapshotted before this edit necessarily landed, so it must not be allowed
 * to later overwrite `messages` and silently undo the edit — bumping the
 * generation makes that in-flight `applyLoad` stale so it gets rejected.
 */
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
    [event.conversationId]: { ...existing, messages, loadGeneration: existing.loadGeneration + 1 },
  };
};

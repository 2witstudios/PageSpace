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
 * Bumps `loadGeneration` on an actual change: a load already in flight was
 * snapshotted before this delete necessarily landed, so it must not be
 * allowed to later overwrite `messages` and silently resurrect the deleted
 * row — bumping the generation makes that in-flight `applyLoad` stale so it
 * gets rejected.
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

  return {
    ...byConversationId,
    [event.conversationId]: { ...existing, messages, optimisticSends, loadGeneration: existing.loadGeneration + 1 },
  };
};

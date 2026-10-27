import { applyMessageDelete } from '@/lib/ai/streams/applyMessageDelete';
import type { ConversationMessagesById } from './seedEmpty';

export interface ApplyOptimisticSendFailureEvent {
  conversationId: string;
  messageId: string;
}

/**
 * Rolls back an optimistic send whose POST rejected (epic leaf 6.5, M9 — a
 * credit-gate 402 fires BEFORE the user message is persisted). ONLY touches
 * `optimisticSends`, never `messages` — if the id has already been promoted/
 * reconciled into confirmed messages by the time this fires (a late rejection
 * racing a fast broadcast), it is a genuinely persisted row and must survive.
 */
export const applyOptimisticSendFailure = (
  byConversationId: ConversationMessagesById,
  event: ApplyOptimisticSendFailureEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId];
  if (!existing) return byConversationId;

  const nextOptimisticSends = applyMessageDelete(existing.optimisticSends, event.messageId);
  if (nextOptimisticSends === existing.optimisticSends) return byConversationId;

  return {
    ...byConversationId,
    [event.conversationId]: {
      ...existing,
      optimisticSends: nextOptimisticSends,
    },
  };
};

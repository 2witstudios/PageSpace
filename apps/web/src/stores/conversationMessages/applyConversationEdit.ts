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
 * Always records the edit in `pendingMutationsSinceLoad`, even when
 * `applyMessageEdit` is a local no-op (the target id isn't in `messages`
 * yet — e.g. a conversation still loading for the first time). There's no
 * ordering guarantee between this broadcast and any load's DB snapshot: a
 * snapshot taken before the edit but resolving after it would otherwise
 * commit the pre-edit row with no queued mutation to fix it (PR #2075
 * review). Replaying an edit for an id the snapshot also lacks is a safe
 * no-op (`applyMessageEdit` itself no-ops on a missing id).
 */
export const applyConversationEdit = (
  byConversationId: ConversationMessagesById,
  event: ApplyConversationEditEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId];
  if (!existing) return byConversationId;

  return {
    ...byConversationId,
    [event.conversationId]: {
      ...existing,
      messages: applyMessageEdit(existing.messages, event.payload),
      // The user's own just-sent message lives in optimisticSends until promoted or
      // load-reconciled — an edit of it must render too (the delete transition already
      // handled both arrays; edit was the asymmetric one — F4, PR #2098 review).
      optimisticSends: applyMessageEdit(existing.optimisticSends, event.payload),
      pendingMutationsSinceLoad: [...existing.pendingMutationsSinceLoad, { type: 'edit', payload: event.payload }],
    },
  };
};

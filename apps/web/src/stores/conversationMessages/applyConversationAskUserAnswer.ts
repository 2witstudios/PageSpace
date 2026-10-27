import { applyAskUserAnswer, type AskUserAnswerPayload } from '@/lib/ai/streams/applyAskUserAnswer';
import type { ConversationMessagesById } from './seedEmpty';

export interface ApplyConversationAskUserAnswerEvent {
  conversationId: string;
  payload: AskUserAnswerPayload;
}

/**
 * Applies an optimistic ask_user answer to a conversation's confirmed
 * messages, reusing `applyAskUserAnswer`.
 *
 * Always records the answer in `pendingMutationsSinceLoad`, even when
 * `applyAskUserAnswer` is a local no-op (the target message isn't in
 * `messages` yet) — the same reasoning as `applyConversationEdit`: a load
 * whose DB snapshot predates the server's own merge of this answer must not
 * be allowed to resurrect `input-available` once it lands (epic leaf 6.3
 * acceptance: "reconcile-by-id preserves the optimistic answer").
 */
export const applyConversationAskUserAnswer = (
  byConversationId: ConversationMessagesById,
  event: ApplyConversationAskUserAnswerEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId];
  if (!existing) return byConversationId;

  return {
    ...byConversationId,
    [event.conversationId]: {
      ...existing,
      messages: applyAskUserAnswer(existing.messages, event.payload),
      pendingMutationsSinceLoad: [
        ...existing.pendingMutationsSinceLoad,
        { type: 'askUserAnswer', payload: event.payload },
      ],
    },
  };
};

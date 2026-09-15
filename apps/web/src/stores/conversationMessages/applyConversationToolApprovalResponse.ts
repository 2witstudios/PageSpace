import { applyToolApprovalResponse, type ToolApprovalResponsePayload } from '@/lib/ai/streams/applyToolApprovalResponse';
import type { ConversationMessagesById } from './seedEmpty';

export interface ApplyConversationToolApprovalResponseEvent {
  conversationId: string;
  payload: ToolApprovalResponsePayload;
}

/**
 * Applies an optimistic tool-approval answer to a conversation's confirmed
 * messages — the approval twin of `applyConversationAskUserAnswer`.
 *
 * Always records the answer in `pendingMutationsSinceLoad`, even when the
 * patch is a local no-op: a load whose DB snapshot predates the server's own
 * merge must not resurrect `approval-requested` once it lands.
 */
export const applyConversationToolApprovalResponse = (
  byConversationId: ConversationMessagesById,
  event: ApplyConversationToolApprovalResponseEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId];
  if (!existing) return byConversationId;

  return {
    ...byConversationId,
    [event.conversationId]: {
      ...existing,
      messages: applyToolApprovalResponse(existing.messages, event.payload),
      pendingMutationsSinceLoad: [
        ...existing.pendingMutationsSinceLoad,
        { type: 'toolApprovalResponse', payload: event.payload },
      ],
    },
  };
};

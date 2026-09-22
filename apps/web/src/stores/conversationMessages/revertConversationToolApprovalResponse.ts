import { revertToolApprovalResponse, type ToolApprovalRevertPayload } from '@/lib/ai/streams/applyToolApprovalResponse';
import type { ConversationMessagesById } from './seedEmpty';

export interface RevertConversationToolApprovalResponseEvent {
  conversationId: string;
  payload: ToolApprovalRevertPayload;
}

/**
 * Undoes an optimistic tool-approval answer the server rejected (a 409: another
 * tab, or a typed message, decided first).
 *
 * Two things, and both matter: the part goes back to `approval-requested`
 * (only if it is still our optimistic `approval-responded` — newer server truth
 * is left alone, see `applyToolApprovalResponse.ts`), AND the answer recorded in
 * `pendingMutationsSinceLoad` by `applyConversationToolApprovalResponse` is
 * retracted. Without the retraction a load in flight during the round-trip
 * would replay the withdrawn answer over whatever the snapshot says.
 */
export const revertConversationToolApprovalResponse = (
  byConversationId: ConversationMessagesById,
  event: RevertConversationToolApprovalResponseEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId];
  if (!existing) return byConversationId;

  const { messageId, toolCallId } = event.payload;
  return {
    ...byConversationId,
    [event.conversationId]: {
      ...existing,
      messages: revertToolApprovalResponse(existing.messages, event.payload),
      pendingMutationsSinceLoad: existing.pendingMutationsSinceLoad.filter(
        (mutation) =>
          !(
            mutation.type === 'toolApprovalResponse' &&
            mutation.payload.messageId === messageId &&
            mutation.payload.toolCallId === toolCallId
          ),
      ),
    },
  };
};

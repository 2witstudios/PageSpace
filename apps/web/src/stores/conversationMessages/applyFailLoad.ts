import type { ConversationMessagesById } from './seedEmpty';

export interface ApplyFailLoadEvent {
  conversationId: string;
  generation: number;
}

/**
 * A failed reload must never clear cached messages — the store exists so a
 * transient fetch failure can't blank a conversation that already rendered
 * (the historical bug this replaces: an effect calling `setMessages([])` on
 * error). Always a no-op over `byConversationId`, for both a current and a
 * stale generation; kept as its own named transition (rather than inlined at
 * the call site) so the "never clear on failure" guarantee is one pure,
 * individually-tested unit instead of caller discipline.
 */
export const applyFailLoad = (
  byConversationId: ConversationMessagesById,
  _event: ApplyFailLoadEvent,
): ConversationMessagesById => byConversationId;

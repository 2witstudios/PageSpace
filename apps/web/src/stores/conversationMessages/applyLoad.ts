import type { UIMessage } from 'ai';
import type { ConversationMessagesById } from './seedEmpty';

export interface ApplyLoadEvent {
  conversationId: string;
  generation: number;
  messages: UIMessage[];
}

/**
 * Commits a completed DB load as the conversation's new truth. Gated by
 * `loadGeneration`: a load whose generation no longer matches the tracked
 * one has been superseded by a newer `startLoad` (e.g. rapid conversation
 * switching) and is dropped — the newer load's result must win, not
 * whichever network request happens to resolve last.
 *
 * Any optimistic send whose id now appears in the loaded set is reconciled
 * out of `optimisticSends` — the DB row supersedes the local echo.
 */
export const applyLoad = (
  byConversationId: ConversationMessagesById,
  event: ApplyLoadEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId];
  if (!existing || event.generation !== existing.loadGeneration) return byConversationId;

  const loadedIds = new Set(event.messages.map((m) => m.id));
  const optimisticSends = existing.optimisticSends.filter((m) => !loadedIds.has(m.id));

  return {
    ...byConversationId,
    [event.conversationId]: {
      ...existing,
      messages: event.messages,
      optimisticSends,
    },
  };
};

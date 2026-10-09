import type { ConversationMessagesById } from './seedEmpty';

export interface ApplyFailLoadEvent {
  conversationId: string;
  generation: number;
}

/**
 * A failed load marks the entry's `loadStatus` 'error' — surfaces render a
 * retry affordance straight from the cache (PR 5B, leaf 5.2) — but NEVER
 * clears cached messages: the store exists so a transient fetch failure can't
 * blank a conversation that already rendered (the historical bug this
 * replaces: an effect calling `setMessages([])` on error).
 *
 * Gated by `loadGeneration`: a stale failure (superseded by a newer
 * `startLoad`, whose own outcome now owns the status) is a full no-op — it
 * must not paint an error over the newer load's 'loading'/'loaded'.
 */
export const applyFailLoad = (
  byConversationId: ConversationMessagesById,
  event: ApplyFailLoadEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId];
  if (!existing || event.generation !== existing.loadGeneration) return byConversationId;

  return {
    ...byConversationId,
    [event.conversationId]: { ...existing, loadStatus: 'error' },
  };
};

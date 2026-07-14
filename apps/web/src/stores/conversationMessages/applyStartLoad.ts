import { seedEmpty } from './seedEmpty';
import type { ConversationMessagesById } from './seedEmpty';

/**
 * Bumps a conversation's `loadGeneration` so the caller can pass the returned
 * generation into a subsequent `applyLoad`/`applyFailLoad` — any load that
 * lands after a newer one started carries a stale generation and is ignored.
 */
export const applyStartLoad = (
  byConversationId: ConversationMessagesById,
  conversationId: string,
): { byConversationId: ConversationMessagesById; generation: number } => {
  const existing = byConversationId[conversationId] ?? seedEmpty();
  const generation = existing.loadGeneration + 1;
  return {
    byConversationId: {
      ...byConversationId,
      [conversationId]: { ...existing, loadGeneration: generation },
    },
    generation,
  };
};

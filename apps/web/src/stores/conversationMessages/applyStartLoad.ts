import { seedEmpty } from './seedEmpty';
import type { ConversationMessagesById } from './seedEmpty';

/**
 * Bumps a conversation's `loadGeneration` so the caller can pass the returned
 * generation into a subsequent `applyLoad`/`applyFailLoad` — any load that
 * lands after a newer one started carries a stale generation and is ignored.
 *
 * Also resets `pendingMutationsSinceLoad`: any mutation recorded under the
 * previous generation already applied directly to `messages`/`optimisticSends`
 * (live mutations give immediate feedback regardless of pending-tracking), and
 * since a broadcast necessarily follows its DB write, a fresh fetch started
 * now will include that mutation's effect on its own — nothing is lost by
 * not replaying it a second time onto this new generation's snapshot.
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
      [conversationId]: { ...existing, loadGeneration: generation, pendingMutationsSinceLoad: [] },
    },
    generation,
  };
};

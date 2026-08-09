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
 *
 * Also resets `isLoadingOlder` to false: `startLoadingOlder`/`applyOlderPage`/
 * `failLoadingOlder` (epic leaf 6.6) are NOT themselves generation-gated on
 * write (only `applyOlderPage`/`failLoadingOlder`'s COMMIT checks the
 * generation) — a full reload starting while a "load older" fetch is in flight
 * bumps the generation here, so that fetch's eventual settle is a safe no-op
 * against the new generation and never flips the flag back. Without this reset
 * the flag would stay stuck true forever, permanently blocking future
 * "load older" fetches for this conversation (PR 6 review, CodeRabbit).
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
      [conversationId]: {
        ...existing,
        loadGeneration: generation,
        pendingMutationsSinceLoad: [],
        loadStatus: 'loading',
        isLoadingOlder: false,
      },
    },
    generation,
  };
};

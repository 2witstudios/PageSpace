import type { UIMessage } from 'ai';
import type { MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';

/**
 * A live mutation (remote broadcast) recorded while a load is in flight, so
 * `applyLoad` can replay it onto the loaded snapshot regardless of which
 * resolves first — see `replayPendingMutations`.
 */
export type PendingMutation =
  | { type: 'remoteMessage'; message: UIMessage }
  | { type: 'confirmedMessage'; message: UIMessage }
  | { type: 'edit'; payload: MessageEditPayload }
  | { type: 'delete'; messageId: string };

/**
 * Per-conversation slice of `useConversationMessagesStore`. `messages` is the
 * DB-confirmed truth (server order); `optimisticSends` holds client-minted
 * user messages sent but not yet reconciled against a load. `loadGeneration`
 * guards `applyLoad`/`applyFailLoad` against a load superseded by a newer
 * `startLoad` (e.g. rapid conversation switching) — the newer load's result
 * must win, not whichever network request resolves last.
 *
 * `pendingMutationsSinceLoad` records every live remote mutation
 * (append/confirm-replace/edit/delete) applied since the current `loadGeneration`
 * started;
 * `applyLoad` replays them onto its loaded snapshot before committing, so a
 * load's DB snapshot — which may have been read before or after any given
 * live mutation, with no ordering guarantee between the two — never wins
 * over a live mutation, AND a live mutation never causes a genuinely fresh
 * load response to be discarded (see PR #2075 review: generation-only
 * invalidation was too aggressive in the reverse direction).
 *
 * Accepted tradeoff: this array is cleared only by `applyLoad`/`applyStartLoad`,
 * not by any timer or size cap — a conversation that goes a very long time
 * between reloads (tab focus, reconnect, switch-away/back) while receiving
 * many live mutations will accumulate all of them. This doesn't affect
 * correctness (replay is idempotent: a message already present is never
 * duplicated, an edit/delete of an absent id is a no-op), only memory, and
 * every real reload trigger the epic names (refresh, reconnect, conversation
 * switch) clears it. Revisit with a cap or per-message-id collapse if a wired
 * consumer (PR 4/5) shows this mattering under real traffic.
 */
export interface ConversationCacheEntry {
  messages: UIMessage[];
  optimisticSends: UIMessage[];
  loadGeneration: number;
  pendingMutationsSinceLoad: PendingMutation[];
}

export type ConversationMessagesById = Record<string, ConversationCacheEntry>;

/** A freshly-materialized, empty cache entry for a conversation never seen before. */
export const seedEmpty = (): ConversationCacheEntry => ({
  messages: [],
  optimisticSends: [],
  loadGeneration: 0,
  pendingMutationsSinceLoad: [],
});

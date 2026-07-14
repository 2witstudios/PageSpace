import type { UIMessage } from 'ai';

/**
 * Per-conversation slice of `useConversationMessagesStore`. `messages` is the
 * DB-confirmed truth (server order); `optimisticSends` holds client-minted
 * user messages sent but not yet reconciled against a load. `loadGeneration`
 * guards `applyLoad`/`applyFailLoad` against a stale async load landing after
 * a newer one started (e.g. rapid conversation switching).
 */
export interface ConversationCacheEntry {
  messages: UIMessage[];
  optimisticSends: UIMessage[];
  loadGeneration: number;
}

export type ConversationMessagesById = Record<string, ConversationCacheEntry>;

/** A freshly-materialized, empty cache entry for a conversation never seen before. */
export const seedEmpty = (): ConversationCacheEntry => ({
  messages: [],
  optimisticSends: [],
  loadGeneration: 0,
});

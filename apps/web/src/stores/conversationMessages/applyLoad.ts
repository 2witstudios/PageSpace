import type { UIMessage } from 'ai';
import type { ConversationMessagesById } from './seedEmpty';
import { replayPendingMutations } from './replayPendingMutations';

export interface ApplyLoadEvent {
  conversationId: string;
  generation: number;
  messages: UIMessage[];
  /** The load's pagination envelope (epic leaf 6.6) — seeds hasMoreOlder/olderCursor for "load older". */
  pagination?: { hasMore: boolean; nextCursor: string | null };
}

/**
 * Commits a completed DB load as the conversation's new truth. Gated by
 * `loadGeneration`: a load whose generation no longer matches the tracked
 * one has been superseded by a newer `startLoad` (e.g. rapid conversation
 * switching) and is dropped — the newer load's result must win, not
 * whichever network request happens to resolve last.
 *
 * There is no ordering guarantee between this load's DB snapshot and any
 * live mutation (remote message/edit/delete) that landed while it was in
 * flight — either can "win the race". `pendingMutationsSinceLoad` (recorded
 * by `applyRemoteUserMessage`/`applyConversationEdit`/`applyConversationDelete`
 * since the current `loadGeneration` started) is replayed onto the loaded
 * snapshot before committing, so the result always reflects both: a live
 * mutation the snapshot predates is never dropped, and a live append the
 * snapshot already includes is never duplicated (see PR #2075 review —
 * unconditionally invalidating the load's generation on every live mutation
 * was too aggressive and could discard a genuinely fresh/complete response).
 *
 * Any optimistic send whose id now appears in the (replayed) set is
 * reconciled out of `optimisticSends` — the DB row supersedes the local echo.
 */
export const applyLoad = (
  byConversationId: ConversationMessagesById,
  event: ApplyLoadEvent,
): ConversationMessagesById => {
  const existing = byConversationId[event.conversationId];
  if (!existing || event.generation !== existing.loadGeneration) return byConversationId;

  const messages = replayPendingMutations(event.messages, existing.pendingMutationsSinceLoad);
  const loadedIds = new Set(messages.map((m) => m.id));
  const optimisticSends = existing.optimisticSends.filter((m) => !loadedIds.has(m.id));

  return {
    ...byConversationId,
    [event.conversationId]: {
      ...existing,
      messages,
      optimisticSends,
      pendingMutationsSinceLoad: [],
      loadStatus: 'loaded',
      // A caller without a pagination envelope (background snapshot refresh, a
      // preloaded fast path) must not clobber an already-known cursor — leave it as
      // whatever the last envelope-carrying load established (PR 6 review, Codex).
      hasMoreOlder: event.pagination ? event.pagination.hasMore : existing.hasMoreOlder,
      olderCursor: event.pagination ? event.pagination.nextCursor : existing.olderCursor,
    },
  };
};

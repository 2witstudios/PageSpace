import type { UIMessage } from 'ai';
import type { MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';
import type { AskUserAnswerPayload } from '@/lib/ai/streams/applyAskUserAnswer';

type PendingMutationKind =
  | { type: 'remoteMessage'; message: UIMessage }
  | { type: 'confirmedMessage'; message: UIMessage }
  | { type: 'edit'; payload: MessageEditPayload }
  | { type: 'delete'; messageId: string }
  | { type: 'askUserAnswer'; payload: AskUserAnswerPayload };

/**
 * A live mutation (remote broadcast) recorded while a load is in flight, so
 * `applyLoad` can replay it onto the loaded snapshot regardless of which
 * resolves first — see `replayPendingMutations`.
 *
 * `rev` is the post-write `conversations.rev` the event carried, when it came
 * from a rev-bearing `conversation:*` event. It is what makes the replay
 * ORDER-SAFE against a snapshot: a fetched snapshot read at rev N already
 * contains every write up to N, so replaying a mutation with `rev <= N` on top
 * of it re-applies an OLDER payload over newer truth. That is not a transient
 * glitch — the watermark still folds forward to N, so the cache reads as
 * current while showing stale content, and `syncWatchedConversationRevs`
 * (which compares revs, not content) never heals it.
 *
 * Reachable in production because conversation events are independent HMAC
 * POSTs into realtime, which emits in receive order: two near-simultaneous
 * writes can reach one socket reversed, and the later-delivered/lower-rev one
 * lands while the gap-triggered refetch is still in flight.
 *
 * `undefined` means UNVERSIONED — the mutation came from a path that carries no
 * rev (the legacy `chat:*` fan-out, an SSE stream commit, `promoteOptimisticSends`).
 * Those always replay, exactly as before: with no rev there is nothing to prove
 * the snapshot already contains them, and dropping them would lose content.
 */
export type PendingMutation = PendingMutationKind & { rev?: number };

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
/**
 * Load lifecycle of the entry's `messages` snapshot, so surfaces render
 * loading/error UI straight from the cache (PR 5B, leaf 5.2) instead of
 * per-surface local state. 'error' never implies cleared messages — a failed
 * reload keeps the prior snapshot (see `applyFailLoad`).
 */
export type ConversationLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface ConversationCacheEntry {
  messages: UIMessage[];
  optimisticSends: UIMessage[];
  loadGeneration: number;
  pendingMutationsSinceLoad: PendingMutation[];
  loadStatus: ConversationLoadStatus;
  /** Cursor for the NEXT "load older" page (epic leaf 6.6) — the initial load's `pagination.nextCursor`. */
  olderCursor: string | null;
  /** Whether an older page exists to load — the initial/older load's `pagination.hasMore`. */
  hasMoreOlder: boolean;
  /** True while a "load older" fetch is in flight — inline scroll indicator only, no error-banner takeover. */
  isLoadingOlder: boolean;
  /**
   * The conversation's rev WATERMARK (Agent-Session SSoT epic, Phase 2) — the
   * `conversations.rev` this entry's `messages` are known to reflect.
   *
   * Established by a message-list GET (both envelopes now carry `rev`) and
   * advanced by every applied `conversation:*` event. `null` means "no proven
   * baseline yet": an entry exists (subscribe-on-open guarantees one the moment
   * a surface opens the conversation) but nothing has told us where it stands,
   * so `decideConversationApply` answers `refetch` for any versioned event
   * rather than guessing. See `@/lib/realtime/conversation-apply`.
   */
  rev: number | null;
}

export type ConversationMessagesById = Record<string, ConversationCacheEntry>;

/** A freshly-materialized, empty cache entry for a conversation never seen before. */
export const seedEmpty = (): ConversationCacheEntry => ({
  messages: [],
  optimisticSends: [],
  loadGeneration: 0,
  pendingMutationsSinceLoad: [],
  loadStatus: 'idle',
  olderCursor: null,
  hasMoreOlder: false,
  isLoadingOlder: false,
  rev: null,
});

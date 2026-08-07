import { create } from 'zustand';
import type { UIMessage } from 'ai';
import { applyStartLoad } from '@/stores/conversationMessages/applyStartLoad';
import { applyLoad } from '@/stores/conversationMessages/applyLoad';
import { applyFailLoad } from '@/stores/conversationMessages/applyFailLoad';
import { applyOptimisticSend } from '@/stores/conversationMessages/applyOptimisticSend';
import { applyOptimisticSendFailure } from '@/stores/conversationMessages/applyOptimisticSendFailure';
import { applyOlderPage } from '@/stores/conversationMessages/applyOlderPage';
import { applyConversationEdit } from '@/stores/conversationMessages/applyConversationEdit';
import { applyConversationDelete } from '@/stores/conversationMessages/applyConversationDelete';
import { applyConversationAskUserAnswer } from '@/stores/conversationMessages/applyConversationAskUserAnswer';
import { applyRemoteUserMessage } from '@/stores/conversationMessages/applyRemoteUserMessage';
import { applyConfirmedMessage } from '@/stores/conversationMessages/applyConfirmedMessage';
import { promoteOptimisticSends } from '@/stores/conversationMessages/promoteOptimisticSends';
import { replayPendingMutations } from '@/stores/conversationMessages/replayPendingMutations';
import { mergeSnapshotTail } from '@/stores/conversationMessages/mergeSnapshotTail';
import { advanceRev } from '@/stores/conversationMessages/advanceRev';
import { seedEmpty, type ConversationCacheEntry, type ConversationMessagesById } from '@/stores/conversationMessages/seedEmpty';
import type { MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';
import { revertAskUserAnswer, type AskUserAnswerPayload, type AskUserAnswerRevertPayload } from '@/lib/ai/streams/applyAskUserAnswer';

export type { ConversationCacheEntry, ConversationMessagesById };

interface ConversationMessagesState {
  byConversationId: ConversationMessagesById;
  getEntry: (conversationId: string) => ConversationCacheEntry;
  /**
   * True when the conversation has a real cache entry — i.e. some surface has
   * loaded/seeded/sent in it this session. `getEntry` cannot answer this (it
   * returns a synthetic empty entry for never-seen ids); socket-event dispatch
   * keys on this to route an event to any cached conversation, active or not.
   */
  hasEntry: (conversationId: string) => boolean;
  startLoad: (conversationId: string) => number;
  /** True while `generation` is still the newest `startLoad` result for `conversationId`. */
  isLoadCurrent: (conversationId: string, generation: number) => boolean;
  applyLoad: (
    conversationId: string,
    generation: number,
    messages: UIMessage[],
    pagination?: { hasMore: boolean; nextCursor: string | null },
    /** The server's `conversations.rev` at read time — folded monotonically into the watermark. */
    rev?: number | null,
  ) => void;
  failLoad: (conversationId: string, generation: number) => void;
  /**
   * The conversation's current rev watermark, or `null` when no load has
   * established one. The input to `decideConversationApply` for every incoming
   * `conversation:*` event.
   */
  getRev: (conversationId: string) => number | null;
  /** Advances the watermark after an event's payload was applied — monotonic, no-op for an uncached conversation. */
  advanceRev: (conversationId: string, rev: number) => void;
  /** Marks a "load older" fetch in flight (epic leaf 6.6) — inline indicator, no generation change. */
  startLoadingOlder: (conversationId: string) => void;
  /** Prepends a dedup'd older page and advances olderCursor/hasMoreOlder; generation-gated. */
  applyOlderPage: (
    conversationId: string,
    generation: number,
    messages: UIMessage[],
    hasMoreOlder: boolean,
    nextCursor: string | null,
  ) => void;
  /** Clears isLoadingOlder on a failed "load older" fetch; leaves the cache otherwise intact. */
  failLoadingOlder: (conversationId: string, generation: number) => void;
  addOptimisticSend: (conversationId: string, message: UIMessage) => void;
  /** Rolls back an optimistic send whose POST rejected (epic leaf 6.5, M9) — never touches confirmed `messages`. */
  removeOptimisticSendOnFailure: (conversationId: string, messageId: string) => void;
  applyEdit: (conversationId: string, payload: MessageEditPayload) => void;
  /** `rev`: the deleting event's post-write rev, when it carried one — see PendingMutation. */
  applyDelete: (conversationId: string, messageId: string, rev?: number) => void;
  /** Optimistic ask_user answer patch (epic leaf 6.3) — the resume POST's own commit reconciles it once persisted. */
  applyAskUserAnswer: (conversationId: string, payload: AskUserAnswerPayload) => void;
  /** Reverts an optimistic ask_user answer (the resume POST rejected) back to input-available. */
  revertAskUserAnswer: (conversationId: string, payload: AskUserAnswerRevertPayload) => void;
  applyRemoteUserMessage: (conversationId: string, message: UIMessage) => void;
  /**
   * Upsert-by-id (replace if present, append if absent) — see applyConfirmedMessage's
   * docblock. `rev`: the confirming event's post-write rev, when it carried one.
   */
  applyConfirmedMessage: (conversationId: string, message: UIMessage, rev?: number) => void;
  /** Promote optimistic sends into confirmed messages — call on OWN stream commit only (see promoteOptimisticSends). */
  promoteOptimisticSends: (conversationId: string) => void;
  /**
   * Captures the entry's current generation WITHOUT any state change — the
   * token a background snapshot fetch must present at commit. Any generation
   * movement in between (a loud load starting, another snapshot committing)
   * invalidates the token, so an older-fetched snapshot can never overwrite
   * fresher data (CodeRabbit CR4, PR #2098).
   */
  beginServerSnapshot: (conversationId: string) => number;
  /**
   * Commits an already-fetched server message list as the conversation's new
   * loaded truth in one step (startLoad + applyLoad composed), silently — no
   * 'loading' status flip. Dropped when `generationToken` (from
   * `beginServerSnapshot`, captured before the fetch) is no longer the entry's
   * current generation. Mutations recorded since the fetch began are replayed
   * onto the snapshot (they are newer than it).
   */
  applyServerSnapshot: (
    conversationId: string,
    generationToken: number,
    messages: UIMessage[],
    /** The snapshot fetch's own envelope — applied only when the snapshot REPLACES the cache (no overlap), so pagination resets consistently with the replaced list. */
    pagination?: { hasMore: boolean; nextCursor: string | null },
    /** The `conversations.rev` the snapshot was read at — the watermark a gap-triggered refetch heals to. */
    rev?: number | null,
  ) => void;
  /**
   * Marks a freshly-minted conversation as loaded-empty — createNewConversation
   * paths know the server has no rows for the id they just minted, so nothing
   * should ever fetch for it and the UI must not show a loading state.
   */
  seedConversation: (conversationId: string) => void;
}

export const useConversationMessagesStore = create<ConversationMessagesState>((set, get) => ({
  byConversationId: {},

  getEntry: (conversationId) => get().byConversationId[conversationId] ?? seedEmpty(),

  hasEntry: (conversationId) => conversationId in get().byConversationId,

  startLoad: (conversationId) => {
    const { byConversationId, generation } = applyStartLoad(get().byConversationId, conversationId);
    set({ byConversationId });
    return generation;
  },

  isLoadCurrent: (conversationId, generation) =>
    get().byConversationId[conversationId]?.loadGeneration === generation,

  applyLoad: (conversationId, generation, messages, pagination, rev) => {
    set((state) => ({ byConversationId: applyLoad(state.byConversationId, { conversationId, generation, messages, pagination, rev }) }));
  },

  failLoad: (conversationId, generation) => {
    set((state) => ({ byConversationId: applyFailLoad(state.byConversationId, { conversationId, generation }) }));
  },

  getRev: (conversationId) => get().byConversationId[conversationId]?.rev ?? null,

  advanceRev: (conversationId, rev) => {
    set((state) => ({ byConversationId: advanceRev(state.byConversationId, { conversationId, rev }) }));
  },

  startLoadingOlder: (conversationId) => {
    set((state) => {
      const existing = state.byConversationId[conversationId];
      if (!existing) return state;
      return { byConversationId: { ...state.byConversationId, [conversationId]: { ...existing, isLoadingOlder: true } } };
    });
  },

  applyOlderPage: (conversationId, generation, messages, hasMoreOlder, nextCursor) => {
    set((state) => ({
      byConversationId: applyOlderPage(state.byConversationId, { conversationId, generation, messages, hasMoreOlder, nextCursor }),
    }));
  },

  failLoadingOlder: (conversationId, generation) => {
    set((state) => {
      const existing = state.byConversationId[conversationId];
      if (!existing || existing.loadGeneration !== generation) return state;
      return { byConversationId: { ...state.byConversationId, [conversationId]: { ...existing, isLoadingOlder: false } } };
    });
  },

  addOptimisticSend: (conversationId, message) => {
    set((state) => ({ byConversationId: applyOptimisticSend(state.byConversationId, { conversationId, message }) }));
  },

  removeOptimisticSendOnFailure: (conversationId, messageId) => {
    set((state) => ({ byConversationId: applyOptimisticSendFailure(state.byConversationId, { conversationId, messageId }) }));
  },

  applyEdit: (conversationId, payload) => {
    set((state) => ({ byConversationId: applyConversationEdit(state.byConversationId, { conversationId, payload }) }));
  },

  applyDelete: (conversationId, messageId, rev) => {
    set((state) => ({ byConversationId: applyConversationDelete(state.byConversationId, { conversationId, messageId, rev }) }));
  },

  applyAskUserAnswer: (conversationId, payload) => {
    set((state) => ({ byConversationId: applyConversationAskUserAnswer(state.byConversationId, { conversationId, payload }) }));
  },

  revertAskUserAnswer: (conversationId, payload) => {
    set((state) => {
      const existing = state.byConversationId[conversationId];
      if (!existing) return state;
      return {
        byConversationId: {
          ...state.byConversationId,
          [conversationId]: { ...existing, messages: revertAskUserAnswer(existing.messages, payload) },
        },
      };
    });
  },

  applyRemoteUserMessage: (conversationId, message) => {
    set((state) => ({ byConversationId: applyRemoteUserMessage(state.byConversationId, { conversationId, message }) }));
  },

  applyConfirmedMessage: (conversationId, message, rev) => {
    set((state) => ({ byConversationId: applyConfirmedMessage(state.byConversationId, { conversationId, message, rev }) }));
  },

  promoteOptimisticSends: (conversationId) => {
    set((state) => ({ byConversationId: promoteOptimisticSends(state.byConversationId, conversationId) }));
  },

  beginServerSnapshot: (conversationId) =>
    get().byConversationId[conversationId]?.loadGeneration ?? 0,

  applyServerSnapshot: (conversationId, generationToken, messages, pagination, rev) => {
    set((state) => {
      // Stale-token drop (CR4): the generation moved since this snapshot's fetch
      // began — a loud load started, or a fresher snapshot already committed — so
      // this data is older than what the entry holds/awaits. Replay cannot save it
      // (the newer commit cleared the pending queue).
      const currentGeneration = state.byConversationId[conversationId]?.loadGeneration ?? 0;
      if (currentGeneration !== generationToken) return state;
      // A snapshot is the LATEST page only — merge it onto any older loaded pages
      // instead of discarding them (mergeSnapshotTail's docblock; Codex P2, PR #2320).
      // When it overlaps the cached window the older prefix is preserved and the
      // existing olderCursor stays correct, so no envelope is applied; when it
      // doesn't, the snapshot replaces the cache and its own envelope (if the
      // caller had one) resets pagination consistently.
      const cachedMessages = state.byConversationId[conversationId]?.messages ?? [];
      const merged = mergeSnapshotTail(cachedMessages, messages);
      // The snapshot was FETCHED before this call (unlike startLoad's contract, where
      // the fetch starts after), so live mutations recorded while it was in flight are
      // NEWER than the snapshot — replay them onto it instead of letting the generation
      // bump clear them, or an older recovery snapshot resurrects a message another tab
      // just deleted (CodeRabbit P2, PR #2098). Replayed over the MERGED list so a
      // delete/edit of a preserved older row is honored too.
      // ...but ONLY the ones this snapshot doesn't already contain. This is the
      // gap-heal path (`healConversationToRev` → `refreshConversationSnapshot`),
      // so it is precisely where an out-of-order event applied while the fetch
      // was in flight would otherwise be replayed over newer truth — leaving the
      // cache stale at a watermark that says it is current, which no later revs
      // check can detect. See `replayPendingMutations`.
      const pendingSinceFetch = state.byConversationId[conversationId]?.pendingMutationsSinceLoad ?? [];
      const { byConversationId, generation } = applyStartLoad(state.byConversationId, conversationId);
      return {
        byConversationId: applyLoad(byConversationId, {
          conversationId,
          generation,
          messages: replayPendingMutations(merged.messages, pendingSinceFetch, rev),
          pagination: merged.overlapped ? undefined : pagination,
          rev,
        }),
      };
    });
  },

  seedConversation: (conversationId) => {
    set((state) => {
      const { byConversationId, generation } = applyStartLoad(state.byConversationId, conversationId);
      return { byConversationId: applyLoad(byConversationId, { conversationId, generation, messages: [] }) };
    });
  },
}));

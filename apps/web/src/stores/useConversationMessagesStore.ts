import { create } from 'zustand';
import type { UIMessage } from 'ai';
import { applyStartLoad } from '@/stores/conversationMessages/applyStartLoad';
import { applyLoad } from '@/stores/conversationMessages/applyLoad';
import { applyFailLoad } from '@/stores/conversationMessages/applyFailLoad';
import { applyOptimisticSend } from '@/stores/conversationMessages/applyOptimisticSend';
import { applyOptimisticSendFailure } from '@/stores/conversationMessages/applyOptimisticSendFailure';
import { applyConversationEdit } from '@/stores/conversationMessages/applyConversationEdit';
import { applyConversationDelete } from '@/stores/conversationMessages/applyConversationDelete';
import { applyConversationAskUserAnswer } from '@/stores/conversationMessages/applyConversationAskUserAnswer';
import { applyRemoteUserMessage } from '@/stores/conversationMessages/applyRemoteUserMessage';
import { applyConfirmedMessage } from '@/stores/conversationMessages/applyConfirmedMessage';
import { promoteOptimisticSends } from '@/stores/conversationMessages/promoteOptimisticSends';
import { replayPendingMutations } from '@/stores/conversationMessages/replayPendingMutations';
import { seedEmpty, type ConversationCacheEntry, type ConversationMessagesById } from '@/stores/conversationMessages/seedEmpty';
import type { MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';
import { revertAskUserAnswer, type AskUserAnswerPayload, type AskUserAnswerRevertPayload } from '@/lib/ai/streams/applyAskUserAnswer';

export type { ConversationCacheEntry, ConversationMessagesById };

interface ConversationMessagesState {
  byConversationId: ConversationMessagesById;
  getEntry: (conversationId: string) => ConversationCacheEntry;
  startLoad: (conversationId: string) => number;
  /** True while `generation` is still the newest `startLoad` result for `conversationId`. */
  isLoadCurrent: (conversationId: string, generation: number) => boolean;
  applyLoad: (conversationId: string, generation: number, messages: UIMessage[]) => void;
  failLoad: (conversationId: string, generation: number) => void;
  addOptimisticSend: (conversationId: string, message: UIMessage) => void;
  /** Rolls back an optimistic send whose POST rejected (epic leaf 6.5, M9) — never touches confirmed `messages`. */
  removeOptimisticSendOnFailure: (conversationId: string, messageId: string) => void;
  applyEdit: (conversationId: string, payload: MessageEditPayload) => void;
  applyDelete: (conversationId: string, messageId: string) => void;
  /** Optimistic ask_user answer patch (epic leaf 6.3) — the resume POST's own commit reconciles it once persisted. */
  applyAskUserAnswer: (conversationId: string, payload: AskUserAnswerPayload) => void;
  /** Reverts an optimistic ask_user answer (the resume POST rejected) back to input-available. */
  revertAskUserAnswer: (conversationId: string, payload: AskUserAnswerRevertPayload) => void;
  applyRemoteUserMessage: (conversationId: string, message: UIMessage) => void;
  /** Upsert-by-id (replace if present, append if absent) — see applyConfirmedMessage's docblock. */
  applyConfirmedMessage: (conversationId: string, message: UIMessage) => void;
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
  applyServerSnapshot: (conversationId: string, generationToken: number, messages: UIMessage[]) => void;
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

  startLoad: (conversationId) => {
    const { byConversationId, generation } = applyStartLoad(get().byConversationId, conversationId);
    set({ byConversationId });
    return generation;
  },

  isLoadCurrent: (conversationId, generation) =>
    get().byConversationId[conversationId]?.loadGeneration === generation,

  applyLoad: (conversationId, generation, messages) => {
    set((state) => ({ byConversationId: applyLoad(state.byConversationId, { conversationId, generation, messages }) }));
  },

  failLoad: (conversationId, generation) => {
    set((state) => ({ byConversationId: applyFailLoad(state.byConversationId, { conversationId, generation }) }));
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

  applyDelete: (conversationId, messageId) => {
    set((state) => ({ byConversationId: applyConversationDelete(state.byConversationId, { conversationId, messageId }) }));
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

  applyConfirmedMessage: (conversationId, message) => {
    set((state) => ({ byConversationId: applyConfirmedMessage(state.byConversationId, { conversationId, message }) }));
  },

  promoteOptimisticSends: (conversationId) => {
    set((state) => ({ byConversationId: promoteOptimisticSends(state.byConversationId, conversationId) }));
  },

  beginServerSnapshot: (conversationId) =>
    get().byConversationId[conversationId]?.loadGeneration ?? 0,

  applyServerSnapshot: (conversationId, generationToken, messages) => {
    set((state) => {
      // Stale-token drop (CR4): the generation moved since this snapshot's fetch
      // began — a loud load started, or a fresher snapshot already committed — so
      // this data is older than what the entry holds/awaits. Replay cannot save it
      // (the newer commit cleared the pending queue).
      const currentGeneration = state.byConversationId[conversationId]?.loadGeneration ?? 0;
      if (currentGeneration !== generationToken) return state;
      // The snapshot was FETCHED before this call (unlike startLoad's contract, where
      // the fetch starts after), so live mutations recorded while it was in flight are
      // NEWER than the snapshot — replay them onto it instead of letting the generation
      // bump clear them, or an older recovery snapshot resurrects a message another tab
      // just deleted (CodeRabbit P2, PR #2098).
      const pendingSinceFetch = state.byConversationId[conversationId]?.pendingMutationsSinceLoad ?? [];
      const { byConversationId, generation } = applyStartLoad(state.byConversationId, conversationId);
      return {
        byConversationId: applyLoad(byConversationId, {
          conversationId,
          generation,
          messages: replayPendingMutations(messages, pendingSinceFetch),
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

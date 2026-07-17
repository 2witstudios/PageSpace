import { create } from 'zustand';
import type { UIMessage } from 'ai';
import { applyStartLoad } from '@/stores/conversationMessages/applyStartLoad';
import { applyLoad } from '@/stores/conversationMessages/applyLoad';
import { applyFailLoad } from '@/stores/conversationMessages/applyFailLoad';
import { applyOptimisticSend } from '@/stores/conversationMessages/applyOptimisticSend';
import { applyConversationEdit } from '@/stores/conversationMessages/applyConversationEdit';
import { applyConversationDelete } from '@/stores/conversationMessages/applyConversationDelete';
import { applyRemoteUserMessage } from '@/stores/conversationMessages/applyRemoteUserMessage';
import { applyConfirmedMessage } from '@/stores/conversationMessages/applyConfirmedMessage';
import { replayPendingMutations } from '@/stores/conversationMessages/replayPendingMutations';
import { seedEmpty, type ConversationCacheEntry, type ConversationMessagesById } from '@/stores/conversationMessages/seedEmpty';
import type { MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';

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
  applyEdit: (conversationId: string, payload: MessageEditPayload) => void;
  applyDelete: (conversationId: string, messageId: string) => void;
  applyRemoteUserMessage: (conversationId: string, message: UIMessage) => void;
  /** Upsert-by-id (replace if present, append if absent) — see applyConfirmedMessage's docblock. */
  applyConfirmedMessage: (conversationId: string, message: UIMessage) => void;
  /**
   * Commits an already-fetched server message list as the conversation's new
   * loaded truth in one step (startLoad + applyLoad composed) — for callers
   * that fetched BEFORE deciding to commit (tryRecover's refetch branch),
   * where a separate startLoad would leave a window for the data to go stale
   * against its own generation. Supersedes any in-flight load.
   */
  applyServerSnapshot: (conversationId: string, messages: UIMessage[]) => void;
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

  applyEdit: (conversationId, payload) => {
    set((state) => ({ byConversationId: applyConversationEdit(state.byConversationId, { conversationId, payload }) }));
  },

  applyDelete: (conversationId, messageId) => {
    set((state) => ({ byConversationId: applyConversationDelete(state.byConversationId, { conversationId, messageId }) }));
  },

  applyRemoteUserMessage: (conversationId, message) => {
    set((state) => ({ byConversationId: applyRemoteUserMessage(state.byConversationId, { conversationId, message }) }));
  },

  applyConfirmedMessage: (conversationId, message) => {
    set((state) => ({ byConversationId: applyConfirmedMessage(state.byConversationId, { conversationId, message }) }));
  },

  applyServerSnapshot: (conversationId, messages) => {
    set((state) => {
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

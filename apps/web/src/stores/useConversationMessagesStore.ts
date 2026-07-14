import { create } from 'zustand';
import type { UIMessage } from 'ai';
import { applyStartLoad } from '@/stores/conversationMessages/applyStartLoad';
import { applyLoad } from '@/stores/conversationMessages/applyLoad';
import { applyFailLoad } from '@/stores/conversationMessages/applyFailLoad';
import { applyOptimisticSend } from '@/stores/conversationMessages/applyOptimisticSend';
import { applyConversationEdit } from '@/stores/conversationMessages/applyConversationEdit';
import { applyConversationDelete } from '@/stores/conversationMessages/applyConversationDelete';
import { applyRemoteUserMessage } from '@/stores/conversationMessages/applyRemoteUserMessage';
import { seedEmpty, type ConversationCacheEntry, type ConversationMessagesById } from '@/stores/conversationMessages/seedEmpty';
import type { MessageEditPayload } from '@/lib/ai/streams/applyMessageEdit';

export type { ConversationCacheEntry, ConversationMessagesById };

interface ConversationMessagesState {
  byConversationId: ConversationMessagesById;
  getEntry: (conversationId: string) => ConversationCacheEntry;
  startLoad: (conversationId: string) => number;
  applyLoad: (conversationId: string, generation: number, messages: UIMessage[]) => void;
  failLoad: (conversationId: string, generation: number) => void;
  addOptimisticSend: (conversationId: string, message: UIMessage) => void;
  applyEdit: (conversationId: string, payload: MessageEditPayload) => void;
  applyDelete: (conversationId: string, messageId: string) => void;
  applyRemoteUserMessage: (conversationId: string, message: UIMessage) => void;
}

export const useConversationMessagesStore = create<ConversationMessagesState>((set, get) => ({
  byConversationId: {},

  getEntry: (conversationId) => get().byConversationId[conversationId] ?? seedEmpty(),

  startLoad: (conversationId) => {
    const { byConversationId, generation } = applyStartLoad(get().byConversationId, conversationId);
    set({ byConversationId });
    return generation;
  },

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
}));

import { create } from 'zustand';
import type { AIErrorCause } from '@/lib/ai/shared/aiErrorCause';

/**
 * Per-conversation typed error cause (epic leaf 6.5), replacing per-useChat-
 * instance error/clearError. Keyed by conversationId, so a conversation
 * switch never carries the previous conversation's error (M10) — reading a
 * conversationId that never had one simply returns null, no explicit clear
 * effect needed.
 */
interface ChatErrorState {
  byConversationId: Record<string, AIErrorCause>;
  getError: (conversationId: string) => AIErrorCause | null;
  setError: (conversationId: string, cause: AIErrorCause) => void;
  clearError: (conversationId: string) => void;
}

export const useChatErrorStore = create<ChatErrorState>((set, get) => ({
  byConversationId: {},

  getError: (conversationId) => get().byConversationId[conversationId] ?? null,

  setError: (conversationId, cause) => {
    set((state) => ({ byConversationId: { ...state.byConversationId, [conversationId]: cause } }));
  },

  clearError: (conversationId) => {
    if (!(conversationId in get().byConversationId)) return;
    set((state) => {
      const next = { ...state.byConversationId };
      delete next[conversationId];
      return { byConversationId: next };
    });
  },
}));

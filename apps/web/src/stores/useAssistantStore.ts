import { create } from 'zustand';
import { post } from '@/lib/auth-fetch';
import { UIMessage as Message } from '@ai-sdk/react';

export interface AssistantConversation {
  id: string;
  title: string;
  updatedAt: string;
}

interface AssistantState {
  activeConversationId: string | null;
  messages: Message[];
  isLoading: boolean;
  isCreatingConversation: boolean;
  model: string;
  assistantMode: 'write' | 'ask';
  setAssistantMode: (mode: 'write' | 'ask') => void;
  setModel: (model: string) => void;
  setActiveConversation: (id: string | null) => void;
  createConversation: (driveId: string, model: string) => Promise<string>;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  clearConversation: () => void;
}

export const useAssistantStore = create<AssistantState>((set) => ({
  activeConversationId: null,
  messages: [],
  isLoading: false,
  isCreatingConversation: false,
  model: 'qwen/qwen3-coder:free', // Default to PageSpace Free model
  assistantMode: 'write',
  setAssistantMode: (mode) => set({ assistantMode: mode }),
  setModel: (model) => set({ model }),
  setActiveConversation: (id) => set({ activeConversationId: id, messages: [], isLoading: true }),
  createConversation: async (driveId: string, model: string) => {
    set({ isCreatingConversation: true, model });
    try {
      const newConversation = await post<{ id: string }>('/api/ai_conversations', { driveId, model });
      set({
        activeConversationId: newConversation.id,
        messages: [],
        isLoading: false,
        isCreatingConversation: false
      });
      return newConversation.id;
    } catch (error) {
      set({ isCreatingConversation: false });
      throw error;
    }
  },
  setMessages: (messages) => set({ messages, isLoading: false }),
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  clearConversation: () => set({ activeConversationId: null, messages: [], isCreatingConversation: false }),
}));
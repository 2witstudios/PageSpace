/**
 * Assistant Settings Store
 *
 * Centralized Zustand store for global assistant settings.
 * Used by SidebarSettingsTab, SidebarChatTab, and GlobalAssistantView.
 *
 * Settings managed:
 * - showPageTree: Whether to include workspace structure in AI context
 * - currentProvider/currentModel: User's selected AI provider configuration
 * - isAnyProviderConfigured: Whether any AI provider has valid credentials
 *
 * Replaces the previous pattern of duplicated local state + custom events.
 */

import { create } from 'zustand';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

const SHOW_PAGE_TREE_KEY = 'pagespace:assistant:showPageTree';

interface AssistantSettingsState {
  // Settings
  showPageTree: boolean;
  currentProvider: string | null;
  currentModel: string | null;
  isAnyProviderConfigured: boolean;

  // Loading state
  isLoading: boolean;
  isInitialized: boolean;

  // Actions
  setShowPageTree: (show: boolean) => void;
  setProviderSettings: (provider: string, model: string) => void;
  loadSettings: () => Promise<void>;
}

export const useAssistantSettingsStore = create<AssistantSettingsState>()((set, get) => ({
  // Initial state - all values initialized to defaults, loaded from localStorage/API in loadSettings
  showPageTree: false,
  currentProvider: null,
  currentModel: null,
  isAnyProviderConfigured: false,
  isLoading: false,
  isInitialized: false,

  setShowPageTree: (show: boolean) => {
    // Update state
    set({ showPageTree: show });

    // Persist to localStorage
    if (typeof window !== 'undefined') {
      localStorage.setItem(SHOW_PAGE_TREE_KEY, String(show));
    }
  },

  setProviderSettings: (provider: string, model: string) => {
    set({ currentProvider: provider, currentModel: model });

    // Dispatch event for cross-browser-tab sync
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ai-settings-updated'));
    }
  },

  loadSettings: async () => {
    // Prevent duplicate loads
    if (get().isLoading || get().isInitialized) return;

    set({ isLoading: true });

    try {
      // Load showPageTree from localStorage (client-side only)
      let showPageTree = false;
      if (typeof window !== 'undefined') {
        const stored = localStorage.getItem(SHOW_PAGE_TREE_KEY);
        if (stored !== null) {
          showPageTree = stored === 'true';
        }
      }

      const response = await fetchWithAuth('/api/ai/settings');
      if (response.ok) {
        const data = await response.json();
        set({
          showPageTree,
          currentProvider: data.currentProvider || null,
          currentModel: data.currentModel || null,
          isAnyProviderConfigured: data.isAnyProviderConfigured || false,
          isInitialized: true,
          isLoading: false,
        });
      } else {
        set({ showPageTree, isInitialized: true, isLoading: false });
      }
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('Failed to load assistant settings:', error);
      }
      set({ isInitialized: true, isLoading: false });
    }
  },
}))

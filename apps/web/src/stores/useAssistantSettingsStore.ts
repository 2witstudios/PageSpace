/**
 * Assistant Settings Store
 *
 * Centralized Zustand store for global assistant settings.
 * Used by SidebarSettingsTab, SidebarChatTab, ChatInput, and GlobalAssistantView.
 *
 * Settings managed:
 * - showPageTree: Whether to include workspace structure in AI context
 * - currentProvider/currentModel: User's selected AI provider configuration
 * - isAnyProviderConfigured: Whether any AI provider has valid credentials
 * - webSearchEnabled: Whether web search tool is enabled
 * - writeMode: Whether AI can make changes (true) or read-only (false)
 *
 * Replaces the previous pattern of duplicated local state + custom events.
 */

import { create } from 'zustand';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

const SHOW_PAGE_TREE_KEY = 'pagespace:assistant:showPageTree';
const WEB_SEARCH_KEY = 'pagespace:assistant:webSearchEnabled';
const WRITE_MODE_KEY = 'pagespace:assistant:writeMode';

interface AssistantSettingsState {
  // Settings
  showPageTree: boolean;
  currentProvider: string | null;
  currentModel: string | null;
  isAnyProviderConfigured: boolean;
  subscriptionTier: string;

  // Chat input toggles (persisted to localStorage)
  webSearchEnabled: boolean;
  writeMode: boolean; // true = write mode, false = read-only

  // Loading state
  isLoading: boolean;
  isInitialized: boolean;

  // Actions
  setShowPageTree: (show: boolean) => void;
  setProviderSettings: (provider: string, model: string) => void;
  loadSettings: () => Promise<void>;

  // Toggle actions
  setWebSearchEnabled: (enabled: boolean) => void;
  toggleWebSearch: () => void;
  setWriteMode: (enabled: boolean) => void;
  toggleWriteMode: () => void;
  toggleShowPageTree: () => void;
}

export const useAssistantSettingsStore = create<AssistantSettingsState>()((set, get) => ({
  // Initial state - all values initialized to defaults, loaded from localStorage/API in loadSettings
  showPageTree: false,
  currentProvider: null,
  currentModel: null,
  isAnyProviderConfigured: false,
  subscriptionTier: 'free',
  webSearchEnabled: false,
  writeMode: true, // Default to write mode (full access)
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

  toggleShowPageTree: () => {
    const current = get().showPageTree;
    get().setShowPageTree(!current);
  },

  setProviderSettings: (provider: string, model: string) => {
    set({ currentProvider: provider, currentModel: model });

    // Dispatch event for cross-browser-tab sync
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ai-settings-updated'));
    }
  },

  setWebSearchEnabled: (enabled: boolean) => {
    set({ webSearchEnabled: enabled });

    // Persist to localStorage
    if (typeof window !== 'undefined') {
      localStorage.setItem(WEB_SEARCH_KEY, String(enabled));
    }
  },

  toggleWebSearch: () => {
    set((state) => {
      const next = !state.webSearchEnabled;
      if (typeof window !== 'undefined') {
        localStorage.setItem(WEB_SEARCH_KEY, String(next));
      }
      return { webSearchEnabled: next };
    });
  },

  setWriteMode: (enabled: boolean) => {
    set({ writeMode: enabled });

    // Persist to localStorage
    if (typeof window !== 'undefined') {
      localStorage.setItem(WRITE_MODE_KEY, String(enabled));
    }
  },

  toggleWriteMode: () => {
    set((state) => {
      const next = !state.writeMode;
      if (typeof window !== 'undefined') {
        localStorage.setItem(WRITE_MODE_KEY, String(next));
      }
      return { writeMode: next };
    });
  },

  loadSettings: async () => {
    // Prevent duplicate loads
    if (get().isLoading || get().isInitialized) return;

    set({ isLoading: true });

    // Apply localStorage values immediately (synchronously) so components
    // that read the store before the API responds see the correct toggle state.
    let showPageTree = false;
    let webSearchEnabled = false;
    let writeMode = true;

    if (typeof window !== 'undefined') {
      const storedShowPageTree = localStorage.getItem(SHOW_PAGE_TREE_KEY);
      if (storedShowPageTree !== null) showPageTree = storedShowPageTree === 'true';
      const storedWebSearch = localStorage.getItem(WEB_SEARCH_KEY);
      if (storedWebSearch !== null) webSearchEnabled = storedWebSearch === 'true';
      const storedWriteMode = localStorage.getItem(WRITE_MODE_KEY);
      if (storedWriteMode !== null) writeMode = storedWriteMode === 'true';
    }

    set({ showPageTree, webSearchEnabled, writeMode });

    try {
      const response = await fetchWithAuth('/api/ai/settings');
      if (response.ok) {
        const data = await response.json();
        set({
          currentProvider: data.currentProvider || null,
          currentModel: data.currentModel || null,
          isAnyProviderConfigured: data.isAnyProviderConfigured || false,
          subscriptionTier: data.userSubscriptionTier || 'free',
          isInitialized: true,
          isLoading: false,
        });
      } else {
        set({ isInitialized: true, isLoading: false });
      }
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('Failed to load assistant settings:', error);
      }
      set({ isInitialized: true, isLoading: false });
    }
  },
}))

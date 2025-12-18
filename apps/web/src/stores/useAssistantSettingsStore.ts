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
}

export const useAssistantSettingsStore = create<AssistantSettingsState>()((set, get) => ({
  // Initial state - all values initialized to defaults, loaded from localStorage/API in loadSettings
  showPageTree: false,
  currentProvider: null,
  currentModel: null,
  isAnyProviderConfigured: false,
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
    const current = get().webSearchEnabled;
    get().setWebSearchEnabled(!current);
  },

  setWriteMode: (enabled: boolean) => {
    set({ writeMode: enabled });

    // Persist to localStorage
    if (typeof window !== 'undefined') {
      localStorage.setItem(WRITE_MODE_KEY, String(enabled));
    }
  },

  toggleWriteMode: () => {
    const current = get().writeMode;
    get().setWriteMode(!current);
  },

  loadSettings: async () => {
    // Prevent duplicate loads
    if (get().isLoading || get().isInitialized) return;

    set({ isLoading: true });

    // Load settings from localStorage (client-side only) - outside try block
    // so values are available in both success and error paths
    let showPageTree = false;
    let webSearchEnabled = false;
    let writeMode = true;

    if (typeof window !== 'undefined') {
      const storedShowPageTree = localStorage.getItem(SHOW_PAGE_TREE_KEY);
      if (storedShowPageTree !== null) {
        showPageTree = storedShowPageTree === 'true';
      }

      const storedWebSearch = localStorage.getItem(WEB_SEARCH_KEY);
      if (storedWebSearch !== null) {
        webSearchEnabled = storedWebSearch === 'true';
      }

      const storedWriteMode = localStorage.getItem(WRITE_MODE_KEY);
      if (storedWriteMode !== null) {
        writeMode = storedWriteMode === 'true';
      }
    }

    try {
      const response = await fetchWithAuth('/api/ai/settings');
      if (response.ok) {
        const data = await response.json();
        set({
          showPageTree,
          webSearchEnabled,
          writeMode,
          currentProvider: data.currentProvider || null,
          currentModel: data.currentModel || null,
          isAnyProviderConfigured: data.isAnyProviderConfigured || false,
          isInitialized: true,
          isLoading: false,
        });
      } else {
        set({ showPageTree, webSearchEnabled, writeMode, isInitialized: true, isLoading: false });
      }
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('Failed to load assistant settings:', error);
      }
      set({ showPageTree, webSearchEnabled, writeMode, isInitialized: true, isLoading: false });
    }
  },
}))

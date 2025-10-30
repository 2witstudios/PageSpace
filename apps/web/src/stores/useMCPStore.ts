/**
 * MCP Store - Manages MCP server settings and per-chat MCP toggle state
 * Zustand store for per-chat MCP configuration
 *
 * MCP is enabled by default when servers are running.
 * Users can disable MCP per-chat if desired (opt-out model).
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface MCPStoreState {
  // Per-chat MCP toggles - map of chatId to enabled state
  // Default is true (enabled), users can opt-out per-chat
  perChatMCP: Record<string, boolean>;

  // Actions
  setChatMCPEnabled: (chatId: string, enabled: boolean) => void;
  isChatMCPEnabled: (chatId: string) => boolean;

  // Reset functions
  clearChatMCPSettings: (chatId: string) => void;
  clearAllChatMCPSettings: () => void;
}

/**
 * MCP Store with localStorage persistence
 * Settings persist across sessions for better UX
 */
export const useMCPStore = create<MCPStoreState>()(
  persist(
    (set, get) => ({
      // Default state - empty perChatMCP map (defaults to enabled)
      perChatMCP: {},

      // Set per-chat MCP enabled/disabled
      setChatMCPEnabled: (chatId: string, enabled: boolean) => {
        set((state) => ({
          perChatMCP: {
            ...state.perChatMCP,
            [chatId]: enabled,
          },
        }));
      },

      // Check if MCP is enabled for a specific chat
      // Returns true by default (opt-out model), false only if explicitly disabled
      isChatMCPEnabled: (chatId: string): boolean => {
        const state = get();
        // If no per-chat setting exists, default to true (enabled)
        // Users must explicitly disable MCP per-chat
        return state.perChatMCP[chatId] ?? true;
      },

      // Clear per-chat MCP setting for a specific chat
      clearChatMCPSettings: (chatId: string) => {
        set((state) => {
          const newPerChatMCP = { ...state.perChatMCP };
          delete newPerChatMCP[chatId];
          return { perChatMCP: newPerChatMCP };
        });
      },

      // Clear all per-chat MCP settings
      clearAllChatMCPSettings: () => {
        set({ perChatMCP: {} });
      },
    }),
    {
      name: 'mcp-settings', // localStorage key
      version: 2, // Increment version to reset old settings with global toggle
    }
  )
);

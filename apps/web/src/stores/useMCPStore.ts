/**
 * MCP Store - Manages MCP server settings and UI toggle state
 * Zustand store for global and per-chat MCP configuration
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface MCPStoreState {
  // Global MCP toggle - controls whether MCP tools are available at all
  globalMCPEnabled: boolean;

  // Per-chat MCP toggles - map of chatId to enabled state
  perChatMCP: Record<string, boolean>;

  // Actions
  setGlobalMCPEnabled: (enabled: boolean) => void;
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
      // Default state - MCP disabled globally
      globalMCPEnabled: false,
      perChatMCP: {},

      // Set global MCP enabled/disabled
      setGlobalMCPEnabled: (enabled: boolean) => {
        set({ globalMCPEnabled: enabled });
      },

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
      // Returns true only if both global AND per-chat are enabled
      isChatMCPEnabled: (chatId: string): boolean => {
        const state = get();
        if (!state.globalMCPEnabled) return false;

        // If no per-chat setting exists, default to false (must explicitly enable)
        return state.perChatMCP[chatId] ?? false;
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
      version: 1,
    }
  )
);

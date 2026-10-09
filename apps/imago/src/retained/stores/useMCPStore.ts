/**
 * MCP Store - Manages MCP server settings and per-chat MCP toggle state
 * Zustand store for per-chat, per-server MCP configuration
 *
 * MCP servers are enabled by default when running.
 * Users can disable individual MCP servers per-chat (opt-out model).
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface MCPStoreState {
  // Per-chat, per-server MCP toggles
  // Structure: { chatId: { serverName: enabled } }
  // Default is true (enabled) for all servers, users can opt-out per-server
  perChatServerMCP: Record<string, Record<string, boolean>>;

  // Actions for per-server control
  setServerEnabled: (chatId: string, serverName: string, enabled: boolean) => void;
  isServerEnabled: (chatId: string, serverName: string) => boolean;
  setAllServersEnabled: (chatId: string, enabled: boolean, serverNames: string[]) => void;
  areAllServersEnabled: (chatId: string, serverNames: string[]) => boolean;
  getEnabledServers: (chatId: string, serverNames: string[]) => string[];

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
      // Default state - empty map (defaults to all servers enabled)
      perChatServerMCP: {},

      // Set specific server enabled/disabled for a chat
      setServerEnabled: (chatId: string, serverName: string, enabled: boolean) => {
        set((state) => ({
          perChatServerMCP: {
            ...state.perChatServerMCP,
            [chatId]: {
              ...state.perChatServerMCP[chatId],
              [serverName]: enabled,
            },
          },
        }));
      },

      // Check if a specific server is enabled for a chat
      // Returns true by default (opt-out model)
      isServerEnabled: (chatId: string, serverName: string): boolean => {
        const state = get();
        return state.perChatServerMCP[chatId]?.[serverName] ?? true;
      },

      // Enable or disable all servers at once for a chat
      setAllServersEnabled: (chatId: string, enabled: boolean, serverNames: string[]) => {
        set((state) => {
          const serverSettings: Record<string, boolean> = {};
          for (const name of serverNames) {
            serverSettings[name] = enabled;
          }
          return {
            perChatServerMCP: {
              ...state.perChatServerMCP,
              [chatId]: serverSettings,
            },
          };
        });
      },

      // Check if all servers are enabled for a chat
      areAllServersEnabled: (chatId: string, serverNames: string[]): boolean => {
        const state = get();
        if (serverNames.length === 0) return false;
        return serverNames.every(
          (name) => state.perChatServerMCP[chatId]?.[name] ?? true
        );
      },

      // Get list of enabled server names for a chat
      getEnabledServers: (chatId: string, serverNames: string[]): string[] => {
        const state = get();
        return serverNames.filter(
          (name) => state.perChatServerMCP[chatId]?.[name] ?? true
        );
      },

      // Clear per-chat MCP settings for a specific chat
      clearChatMCPSettings: (chatId: string) => {
        set((state) => {
          const newSettings = { ...state.perChatServerMCP };
          delete newSettings[chatId];
          return { perChatServerMCP: newSettings };
        });
      },

      // Clear all per-chat MCP settings
      clearAllChatMCPSettings: () => {
        set({ perChatServerMCP: {} });
      },
    }),
    {
      name: 'mcp-settings', // localStorage key
      version: 3, // Increment version to migrate to per-server structure
      migrate: (persistedState: unknown, version: number) => {
        if (version < 3) {
          // Old versions had different structure (perChatMCP: boolean per chat)
          // Start fresh with per-server model - all servers default to enabled
          return { perChatServerMCP: {} };
        }
        return persistedState as MCPStoreState;
      },
    }
  )
);

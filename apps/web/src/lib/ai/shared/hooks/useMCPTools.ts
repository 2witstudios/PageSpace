/**
 * useMCPTools - Shared hook for MCP tool management in AI chats
 * Used by both Agent engine and Global Assistant engine
 *
 * Supports per-server toggles, allowing users to enable/disable
 * individual MCP servers for each conversation.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useMCP } from '@/hooks/useMCP';
import { useMCPStore } from '@/stores/useMCPStore';
import { toast } from 'sonner';
import type { MCPToolSchema } from '../chat-types';

interface UseMCPToolsOptions {
  /** The conversation/chat ID to track MCP state for */
  conversationId: string | null;
}

interface UseMCPToolsResult {
  /** Whether we're running in desktop app */
  isDesktop: boolean;
  /** Number of running MCP servers */
  runningServers: number;
  /** Names of running MCP servers */
  runningServerNames: string[];
  /** MCP tool schemas fetched from running servers (filtered by enabled servers) */
  mcpToolSchemas: MCPToolSchema[];
  /** Server statuses from MCP */
  serverStatuses: ReturnType<typeof useMCP>['serverStatuses'];
  /** Number of enabled servers (for badge display) */
  enabledServerCount: number;
  /** Check if a specific server is enabled for this chat */
  isServerEnabled: (serverName: string) => boolean;
  /** Toggle a specific server for this chat */
  setServerEnabled: (serverName: string, enabled: boolean) => void;
  /** Check if all servers are enabled */
  allServersEnabled: boolean;
  /** Toggle all servers at once */
  setAllServersEnabled: (enabled: boolean) => void;
}

/**
 * Hook for managing MCP tools in AI chat views
 * Handles fetching tools, tracking per-server enabled state, and filtering
 */
export function useMCPTools({ conversationId }: UseMCPToolsOptions): UseMCPToolsResult {
  const mcp = useMCP();

  // Use Zustand selectors to subscribe to specific state slices
  // _perChatServerMCP triggers re-renders when state changes (value unused, subscription only)
  const _perChatServerMCP = useMCPStore((state) => state.perChatServerMCP);
  const getEnabledServersFn = useMCPStore((state) => state.getEnabledServers);
  const areAllServersEnabledFn = useMCPStore((state) => state.areAllServersEnabled);
  const isServerEnabledFn = useMCPStore((state) => state.isServerEnabled);
  const setServerEnabledFn = useMCPStore((state) => state.setServerEnabled);
  const setAllServersEnabledFn = useMCPStore((state) => state.setAllServersEnabled);

  // Chat ID for per-chat settings (or 'global' fallback)
  const chatId = conversationId || 'global';

  // All MCP tool schemas from running servers (unfiltered)
  const [allMcpToolSchemas, setAllMcpToolSchemas] = useState<MCPToolSchema[]>([]);

  // Get names of running servers - memoize to prevent unnecessary re-renders
  const runningServerNames = useMemo(() => {
    if (!mcp.isDesktop) {
      return [];
    }
    const running = Object.entries(mcp.serverStatuses)
      .filter(([, status]) => status.status === 'running')
      .map(([name]) => name);
    return running;
  }, [mcp.isDesktop, mcp.serverStatuses]);

  // Serialize running server names for stable dependency comparison
  const runningServerNamesKey = useMemo(
    () => runningServerNames.join(','),
    [runningServerNames]
  );

  // Count running MCP servers
  const runningServers = runningServerNames.length;

  // Get enabled servers for this chat
  // perChatServerMCP selector subscription ensures re-render when state changes
  // No useMemo needed - getter functions read current state via get()
  const enabledServerNames = getEnabledServersFn(chatId, runningServerNames);
  const enabledServerCount = enabledServerNames.length;

  // Check if all servers are enabled
  const allServersEnabled = areAllServersEnabledFn(chatId, runningServerNames);

  // Check if specific server is enabled
  const isServerEnabled = useCallback(
    (serverName: string) => isServerEnabledFn(chatId, serverName),
    [isServerEnabledFn, chatId]
  );

  // Set specific server enabled/disabled
  const setServerEnabled = useCallback(
    (serverName: string, enabled: boolean) => {
      setServerEnabledFn(chatId, serverName, enabled);
    },
    [setServerEnabledFn, chatId]
  );

  // Toggle all servers at once
  const setAllServersEnabled = useCallback(
    (enabled: boolean) => {
      setAllServersEnabledFn(chatId, enabled, runningServerNames);
    },
    [setAllServersEnabledFn, chatId, runningServerNames]
  );

  // Fetch MCP tools when servers are running
  // Use runningServerNamesKey for stable dependency comparison (prevents unnecessary refetches)
  useEffect(() => {
    const fetchMCPTools = async () => {
      // Debug logging to help diagnose MCP tools visibility issues
      console.log('[useMCPTools] Fetch effect triggered:', {
        isDesktop: mcp.isDesktop,
        runningServerCount: runningServerNames.length,
        runningServers: runningServerNames,
        hasElectronAPI: typeof window !== 'undefined' && !!window.electron,
      });

      if (mcp.isDesktop && runningServerNames.length > 0 && window.electron) {
        try {
          console.log('[useMCPTools] Fetching tools from Electron...');
          const tools = await window.electron.mcp.getAvailableTools();
          console.log('[useMCPTools] Received tools from Electron:', {
            toolCount: tools.length,
            tools: tools.map((t) => `${t.serverName}:${t.name}`),
          });
          setAllMcpToolSchemas(tools);
        } catch (error) {
          console.error('[useMCPTools] Failed to fetch MCP tools:', error);
          setAllMcpToolSchemas([]);
          toast.error('Failed to load MCP tools');
        }
      } else {
        // Clear MCP tools when no servers running
        if (mcp.isDesktop) {
          console.log('[useMCPTools] No running servers, clearing tools');
        }
        setAllMcpToolSchemas([]);
      }
    };

    fetchMCPTools();
  }, [mcp.isDesktop, runningServerNamesKey, runningServerNames]);

  // Filter tools to only include those from enabled servers
  const mcpToolSchemas = useMemo(() => {
    console.log('[useMCPTools] Computing mcpToolSchemas:', {
      enabledServerCount: enabledServerNames.length,
      enabledServers: enabledServerNames,
      allToolCount: allMcpToolSchemas.length,
      chatId,
    });

    if (enabledServerNames.length === 0) {
      console.log('[useMCPTools] No enabled servers, returning empty tools');
      return [];
    }
    const enabledSet = new Set(enabledServerNames);
    const filtered = allMcpToolSchemas.filter((tool) => enabledSet.has(tool.serverName));

    console.log('[useMCPTools] Filtered tools:', {
      filteredCount: filtered.length,
      tools: filtered.map((t) => `${t.serverName}:${t.name}`),
    });

    return filtered;
  }, [allMcpToolSchemas, enabledServerNames, chatId]);

  return {
    isDesktop: mcp.isDesktop,
    runningServers,
    runningServerNames,
    mcpToolSchemas,
    serverStatuses: mcp.serverStatuses,
    enabledServerCount,
    isServerEnabled,
    setServerEnabled,
    allServersEnabled,
    setAllServersEnabled,
  };
}

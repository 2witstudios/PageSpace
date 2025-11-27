/**
 * useMCPTools - Shared hook for MCP tool management in AI chats
 * Used by both Agent engine and Global Assistant engine
 */

import { useState, useEffect, useMemo } from 'react';
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
  /** Whether MCP is enabled for this conversation */
  mcpEnabled: boolean;
  /** Set MCP enabled state for this conversation */
  setMcpEnabled: (enabled: boolean) => void;
  /** Number of running MCP servers */
  runningServers: number;
  /** MCP tool schemas fetched from running servers */
  mcpToolSchemas: MCPToolSchema[];
  /** Server statuses from MCP */
  serverStatuses: ReturnType<typeof useMCP>['serverStatuses'];
}

/**
 * Hook for managing MCP tools in AI chat views
 * Handles fetching tools, tracking enabled state, and counting servers
 */
export function useMCPTools({ conversationId }: UseMCPToolsOptions): UseMCPToolsResult {
  const mcp = useMCP();
  const { isChatMCPEnabled, setChatMCPEnabled } = useMCPStore();

  // MCP enabled state for this conversation (or 'global' fallback)
  const chatId = conversationId || 'global';
  const mcpEnabled = isChatMCPEnabled(chatId);

  // MCP tool schemas from running servers
  const [mcpToolSchemas, setMcpToolSchemas] = useState<MCPToolSchema[]>([]);

  // Count running MCP servers
  const runningServers = useMemo(() => {
    if (!mcp.isDesktop) return 0;
    return Object.values(mcp.serverStatuses).filter(s => s.status === 'running').length;
  }, [mcp.isDesktop, mcp.serverStatuses]);

  // Fetch MCP tools when enabled and servers are running
  useEffect(() => {
    const fetchMCPTools = async () => {
      if (mcp.isDesktop && mcpEnabled && runningServers > 0 && window.electron) {
        try {
          const tools = await window.electron.mcp.getAvailableTools();
          setMcpToolSchemas(tools);
        } catch (error) {
          console.error('Failed to fetch MCP tools:', error);
          setMcpToolSchemas([]);
          toast.error('Failed to load MCP tools');
        }
      } else {
        // Clear MCP tools when disabled or no servers running
        setMcpToolSchemas([]);
      }
    };

    fetchMCPTools();
  }, [mcp.isDesktop, mcpEnabled, runningServers]);

  // Setter that uses the chat ID
  const setMcpEnabled = (enabled: boolean) => {
    setChatMCPEnabled(chatId, enabled);
  };

  return {
    isDesktop: mcp.isDesktop,
    mcpEnabled,
    setMcpEnabled,
    runningServers,
    mcpToolSchemas,
    serverStatuses: mcp.serverStatuses,
  };
}

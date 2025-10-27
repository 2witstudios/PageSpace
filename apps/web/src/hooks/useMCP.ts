import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import type { MCPConfig, MCPServerConfig, MCPServerStatusInfo } from '@/types/mcp';

/**
 * Custom hook for managing MCP server operations
 * Provides a clean abstraction over Electron IPC for MCP functionality
 */
export function useMCP() {
  const [config, setConfig] = useState<MCPConfig>({ mcpServers: {} });
  const [serverStatuses, setServerStatuses] = useState<Record<string, MCPServerStatusInfo>>({});
  const [loading, setLoading] = useState(true);
  const [isDesktop, setIsDesktop] = useState(false);

  // Check if running in desktop app
  useEffect(() => {
    const checkDesktop = () => {
      if (typeof window !== 'undefined' && window.electron?.isDesktop) {
        setIsDesktop(true);
      } else {
        setIsDesktop(false);
      }
    };
    checkDesktop();
  }, []);

  // Load configuration
  const loadConfig = useCallback(async () => {
    if (!isDesktop || !window.electron) return;

    try {
      const loadedConfig = await window.electron.mcp.getConfig();
      setConfig(loadedConfig);
    } catch (error) {
      console.error('Failed to load MCP config:', error);
      toast.error('Failed to load MCP configuration');
    }
  }, [isDesktop]);

  // Load server statuses
  const loadStatuses = useCallback(async () => {
    if (!isDesktop || !window.electron) return;

    try {
      const statuses = await window.electron.mcp.getServerStatuses();
      setServerStatuses(statuses);
    } catch (error) {
      console.error('Failed to load server statuses:', error);
    } finally {
      setLoading(false);
    }
  }, [isDesktop]);

  // Subscribe to status changes
  useEffect(() => {
    if (!isDesktop || !window.electron) return;

    // Initial load
    loadConfig();
    loadStatuses();

    // Subscribe to status change events
    const unsubscribe = window.electron.mcp.onStatusChange((statuses) => {
      setServerStatuses(statuses);
    });

    return unsubscribe;
  }, [isDesktop, loadConfig, loadStatuses]);

  // Start server
  const startServer = useCallback(async (name: string) => {
    if (!window.electron) {
      return { success: false, error: 'Not running in desktop app' };
    }

    try {
      const result = await window.electron.mcp.startServer(name);
      if (result.success) {
        toast.success(`Server "${name}" started successfully`);
        return { success: true };
      } else {
        toast.error(`Failed to start server: ${result.error}`);
        return { success: false, error: result.error };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Error starting server: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }, []);

  // Stop server
  const stopServer = useCallback(async (name: string) => {
    if (!window.electron) {
      return { success: false, error: 'Not running in desktop app' };
    }

    try {
      const result = await window.electron.mcp.stopServer(name);
      if (result.success) {
        toast.success(`Server "${name}" stopped successfully`);
        return { success: true };
      } else {
        toast.error(`Failed to stop server: ${result.error}`);
        return { success: false, error: result.error };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Error stopping server: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }, []);

  // Restart server
  const restartServer = useCallback(async (name: string) => {
    if (!window.electron) {
      return { success: false, error: 'Not running in desktop app' };
    }

    try {
      const result = await window.electron.mcp.restartServer(name);
      if (result.success) {
        toast.success(`Server "${name}" restarted successfully`);
        return { success: true };
      } else {
        toast.error(`Failed to restart server: ${result.error}`);
        return { success: false, error: result.error };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Error restarting server: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }, []);

  // Update configuration
  const updateConfig = useCallback(async (newConfig: MCPConfig) => {
    if (!window.electron) {
      return { success: false, error: 'Not running in desktop app' };
    }

    try {
      await window.electron.mcp.updateConfig(newConfig);
      setConfig(newConfig);
      toast.success('Configuration saved successfully');
      await loadConfig();
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Invalid configuration';
      toast.error(errorMessage);
      return { success: false, error: errorMessage };
    }
  }, [loadConfig]);

  // Add server
  const addServer = useCallback(async (name: string, serverConfig: MCPServerConfig) => {
    const newConfig: MCPConfig = {
      ...config,
      mcpServers: {
        ...config.mcpServers,
        [name]: serverConfig,
      },
    };

    return await updateConfig(newConfig);
  }, [config, updateConfig]);

  // Remove server
  const removeServer = useCallback(async (name: string) => {
    const newConfig = {
      ...config,
      mcpServers: Object.fromEntries(
        Object.entries(config.mcpServers).filter(([key]) => key !== name)
      ),
    };

    try {
      await updateConfig(newConfig);
      toast.success(`Server "${name}" removed`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Failed to remove server: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }, [config, updateConfig]);

  return {
    isDesktop,
    loading,
    config,
    serverStatuses,
    startServer,
    stopServer,
    restartServer,
    updateConfig,
    addServer,
    removeServer,
    loadConfig,
    loadStatuses,
  };
}

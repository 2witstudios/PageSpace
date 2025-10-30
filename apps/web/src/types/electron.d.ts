/**
 * Type definitions for Electron API when running in desktop app
 */

import type { MCPConfig, MCPServerStatusInfo, MCPTool, ToolExecutionResult } from './mcp';

export interface ElectronAPI {
  getAppUrl: () => Promise<string>;
  setAppUrl: (url: string) => Promise<boolean>;
  onDeepLink: (callback: (url: string) => void) => void;
  onOpenPreferences: (callback: () => void) => void;
  retryConnection: () => Promise<void>;
  platform: NodeJS.Platform;
  version: string;
  auth: {
    /**
     * Gets the JWT token from Electron's secure cookie storage.
     * Used for Bearer token authentication in Desktop app.
     * @returns JWT string or null if not authenticated
     */
    getJWT: () => Promise<string | null>;
    /**
     * Clears authentication data (JWT cookies) from Electron session.
     * Called during logout.
     */
    clearAuth: () => Promise<void>;
  };
  mcp: {
    getConfig: () => Promise<MCPConfig>;
    updateConfig: (config: MCPConfig) => Promise<{ success: boolean }>;
    startServer: (name: string) => Promise<{ success: boolean; error?: string }>;
    stopServer: (name: string) => Promise<{ success: boolean; error?: string }>;
    restartServer: (name: string) => Promise<{ success: boolean; error?: string }>;
    getServerStatuses: () => Promise<Record<string, MCPServerStatusInfo>>;
    onStatusChange: (callback: (statuses: Record<string, MCPServerStatusInfo>) => void) => () => void;
    // Tool operations (Phase 2)
    getAvailableTools: () => Promise<MCPTool[]>;
    executeTool: (serverName: string, toolName: string, args?: Record<string, unknown>) => Promise<ToolExecutionResult>;
  };
  ws: {
    getStatus: () => Promise<{
      connected: boolean;
      reconnectAttempts: number;
    }>;
  };
  isDesktop: true;
}

declare global {
  interface Window {
    electron?: ElectronAPI;
    isDesktop?: boolean;
  }
}

export {};

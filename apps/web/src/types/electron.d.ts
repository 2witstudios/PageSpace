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
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
  removeAllListeners: (channel: string) => void;
  platform: NodeJS.Platform;
  version: string;
  auth: {
    /**
     * Gets the opaque session token from Electron's secure storage.
     * Used for Bearer token authentication in Desktop app.
     * @returns Session token string (ps_sess_*) or null if not authenticated
     */
    getSessionToken: () => Promise<string | null>;
    /**
     * Retrieves the full stored session, including device tokens.
     */
    getSession: () => Promise<{
      sessionToken: string;
      csrfToken?: string | null;
      deviceToken?: string | null;
    } | null>;
    /**
     * Persists the current authentication session in the native secure storage.
     */
    storeSession: (session: {
      sessionToken: string;
      csrfToken?: string | null;
      deviceToken?: string | null;
    }) => Promise<{ success: boolean }>;
    /**
     * Clears authentication data from Electron session.
     * Called during logout.
     */
    clearAuth: () => Promise<void>;
    /**
     * Returns device metadata used for device token authentication.
     */
    getDeviceInfo: () => Promise<{
      deviceId: string;
      deviceName: string;
      platform: NodeJS.Platform;
      appVersion: string;
      userAgent: string;
    }>;
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
  power: {
    /**
     * Gets the current power state from the main process.
     */
    getState: () => Promise<{
      isSuspended: boolean;
      suspendTime: number | null;
      systemIdleTime: number;
    }>;
    /**
     * Listens for system suspend (sleep/hibernate) events.
     * @returns Cleanup function to remove the listener
     */
    onSuspend: (callback: (data: { suspendTime: number }) => void) => () => void;
    /**
     * Listens for system resume (wake from sleep) events.
     * @returns Cleanup function to remove the listener
     */
    onResume: (callback: (data: {
      resumeTime: number;
      sleepDuration: number;
      forceRefresh: boolean;
    }) => void) => () => void;
    /**
     * Listens for screen lock events.
     * @returns Cleanup function to remove the listener
     */
    onLockScreen: (callback: () => void) => () => void;
    /**
     * Listens for screen unlock events.
     * @returns Cleanup function to remove the listener
     */
    onUnlockScreen: (callback: (data: { shouldRefresh: boolean }) => void) => () => void;
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

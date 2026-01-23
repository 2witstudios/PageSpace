import { contextBridge, ipcRenderer } from 'electron';
import type {
  MCPConfig,
  MCPServerStatusInfo,
  MCPTool,
  ToolExecutionResult,
} from '../shared/mcp-types';

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  // Get the configured app URL
  getAppUrl: () => ipcRenderer.invoke('get-app-url'),

  // Set a custom app URL
  setAppUrl: (url: string) => ipcRenderer.invoke('set-app-url', url),

  // Listen for deep link events
  onDeepLink: (callback: (url: string) => void) => {
    ipcRenderer.on('deep-link', (_event, url) => callback(url));
  },

  // Listen for preferences open event
  onOpenPreferences: (callback: () => void) => {
    ipcRenderer.on('open-preferences', () => callback());
  },

  // Retry connection when offline
  retryConnection: () => ipcRenderer.invoke('retry-connection'),

  // Generic event listener for IPC messages
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, handler);
    // Return cleanup function to remove this specific listener
    return () => ipcRenderer.removeListener(channel, handler);
  },

  // Remove all listeners for a channel (for cleanup)
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },

  // Platform information
  platform: process.platform,

  // App version
  version: process.env.npm_package_version || '1.0.0',

  // Authentication
  auth: {
    getSessionToken: () => ipcRenderer.invoke('auth:get-session-token'),
    getSession: () => ipcRenderer.invoke('auth:get-session'),
    storeSession: (session: {
      sessionToken: string;
      csrfToken?: string | null;
      deviceToken?: string | null;
    }) => ipcRenderer.invoke('auth:store-session', session),
    clearAuth: () => ipcRenderer.invoke('auth:clear-auth'),
    getDeviceInfo: () => ipcRenderer.invoke('auth:get-device-info'),
  },

  // MCP Server Management
  mcp: {
    getConfig: () => ipcRenderer.invoke('mcp:get-config'),
    updateConfig: (config: MCPConfig) => ipcRenderer.invoke('mcp:update-config', config),
    startServer: (name: string) => ipcRenderer.invoke('mcp:start-server', name),
    stopServer: (name: string) => ipcRenderer.invoke('mcp:stop-server', name),
    restartServer: (name: string) => ipcRenderer.invoke('mcp:restart-server', name),
    getServerStatuses: () => ipcRenderer.invoke('mcp:get-server-statuses'),
    onStatusChange: (callback: (statuses: Record<string, MCPServerStatusInfo>) => void) => {
      const subscription = (_event: any, statuses: Record<string, MCPServerStatusInfo>) => callback(statuses);
      ipcRenderer.on('mcp:status-changed', subscription);
      return () => ipcRenderer.removeListener('mcp:status-changed', subscription);
    },
    // Tool operations (Phase 2)
    getAvailableTools: () => ipcRenderer.invoke('mcp:get-available-tools'),
    executeTool: (serverName: string, toolName: string, args?: Record<string, unknown>) =>
      ipcRenderer.invoke('mcp:execute-tool', serverName, toolName, args),
  },

  // WebSocket MCP Bridge
  ws: {
    getStatus: () => ipcRenderer.invoke('ws:get-status'),
  },

  // Window controls
  window: {
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  },

  // Power state management (for handling sleep/wake auth coordination)
  power: {
    getState: () => ipcRenderer.invoke('power:get-state'),
    onSuspend: (callback: (data: { suspendTime: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { suspendTime: number }) => callback(data);
      ipcRenderer.on('power:suspend', handler);
      return () => ipcRenderer.removeListener('power:suspend', handler);
    },
    onResume: (callback: (data: { resumeTime: number; sleepDuration: number; forceRefresh: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { resumeTime: number; sleepDuration: number; forceRefresh: boolean }) => callback(data);
      ipcRenderer.on('power:resume', handler);
      return () => ipcRenderer.removeListener('power:resume', handler);
    },
    onLockScreen: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('power:lock-screen', handler);
      return () => ipcRenderer.removeListener('power:lock-screen', handler);
    },
    onUnlockScreen: (callback: (data: { shouldRefresh: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { shouldRefresh: boolean }) => callback(data);
      ipcRenderer.on('power:unlock-screen', handler);
      return () => ipcRenderer.removeListener('power:unlock-screen', handler);
    },
  },

  // Desktop flag for feature detection
  isDesktop: true,
});

// Type definitions for the exposed API
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
    getSessionToken: () => Promise<string | null>;
    getSession: () => Promise<{
      sessionToken: string;
      csrfToken?: string | null;
      deviceToken?: string | null;
    } | null>;
    storeSession: (session: {
      sessionToken: string;
      csrfToken?: string | null;
      deviceToken?: string | null;
    }) => Promise<{ success: boolean }>;
    clearAuth: () => Promise<void>;
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
  window: {
    toggleMaximize: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
  };
  power: {
    getState: () => Promise<{
      isSuspended: boolean;
      suspendTime: number | null;
      systemIdleTime: number;
    }>;
    onSuspend: (callback: (data: { suspendTime: number }) => void) => () => void;
    onResume: (callback: (data: { resumeTime: number; sleepDuration: number; forceRefresh: boolean }) => void) => () => void;
    onLockScreen: (callback: () => void) => () => void;
    onUnlockScreen: (callback: (data: { shouldRefresh: boolean }) => void) => () => void;
  };
  isDesktop: true;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    isDesktop?: boolean;
  }
}

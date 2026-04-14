import * as os from 'node:os';
import { app, ipcMain, session, shell } from 'electron';
import { store } from './store';
import { getAppUrl } from './app-url';
import { mainWindow } from './state';
import { reloadMainWindow } from './window';
import { getMCPManager } from './mcp-manager';
import { getWSClient } from './ws-client';
import { logger } from './logger';
import { getErrorMessage } from './error-utils';
import { saveAuthSession, clearAuthSession, type StoredAuthSession } from './auth-storage';
import { getMachineIdentifier, getOrLoadSession } from './auth-session';
import { getPowerState } from './power-monitor';
import { triggerMCPStatusBroadcast } from './mcp-status';
import type { MCPConfig } from '../shared/mcp-types';

const storeAsAny = store as any;

export function registerIPCHandlers(): void {
  ipcMain.handle('get-app-url', () => getAppUrl());

  ipcMain.handle('set-app-url', (_event, url: string) => {
    storeAsAny.set('appUrl', url);
    return true;
  });

  ipcMain.handle('retry-connection', () => {
    reloadMainWindow();
  });

  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.handle('window:is-maximized', () => {
    return mainWindow?.isMaximized() ?? false;
  });

  ipcMain.handle('auth:get-session-token', async () => {
    const session = await getOrLoadSession();
    return session?.sessionToken ?? null;
  });

  ipcMain.handle('auth:get-session', async () => {
    const session = await getOrLoadSession();
    return session ?? null;
  });

  ipcMain.handle('auth:store-session', async (_event, sessionData: StoredAuthSession) => {
    await saveAuthSession(sessionData);

    // Also set the session cookie on the BrowserWindow's session
    // so subsequent page loads/fetches include the cookie
    const appUrl = new URL(getAppUrl());
    try {
      await session.defaultSession.cookies.set({
        url: appUrl.origin,
        name: 'session',
        value: sessionData.sessionToken,
        path: '/',
        httpOnly: true,
        secure: appUrl.protocol === 'https:',
        sameSite: 'strict' as const,
        expirationDate: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      });
    } catch (cookieError) {
      console.warn('[Auth IPC] Failed to set session cookie:', cookieError);
    }

    return { success: true };
  });

  ipcMain.handle('auth:clear-auth', async () => {
    try {
      await clearAuthSession();
      await session.defaultSession.clearStorageData({
        storages: ['cookies'],
      });

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auth:cleared');
      }

      console.log('[Auth IPC] Auth data cleared successfully');
    } catch (error) {
      console.error('[Auth IPC] Failed to clear auth data:', error);
    }
  });

  ipcMain.handle('auth:get-device-info', async () => {
    return {
      deviceId: getMachineIdentifier(),
      deviceName: os.hostname(),
      platform: process.platform,
      appVersion: app.getVersion(),
      userAgent: `${os.type()} ${os.release()} (${process.arch})`,
    };
  });

  // Open an auth URL in the system browser. Allows:
  //  - OAuth providers over HTTPS (Google, Apple)
  //  - The configured PageSpace app origin on the /auth/passkey-external path
  //    (HTTPS for remote origins, HTTP only for localhost/127.0.0.1 dev builds)
  const ALLOWED_AUTH_HOSTNAMES = ['accounts.google.com', 'appleid.apple.com'];
  const PASSKEY_EXTERNAL_PATH = '/auth/passkey-external';

  const isAppOriginMatch = (parsed: URL): boolean => {
    try {
      const appUrl = new URL(getAppUrl());
      if (parsed.hostname !== appUrl.hostname) return false;
      if (parsed.port !== appUrl.port) return false;
      const isLocal =
        parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (parsed.protocol === 'https:') return true;
      if (parsed.protocol === 'http:' && isLocal) return true;
      return false;
    } catch {
      return false;
    }
  };

  ipcMain.handle('auth:open-external', async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      const isOAuthProvider =
        parsed.protocol === 'https:' && ALLOWED_AUTH_HOSTNAMES.includes(parsed.hostname);
      const isPasskeyHandoff =
        parsed.pathname === PASSKEY_EXTERNAL_PATH && isAppOriginMatch(parsed);

      if (!isOAuthProvider && !isPasskeyHandoff) {
        console.warn('[Auth IPC] Blocked open-external for URL not in allowlist:', parsed.hostname, parsed.pathname);
        return { success: false, error: `URL "${parsed.hostname}${parsed.pathname}" is not allowed` };
      }
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error('[Auth IPC] Failed to open external URL:', error);
      return { success: false, error: 'Invalid URL' };
    }
  });

  ipcMain.handle('mcp:get-config', async () => {
    logger.debug('mcp:get-config handler called', {});
    const mcpManager = getMCPManager();
    const config = mcpManager.getConfig();
    logger.debug('Returning config to renderer', { config });
    return config;
  });

  ipcMain.handle('mcp:update-config', async (_event, config: MCPConfig) => {
    logger.debug('mcp:update-config handler called', {});
    const mcpManager = getMCPManager();
    try {
      logger.debug('Received config from renderer', { config });
      await mcpManager.updateConfig(config);
      logger.info('Config updated successfully', {});
      return { success: true };
    } catch (error: unknown) {
      logger.error('Failed to update config', { error });
      const message = getErrorMessage(error);
      logger.error('Error message', { errorMessage: message });
      return { success: false, error: message };
    }
  });

  ipcMain.handle('mcp:start-server', async (_event, name: string) => {
    const mcpManager = getMCPManager();
    try {
      await mcpManager.startServer(name);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('mcp:stop-server', async (_event, name: string) => {
    const mcpManager = getMCPManager();
    try {
      await mcpManager.stopServer(name);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('mcp:restart-server', async (_event, name: string) => {
    const mcpManager = getMCPManager();
    try {
      await mcpManager.restartServer(name);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('mcp:get-server-statuses', async () => {
    const mcpManager = getMCPManager();
    return mcpManager.getServerStatuses();
  });

  ipcMain.handle('mcp:get-available-tools', async () => {
    try {
      const mcpManager = getMCPManager();
      const tools = mcpManager.getAggregatedTools();
      logger.debug('Returning aggregated tools from all running servers', { toolCount: tools.length });
      return tools;
    } catch (error) {
      logger.error('Failed to get available tools', { error });
      return [];
    }
  });

  ipcMain.handle('mcp:execute-tool', async (_event, serverName: string, toolName: string, args: Record<string, unknown>) => {
    try {
      logger.debug('Executing tool', { serverName, toolName });
      const mcpManager = getMCPManager();
      const result = await mcpManager.executeTool(serverName, toolName, args);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Tool execution failed', { serverName, toolName, error });
      return {
        success: false,
        error: errorMessage,
      };
    }
  });

  ipcMain.handle('ws:get-status', () => {
    const wsClient = getWSClient();
    if (!wsClient) {
      return {
        connected: false,
        reconnectAttempts: 0,
      };
    }
    return wsClient.getStatus();
  });

  ipcMain.handle('power:get-state', () => {
    return getPowerState();
  });
}

export function setupMCPToolsReadyCallback(): void {
  const mcpManager = getMCPManager();
  mcpManager.setOnToolsReady((serverName: string) => {
    logger.debug('Tools ready callback triggered', { serverName });
    triggerMCPStatusBroadcast();
  });
}

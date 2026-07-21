import * as os from 'node:os';
import { app, ipcMain, session, shell } from 'electron';
import { store } from './store';
import { getAppUrl } from './app-url';
import { mainWindow, setCachedSession } from './state';
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
import {
  ALLOWED_APP_ORIGINS,
  isAllowedAppUrl,
  isTrustedSenderUrl,
} from '../shared/navigation-guard';
import { beginAuthExchangeFlow } from './auth-exchange-state';

const storeAsAny = store as any;

/**
 * True when the IPC was sent by a frame on the trusted app origin (security
 * finding H5). Capability-bearing bridge calls (raw session token, MCP exec,
 * set-app-url) must answer only the trusted origin so an off-origin document
 * cannot abuse the preload bridge. Fails closed when the sender URL is unknown.
 */
function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {
  let appOrigin: string;
  try {
    appOrigin = new URL(getAppUrl()).origin;
  } catch {
    return false;
  }
  return isTrustedSenderUrl(event.senderFrame?.url, appOrigin);
}

export function registerIPCHandlers(): void {
  ipcMain.handle('get-app-url', () => getAppUrl());

  ipcMain.handle('set-app-url', (event, url: string) => {
    if (!isTrustedSender(event)) {
      console.warn('[IPC] Blocked set-app-url from untrusted sender');
      return false;
    }
    // Allowlist-validate the target (security finding H5): never let the
    // renderer persist an arbitrary origin that the shell would load on the
    // next launch. The currently-configured origin is included so an
    // env-configured deployment keeps working.
    let allowlist: readonly string[] = ALLOWED_APP_ORIGINS;
    try {
      allowlist = [...ALLOWED_APP_ORIGINS, new URL(getAppUrl()).origin];
    } catch {
      // fall back to the static allowlist
    }
    if (typeof url !== 'string' || !isAllowedAppUrl(url, allowlist)) {
      console.warn('[IPC] Blocked set-app-url for non-allowlisted URL:', url);
      return false;
    }
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

  ipcMain.handle('auth:get-session-token', async (event) => {
    if (!isTrustedSender(event)) {
      console.warn('[IPC] Blocked auth:get-session-token from untrusted sender');
      return null;
    }
    const session = await getOrLoadSession();
    return session?.sessionToken ?? null;
  });

  ipcMain.handle('auth:get-session', async (event) => {
    if (!isTrustedSender(event)) {
      console.warn('[IPC] Blocked auth:get-session from untrusted sender');
      return null;
    }
    const session = await getOrLoadSession();
    return session ?? null;
  });

  // Begin a desktop-initiated auth flow (security finding L9). Records a
  // single-use, TTL-bounded state so a subsequent pagespace://auth-exchange
  // deep link can be bound to a login this instance actually started. Returns
  // the state so the caller can forward it to the server for strong binding.
  ipcMain.handle('auth:begin-exchange', (event) => {
    if (!isTrustedSender(event)) {
      console.warn('[IPC] Blocked auth:begin-exchange from untrusted sender');
      return null;
    }
    return beginAuthExchangeFlow();
  });

  ipcMain.handle('auth:store-session', async (event, sessionData: StoredAuthSession) => {
    // Writing a session into native secure storage + the cookie jar is the most
    // capability-bearing bridge call — restrict it to the trusted origin so an
    // off-origin document cannot inject an attacker session (H5).
    if (!isTrustedSender(event)) {
      console.warn('[Auth IPC] Blocked auth:store-session from untrusted sender');
      return { success: false };
    }
    await saveAuthSession(sessionData);
    // Keep the in-memory cache in sync with what was just persisted. Without
    // this, getOrLoadSession() keeps serving the STALE startup token after a
    // refresh (it only re-reads disk when the cache is empty), so every API
    // call starts failing ~when the old token expires — the desktop
    // "random logout" — until a sleep/wake or restart repopulates the cache.
    setCachedSession(sessionData);

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

  ipcMain.handle('auth:clear-auth', async (event) => {
    if (!isTrustedSender(event)) {
      console.warn('[Auth IPC] Blocked auth:clear-auth from untrusted sender');
      return;
    }
    try {
      await clearAuthSession();
      // clearAuthSession only unlinks the file — invalidate the in-memory
      // cache too so a known-bad token can't keep being served from memory.
      setCachedSession(null);
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
  //  - The configured PageSpace app origin on an allowlisted passkey-handoff
  //    path (HTTPS for remote origins, HTTP only for localhost/127.0.0.1 dev)
  const ALLOWED_AUTH_HOSTNAMES = ['accounts.google.com', 'appleid.apple.com'];
  const ALLOWED_PASSKEY_PATHS: ReadonlySet<string> = new Set([
    '/auth/passkey-external',
    '/auth/passkey-register-external',
  ]);

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
        ALLOWED_PASSKEY_PATHS.has(parsed.pathname) && isAppOriginMatch(parsed);

      if (!isOAuthProvider && !isPasskeyHandoff) {
        console.warn('[Auth IPC] Blocked open-external for URL not in allowlist:', parsed.hostname, parsed.pathname);
        return { success: false, error: `URL "${parsed.hostname}${parsed.pathname}" is not allowed` };
      }
      // This is a desktop-initiated login: mark an auth flow in progress so the
      // returning pagespace://auth-exchange deep link is bound to it (L9).
      beginAuthExchangeFlow();
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error('[Auth IPC] Failed to open external URL:', error);
      return { success: false, error: 'Invalid URL' };
    }
  });

  ipcMain.handle('mcp:get-config', async (event) => {
    logger.debug('mcp:get-config handler called', {});
    // The config may include per-server `env` (e.g. MCP API keys), so restrict
    // the read to the trusted origin (H5), consistent with the token reads.
    if (!isTrustedSender(event)) {
      console.warn('[IPC] Blocked mcp:get-config from untrusted sender');
      return { mcpServers: {} };
    }
    const mcpManager = getMCPManager();
    const config = mcpManager.getConfig();
    logger.debug('Returning config to renderer', { config });
    return config;
  });

  ipcMain.handle('mcp:update-config', async (event, config: MCPConfig) => {
    logger.debug('mcp:update-config handler called', {});
    if (!isTrustedSender(event)) {
      console.warn('[IPC] Blocked mcp:update-config from untrusted sender');
      return { success: false, error: 'Untrusted sender origin' };
    }
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

  ipcMain.handle('mcp:start-server', async (event, name: string) => {
    if (!isTrustedSender(event)) {
      console.warn('[IPC] Blocked mcp:start-server from untrusted sender');
      return { success: false, error: 'Untrusted sender origin' };
    }
    const mcpManager = getMCPManager();
    try {
      await mcpManager.startServer(name);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('mcp:stop-server', async (event, name: string) => {
    if (!isTrustedSender(event)) {
      console.warn('[IPC] Blocked mcp:stop-server from untrusted sender');
      return { success: false, error: 'Untrusted sender origin' };
    }
    const mcpManager = getMCPManager();
    try {
      await mcpManager.stopServer(name);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('mcp:restart-server', async (event, name: string) => {
    if (!isTrustedSender(event)) {
      console.warn('[IPC] Blocked mcp:restart-server from untrusted sender');
      return { success: false, error: 'Untrusted sender origin' };
    }
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

  ipcMain.handle('mcp:execute-tool', async (event, serverName: string, toolName: string, args: Record<string, unknown>) => {
    if (!isTrustedSender(event)) {
      console.warn('[IPC] Blocked mcp:execute-tool from untrusted sender');
      return { success: false, error: 'Untrusted sender origin' };
    }
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

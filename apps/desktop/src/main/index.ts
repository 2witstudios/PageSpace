import { app, BrowserWindow } from 'electron';
import type { Event } from 'electron';
import { getMCPManager } from './mcp-manager';
import { initializeWSClient, shutdownWSClient } from './ws-client';
import { logger } from './logger';
import { preloadAuthSession } from './auth-session';
import { setupMediaPermissionHandlers } from './media-permissions';
import { createWindow, mainWindow } from './window';
import { createMenu } from './menu';
import { createTray } from './tray';
import { setupPowerMonitor } from './power-monitor';
import { setupProtocolClient, handleDeepLink } from './deep-links';
import { registerIPCHandlers, setupMCPToolsReadyCallback } from './ipc-handlers';
import { startMCPStatusBroadcasting, stopMCPStatusBroadcasting } from './mcp-status';
import { setIsQuitting } from './state';

setupProtocolClient();

registerIPCHandlers();

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event: Event, commandLine: string[]) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();

      const url = commandLine.find((arg: string) => arg.startsWith('pagespace://'));
      if (url) {
        handleDeepLink(url);
      }
    }
  });
}

app.whenReady().then(async () => {
  await preloadAuthSession();

  setupMediaPermissionHandlers();

  try {
    const mcpManager = getMCPManager();
    await mcpManager.initialize();
    logger.info('MCP Manager initialized successfully', {});

    setupMCPToolsReadyCallback();

    startMCPStatusBroadcasting();
  } catch (error) {
    logger.error('Failed to initialize MCP Manager', { error });
  }

  createWindow();
  createMenu();
  createTray();

  setupPowerMonitor();

  initializeWSClient();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      initializeWSClient();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  setIsQuitting(true);

  stopMCPStatusBroadcasting();

  try {
    shutdownWSClient();
  } catch (error) {
    logger.error('Error shutting down WebSocket client', { error });
  }

  try {
    const mcpManager = getMCPManager();
    await mcpManager.shutdown();
  } catch (error) {
    logger.error('Error shutting down MCP servers', { error });
  }
});

app.on('open-url', (event: Event, url: string) => {
  event.preventDefault();
  handleDeepLink(url);
});

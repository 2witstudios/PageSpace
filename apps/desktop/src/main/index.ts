import { app, BrowserWindow, Menu, shell, ipcMain, Tray, nativeImage, dialog, session, safeStorage } from 'electron';
import electronUpdaterPkg from 'electron-updater';
const { autoUpdater } = electronUpdaterPkg;
import * as path from 'path';
import { promises as fs } from 'node:fs';
import Store from 'electron-store';
import { getMCPManager } from './mcp-manager';
import { initializeWSClient, shutdownWSClient, getWSClient } from './ws-client';
import type { MCPConfig } from '../shared/mcp-types';
import { logger } from './logger';
import { machineIdSync } from 'node-machine-id';
import * as os from 'node:os';

// Configuration store for user preferences
interface StoreSchema {
  windowBounds?: { width: number; height: number; x?: number; y?: number };
  appUrl?: string;
  minimizeToTray?: boolean;
}

const store = new Store<StoreSchema>({
  defaults: {
    windowBounds: { width: 1400, height: 900 },
    minimizeToTray: true,
  },
}) as any; // Type assertion to work around electron-store v10 type definitions

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false; // Track if app is quitting (used to distinguish close from minimize to tray)

interface StoredAuthSession {
  accessToken: string;
  refreshToken: string;
  csrfToken?: string | null;
  deviceToken?: string | null;
}

let authSessionPath: string | null = null;
let cachedMachineId: string | null = null;

function ensureAuthSessionPath(): string {
  if (!authSessionPath) {
    if (!app.isReady()) {
      throw new Error('Application not ready to resolve userData path');
    }
    authSessionPath = path.join(app.getPath('userData'), 'auth-session.bin');
  }
  return authSessionPath;
}

async function saveAuthSession(sessionData: StoredAuthSession): Promise<void> {
  try {
    const payload = JSON.stringify(sessionData);
    const encrypted = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(payload)
      : Buffer.from(payload, 'utf8');

    await fs.writeFile(ensureAuthSessionPath(), encrypted);
    logger.info('[Auth] Session stored securely', {});
  } catch (error) {
    logger.error('[Auth] Failed to persist session', { error });
    throw error;
  }
}

async function loadAuthSession(): Promise<StoredAuthSession | null> {
  try {
    const filePath = ensureAuthSessionPath();
    const raw = await fs.readFile(filePath);

    let decoded: string;
    if (safeStorage.isEncryptionAvailable()) {
      try {
        decoded = safeStorage.decryptString(raw);
      } catch (error) {
        logger.warn('[Auth] Failed to decrypt stored session, attempting plain text parse', { error });
        decoded = raw.toString('utf8');
      }
    } else {
      decoded = raw.toString('utf8');
    }

    return JSON.parse(decoded) as StoredAuthSession;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    logger.error('[Auth] Failed to load session', { error });
    return null;
  }
}

async function clearAuthSession(): Promise<void> {
  try {
    await fs.unlink(ensureAuthSessionPath());
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      logger.error('[Auth] Failed to clear stored session', { error });
    }
  }
}

function getMachineIdentifier(): string {
  if (cachedMachineId) {
    return cachedMachineId;
  }

  try {
    cachedMachineId = machineIdSync({ original: true });
  } catch (error) {
    logger.warn('[Auth] Failed to read machine identifier, falling back to hostname', { error });
    cachedMachineId = `${os.hostname()}-${process.platform}-${process.arch}`;
  }

  return cachedMachineId;
}

// Get the app URL based on environment
function getAppUrl(): string {
  // Allow user to override the URL
  const customUrl = store.get('appUrl');
  if (customUrl) {
    // Force HTTPS for non-localhost URLs (security requirement)
    let url = customUrl;
    if (!url.includes('localhost') && !url.includes('127.0.0.1')) {
      url = url.replace(/^http:/, 'https:');
    }
    return url;
  }

  // Default URLs based on environment
  // Desktop app loads directly to dashboard, skipping landing page
  let baseUrl: string;
  if (process.env.NODE_ENV === 'development') {
    baseUrl = process.env.PAGESPACE_URL || 'http://localhost:3000';
  } else {
    baseUrl = process.env.PAGESPACE_URL || 'https://pagespace.ai';
  }

  // Force HTTPS for non-localhost URLs (security requirement)
  if (!baseUrl.includes('localhost') && !baseUrl.includes('127.0.0.1')) {
    baseUrl = baseUrl.replace(/^http:/, 'https:');
  }

  return baseUrl + '/dashboard';
}

// Inject desktop-specific styles for titlebar and window dragging
function injectDesktopStyles(): void {
  if (!mainWindow) return;

  const css = `
    /* Make the top navbar/header draggable for window movement */
    /* Exclude sidebar navigation to prevent extra padding on left sidebar */
    header:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"]),
    nav:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"]),
    [role="banner"]:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"]),
    .navbar:not([class*="sidebar"]):not([class*="breadcrumb"]),
    .header:not([class*="sidebar"]):not([class*="breadcrumb"]) {
      -webkit-app-region: drag;
      padding-left: 80px !important; /* Space for traffic light buttons */
    }

    /* Make interactive elements non-draggable so they remain clickable */
    header a, header button, header input, header select, header textarea,
    nav a, nav button, nav input, nav select, nav textarea,
    [role="banner"] a, [role="banner"] button, [role="banner"] input,
    .navbar a, .navbar button, .navbar input, .navbar select,
    .header a, .header button, .header input, .header select {
      -webkit-app-region: no-drag;
    }

    /* Ensure dropdown menus and interactive UI elements are clickable */
    [role="menu"], [role="dialog"], [role="listbox"],
    .dropdown, .menu, .popover, .modal {
      -webkit-app-region: no-drag;
    }

    /* Make sure all buttons and links remain interactive */
    button, a, input, select, textarea, [role="button"] {
      -webkit-app-region: no-drag;
    }
  `;

  mainWindow.webContents.insertCSS(css);
}

function createWindow(): void {
  // Get saved window bounds
  const windowBounds = store.get('windowBounds') || { width: 1400, height: 900 };

  // Create the browser window
  mainWindow = new BrowserWindow({
    width: windowBounds.width,
    height: windowBounds.height,
    x: windowBounds.x,
    y: windowBounds.y,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: false, // Don't show until ready
  });

  // Load the app URL
  const appUrl = getAppUrl();
  mainWindow.loadURL(appUrl);

  // Inject desktop-specific CSS when page loads
  mainWindow.webContents.on('did-finish-load', () => {
    injectDesktopStyles();
  });

  // Handle page load failures (e.g., offline, DNS errors)
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    // Only handle network-related errors (not server errors like 404, 500, etc.)
    // This prevents the offline screen from being too "finicky"
    const networkErrors = [
      -105, // ERR_NAME_NOT_RESOLVED (DNS lookup failed)
      -106, // ERR_INTERNET_DISCONNECTED (no internet connection)
      -109, // ERR_ADDRESS_UNREACHABLE (network changed/lost)
      -118, // ERR_CONNECTION_TIMED_OUT (connection timeout)
      -137, // ERR_NAME_RESOLUTION_FAILED (DNS resolution failed)
    ];

    if (networkErrors.includes(errorCode)) {
      console.log(`Network error (${errorCode}): ${errorDescription} for ${validatedURL}`);

      // Load offline page with the original URL as a query parameter
      const offlinePath = path.join(__dirname, '../../src/offline.html');
      const appUrl = getAppUrl();
      mainWindow?.loadFile(offlinePath, { hash: encodeURIComponent(appUrl) });
    }
    // For other errors (server errors, etc.), let the browser show its default error page
  });

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Save window bounds on resize/move
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Handle window close
  mainWindow.on('close', (event) => {
    if (store.get('minimizeToTray') && !isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Set up auto-updater
  if (process.env.NODE_ENV !== 'development') {
    setupAutoUpdater();
  }
}

function saveBounds(): void {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  store.set('windowBounds', bounds);
}

function createTray(): void {
  // Create system tray icon
  // You'll need to add icon files to assets/
  const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show PageSpace',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('PageSpace');
  tray.setContextMenu(contextMenu);

  // Show window on tray click
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      createWindow();
    }
  });
}

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'PageSpace',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            // Open preferences in the web app
            mainWindow?.webContents.send('open-preferences');
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
        { type: 'separator' },
        { role: 'window' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal('https://pagespace.ai');
          },
        },
        {
          label: 'Documentation',
          click: async () => {
            await shell.openExternal('https://pagespace.ai');
          },
        },
        { type: 'separator' },
        {
          label: 'Check for Updates...',
          click: () => {
            checkForUpdates();
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function setupAutoUpdater(): void {
  // Configure auto-updater for GitHub releases
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Check for updates on launch
  autoUpdater.checkForUpdatesAndNotify();

  // Check for updates every 4 hours (best practice - not too aggressive)
  const CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours in milliseconds
  setInterval(() => {
    autoUpdater.checkForUpdates();
  }, CHECK_INTERVAL);

  // Event: Update is available
  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `A new version (${info.version}) is available and is being downloaded.`,
      detail: 'You will be notified when the download is complete.',
      buttons: ['OK'],
    });
  });

  // Event: Update downloaded and ready to install
  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Ready',
        message: `Version ${info.version} has been downloaded and is ready to install.`,
        detail: 'The update will be installed the next time you restart PageSpace.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 1,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) {
          // User clicked "Restart Now"
          isQuitting = true;
          tray?.destroy();  // Destroy tray to ensure app actually quits
          autoUpdater.quitAndInstall(false, true);  // Force immediate quit and relaunch
        }
      });
  });

  // Event: Error occurred during update
  autoUpdater.on('error', (error) => {
    console.error('Auto-updater error:', error);
    // Only show error dialog if user manually triggered check
    // Background checks fail silently to avoid annoying users
  });

  // Event: Checking for updates
  autoUpdater.on('checking-for-update', () => {
    console.log('Checking for updates...');
  });

  // Event: No updates available
  autoUpdater.on('update-not-available', () => {
    console.log('No updates available');
  });
}

// Manual update check (triggered from menu)
function checkForUpdates(): void {
  autoUpdater
    .checkForUpdates()
    .then((result) => {
      if (!result || !result.updateInfo) {
        dialog.showMessageBox({
          type: 'info',
          title: 'No Updates',
          message: 'You are running the latest version of PageSpace.',
          buttons: ['OK'],
        });
        return;
      }

      const currentVersion = app.getVersion();
      const latestVersion = result.updateInfo.version;

      if (currentVersion === latestVersion) {
        dialog.showMessageBox({
          type: 'info',
          title: 'No Updates',
          message: 'You are running the latest version of PageSpace.',
          buttons: ['OK'],
        });
      }
    })
    .catch((error) => {
      console.error('Update check failed:', error);
      dialog.showMessageBox({
        type: 'error',
        title: 'Update Check Failed',
        message: 'Unable to check for updates. Please try again later.',
        detail: error.message || 'Unknown error occurred',
        buttons: ['OK'],
      });
    });
}

// IPC handlers
ipcMain.handle('get-app-url', () => getAppUrl());
ipcMain.handle('set-app-url', (_event, url: string) => {
  store.set('appUrl', url);
  return true;
});
ipcMain.handle('retry-connection', () => {
  // Reload the main app URL
  if (mainWindow) {
    const appUrl = getAppUrl();
    mainWindow.loadURL(appUrl);
  }
});

// Auth IPC handlers
/**
 * Retrieves the current access token from secure storage.
 * @returns JWT string or null if not authenticated
 */
ipcMain.handle('auth:get-jwt', async () => {
  const storedSession = await loadAuthSession();
  return storedSession?.accessToken ?? null;
});

ipcMain.handle('auth:get-session', async () => {
  return loadAuthSession();
});

ipcMain.handle('auth:store-session', async (_event, sessionData: StoredAuthSession) => {
  await saveAuthSession(sessionData);
  return { success: true };
});

/**
 * Clears authentication data from secure storage and cookies.
 * Called during logout to ensure clean state.
 */
ipcMain.handle('auth:clear-auth', async () => {
  try {
    await clearAuthSession();
    await session.defaultSession.clearStorageData({
      storages: ['cookies'],
    });
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

// MCP IPC handlers
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
  } catch (error: any) {
    logger.error('Failed to update config', { error });
    logger.error('Error message', { errorMessage: error.message });
    return { success: false, error: error.message };
  }
});

ipcMain.handle('mcp:start-server', async (_event, name: string) => {
  const mcpManager = getMCPManager();
  try {
    await mcpManager.startServer(name);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('mcp:stop-server', async (_event, name: string) => {
  const mcpManager = getMCPManager();
  try {
    await mcpManager.stopServer(name);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('mcp:restart-server', async (_event, name: string) => {
  const mcpManager = getMCPManager();
  try {
    await mcpManager.restartServer(name);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('mcp:get-server-statuses', async () => {
  const mcpManager = getMCPManager();
  return mcpManager.getServerStatuses();
});

// Broadcast status changes to all windows
function broadcastMCPStatusChange() {
  const mcpManager = getMCPManager();
  const statuses = mcpManager.getServerStatuses();

  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('mcp:status-changed', statuses);
  });
}

// Poll MCP status and broadcast changes
let mcpStatusInterval: NodeJS.Timeout | null = null;

function startMCPStatusBroadcasting() {
  if (mcpStatusInterval) return;

  mcpStatusInterval = setInterval(() => {
    broadcastMCPStatusChange();
  }, 3000); // Poll every 3 seconds
}

function stopMCPStatusBroadcasting() {
  if (mcpStatusInterval) {
    clearInterval(mcpStatusInterval);
    mcpStatusInterval = null;
  }
}

// MCP Tools IPC handlers (for AI integration)
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

// WebSocket MCP Bridge IPC handlers
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

// App lifecycle
app.whenReady().then(async () => {
  authSessionPath = path.join(app.getPath('userData'), 'auth-session.bin');
  // Initialize MCP manager
  try {
    const mcpManager = getMCPManager();
    await mcpManager.initialize();
    logger.info('MCP Manager initialized successfully', {});

    // Start broadcasting status changes
    startMCPStatusBroadcasting();
  } catch (error) {
    logger.error('Failed to initialize MCP Manager', { error });
  }

  createWindow();
  createMenu();
  createTray();

  // Initialize WebSocket client for MCP bridge
  if (mainWindow) {
    initializeWSClient(mainWindow);
  }

  app.on('activate', () => {
    // On macOS, re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (mainWindow) {
        initializeWSClient(mainWindow);
      }
    }
  });
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  isQuitting = true;

  // Stop broadcasting status
  stopMCPStatusBroadcasting();

  // Shutdown WebSocket client
  try {
    shutdownWSClient();
  } catch (error) {
    logger.error('Error shutting down WebSocket client', { error });
  }

  // Shutdown MCP servers
  try {
    const mcpManager = getMCPManager();
    await mcpManager.shutdown();
  } catch (error) {
    logger.error('Error shutting down MCP servers', { error });
  }
});

// Handle deep links (pagespace://)
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('pagespace', process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient('pagespace');
}

// Handle the protocol on macOS
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (mainWindow) {
    mainWindow.webContents.send('deep-link', url);
  }
});

// Handle the protocol on Windows/Linux
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Someone tried to run a second instance
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();

      // Handle deep link on Windows/Linux
      const url = commandLine.find((arg) => arg.startsWith('pagespace://'));
      if (url) {
        mainWindow.webContents.send('deep-link', url);
      }
    }
  });
}

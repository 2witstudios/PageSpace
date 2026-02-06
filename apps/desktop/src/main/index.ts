import { app, BrowserWindow, Menu, shell, ipcMain, Tray, nativeImage, dialog, session, powerMonitor } from 'electron';
import electronUpdaterPkg from 'electron-updater';
const { autoUpdater } = electronUpdaterPkg;
import * as path from 'path';
import Store from 'electron-store';
import { getMCPManager } from './mcp-manager';
import { initializeWSClient, shutdownWSClient, getWSClient } from './ws-client';
import type { MCPConfig } from '../shared/mcp-types';
import { logger } from './logger';
import { loadAuthSession, saveAuthSession, clearAuthSession, type StoredAuthSession } from './auth-storage';
import nodeMachineId from 'node-machine-id';
const { machineIdSync } = nodeMachineId;
import * as os from 'node:os';

// Configuration store for user preferences
interface StoreSchema {
  windowBounds?: { width: number; height: number; x?: number; y?: number };
  appUrl?: string;
  minimizeToTray?: boolean;
}

const store = new Store<StoreSchema>({
  defaults: {
    windowBounds: { width: 1024, height: 700 },
    minimizeToTray: true,
  },
}) as any; // Type assertion to work around electron-store v10 type definitions

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false; // Track if app is quitting (used to distinguish close from minimize to tray)
let isSuspended = false; // Track system suspend state for auth refresh coordination
let suspendTime: number | null = null; // Track when system was suspended

let cachedMachineId: string | null = null;

function getMachineIdentifier(): string {
  if (cachedMachineId) {
    return cachedMachineId;
  }

  try {
    cachedMachineId = machineIdSync(true);
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

  // Only add traffic light padding on macOS where the buttons exist
  const isMacOS = process.platform === 'darwin';
  const trafficLightPadding = isMacOS ? 'padding-left: 80px !important; /* Space for traffic light buttons */' : '';

  const css = `
    /* Make the top navbar/header draggable for window movement */
    /* Exclude sidebar navigation to prevent extra padding on left sidebar */
    header:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"]),
    nav:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"]),
    [role="banner"]:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"]),
    .navbar:not([class*="sidebar"]):not([class*="breadcrumb"]),
    .header:not([class*="sidebar"]):not([class*="breadcrumb"]) {
      -webkit-app-region: drag;
      ${trafficLightPadding}
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

// Inject JavaScript for double-click to toggle maximize on title bar area
function injectDoubleClickHandler(): void {
  if (!mainWindow) return;

  const script = `
    (function() {
      // Avoid adding multiple listeners if page reloads
      if (window.__pagespaceDoubleClickHandlerInstalled) return;
      window.__pagespaceDoubleClickHandlerInstalled = true;

      // Draggable selectors (same as CSS)
      const draggableSelectors = [
        'header:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"])',
        'nav:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"])',
        '[role="banner"]:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"])',
        '.navbar:not([class*="sidebar"]):not([class*="breadcrumb"])',
        '.header:not([class*="sidebar"]):not([class*="breadcrumb"])'
      ];

      // Check if element or ancestor is draggable
      function isDraggableArea(element) {
        // First check if it's an interactive element (should not trigger maximize)
        const interactiveElements = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'];
        if (interactiveElements.includes(element.tagName)) return false;
        if (element.hasAttribute('role') && element.getAttribute('role') === 'button') return false;

        // Check if element or ancestor matches draggable selectors
        for (const selector of draggableSelectors) {
          try {
            if (element.matches(selector) || element.closest(selector)) {
              return true;
            }
          } catch (e) {
            // Ignore invalid selector errors
          }
        }
        return false;
      }

      document.addEventListener('dblclick', function(e) {
        if (isDraggableArea(e.target) && window.electron && window.electron.window) {
          window.electron.window.toggleMaximize();
        }
      });
    })();
  `;

  mainWindow.webContents.executeJavaScript(script);
}

function createWindow(): void {
  // Get saved window bounds
  const windowBounds = store.get('windowBounds') || { width: 1024, height: 700 };

  // Create the browser window
  // Center window if no saved position exists
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: windowBounds.width,
    height: windowBounds.height,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // Prevent Chromium from throttling timers/rAF when window is hidden during startup
    },
    show: false, // Don't show until ready
  };

  // Only set position if saved bounds exist (otherwise let Electron center it)
  if (windowBounds.x !== undefined && windowBounds.y !== undefined) {
    windowOptions.x = windowBounds.x;
    windowOptions.y = windowBounds.y;
  } else {
    windowOptions.center = true;
  }

  mainWindow = new BrowserWindow(windowOptions);

  // Load the app URL
  const appUrl = getAppUrl();
  mainWindow.loadURL(appUrl);

  // Inject desktop-specific CSS and JavaScript when page loads
  mainWindow.webContents.on('did-finish-load', () => {
    injectDesktopStyles();
    injectDoubleClickHandler();
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
    // Re-enable background throttling now that the initial render is complete.
    // This was disabled during startup to prevent Chromium from throttling timers/rAF.
    mainWindow?.webContents.setBackgroundThrottling(true);
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

// Window control IPC handlers
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

// Auth IPC handlers
/**
 * Retrieves the current session token from secure storage.
 * @returns Session token string (ps_sess_*) or null if not authenticated
 */
ipcMain.handle('auth:get-session-token', async () => {
  const storedSession = await loadAuthSession();
  return storedSession?.sessionToken ?? null;
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

    // Notify renderer to clear session cache and auth state
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

// Power state IPC handlers
ipcMain.handle('power:get-state', () => {
  return {
    isSuspended,
    suspendTime,
    systemIdleTime: powerMonitor.getSystemIdleTime(),
  };
});

/**
 * Setup power monitor to handle system sleep/wake events
 * This prevents auth failures during sleep and ensures proper token refresh on wake
 */
function setupPowerMonitor(): void {
  // System is about to suspend (sleep/hibernate)
  powerMonitor.on('suspend', () => {
    isSuspended = true;
    suspendTime = Date.now();
    logger.info('[Power] System suspending - pausing auth refresh');

    // Notify renderer to pause token refresh timers
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power:suspend', { suspendTime });
    }
  });

  // System has resumed from suspend
  powerMonitor.on('resume', () => {
    const resumeTime = Date.now();
    const sleepDuration = suspendTime ? resumeTime - suspendTime : 0;

    logger.info('[Power] System resumed', {
      sleepDurationMs: sleepDuration,
      sleepDurationMin: Math.round(sleepDuration / 60000),
    });

    isSuspended = false;

    // Notify renderer to resume auth and force token refresh
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power:resume', {
        resumeTime,
        sleepDuration,
        // Force refresh if slept for more than 5 minutes
        forceRefresh: sleepDuration > 5 * 60 * 1000,
      });
    }

    suspendTime = null;
  });

  // Screen is locked (user stepped away)
  powerMonitor.on('lock-screen', () => {
    logger.debug('[Power] Screen locked');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power:lock-screen');
    }
  });

  // Screen is unlocked (user returned)
  powerMonitor.on('unlock-screen', () => {
    logger.debug('[Power] Screen unlocked');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power:unlock-screen', {
        // Trigger a soft refresh on unlock to ensure fresh data
        shouldRefresh: true,
      });
    }
  });

  // System is on AC power (plugged in)
  powerMonitor.on('on-ac', () => {
    logger.debug('[Power] On AC power');
  });

  // System is on battery power
  powerMonitor.on('on-battery', () => {
    logger.debug('[Power] On battery power');
  });

  // Thermal state changed (macOS only) - may throttle network
  if (process.platform === 'darwin') {
    powerMonitor.on('thermal-state-change', (details) => {
      logger.debug('[Power] Thermal state changed', { state: details.state });
    });
  }

  logger.info('[Power] Power monitor initialized');
}

// App lifecycle
app.whenReady().then(async () => {
  // Initialize MCP manager
  try {
    const mcpManager = getMCPManager();
    await mcpManager.initialize();
    logger.info('MCP Manager initialized successfully', {});

    // Register callback for immediate broadcast when tools become ready
    // This ensures renderer gets notified as soon as tools are available,
    // without waiting for the 3-second polling interval
    mcpManager.setOnToolsReady((serverName) => {
      logger.debug('Tools ready callback triggered', { serverName });
      broadcastMCPStatusChange();
    });

    // Start broadcasting status changes
    startMCPStatusBroadcasting();
  } catch (error) {
    logger.error('Failed to initialize MCP Manager', { error });
  }

  createWindow();
  createMenu();
  createTray();

  // Initialize power monitor for sleep/wake handling
  setupPowerMonitor();

  // Initialize WebSocket client for MCP bridge
  initializeWSClient();

  app.on('activate', () => {
    // On macOS, re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      initializeWSClient();
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

/**
 * Handle OAuth auth-exchange deep links securely.
 *
 * Flow:
 * 1. OAuth callback redirects to pagespace://auth-exchange?code=<code>
 * 2. This function POSTs the code to /api/auth/desktop/exchange
 * 3. Server returns tokens in response body (not in URL - secure)
 * 4. Tokens are stored in OS keychain via safeStorage
 *
 * Security: Tokens never appear in URLs, logs, or browser history.
 */
async function handleAuthExchange(url: string): Promise<boolean> {
  try {
    const urlObj = new URL(url);

    // Only handle auth-exchange deep links
    if (urlObj.host !== 'auth-exchange') {
      return false;
    }

    const code = urlObj.searchParams.get('code');
    const provider = urlObj.searchParams.get('provider') || 'unknown';
    const isNewUser = urlObj.searchParams.get('isNewUser') === 'true';

    if (!code) {
      logger.error('[Auth Exchange] Missing code in deep link');
      mainWindow?.webContents.send('auth-error', { error: 'Missing exchange code' });
      return true; // Handled, but with error
    }

    logger.info('[Auth Exchange] Processing OAuth exchange', { provider });

    // Get base URL for API call
    const baseUrl = getAppUrl().replace('/dashboard', '');

    // Exchange code for tokens via secure POST request with 30s timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/auth/desktop/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        logger.error('[Auth Exchange] Request timed out');
        mainWindow?.webContents.send('auth-error', {
          error: 'Authentication request timed out',
        });
        return true;
      }
      throw fetchError; // Re-throw for outer catch
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Exchange failed' })) as { error?: string };
      logger.error('[Auth Exchange] Exchange failed', {
        status: response.status,
        error: errorData.error,
      });
      mainWindow?.webContents.send('auth-error', {
        error: errorData.error || 'Failed to complete authentication',
      });
      return true;
    }

    const tokens = await response.json() as Partial<{
      sessionToken: string;
      csrfToken: string;
      deviceToken: string;
    }> | null;

    // Validate required fields are non-empty strings
    if (
      typeof tokens?.sessionToken !== 'string' || !tokens.sessionToken ||
      typeof tokens?.csrfToken !== 'string' || !tokens.csrfToken ||
      typeof tokens?.deviceToken !== 'string' || !tokens.deviceToken
    ) {
      logger.error('[Auth Exchange] Invalid token response', {
        hasSessionToken: !!tokens?.sessionToken,
        hasCsrfToken: !!tokens?.csrfToken,
        hasDeviceToken: !!tokens?.deviceToken,
      });
      mainWindow?.webContents.send('auth-error', {
        error: 'Invalid authentication response from server',
      });
      return true;
    }

    // Store tokens securely in OS keychain (validated above)
    await saveAuthSession({
      sessionToken: tokens.sessionToken,
      csrfToken: tokens.csrfToken,
      deviceToken: tokens.deviceToken,
    });

    // Propagate the session cookie into the BrowserWindow's cookie jar.
    // The exchange endpoint returns Set-Cookie, but main-process fetch doesn't
    // share cookies with the renderer session. Without this, the Next.js
    // middleware (which checks for a session cookie on page routes) would
    // redirect /dashboard to /auth/signin after OAuth exchange.
    const appUrl = new URL(getAppUrl());
    try {
      await session.defaultSession.cookies.set({
        url: appUrl.origin,
        name: 'session',
        value: tokens.sessionToken,
        path: '/',
        httpOnly: true,
        secure: !appUrl.origin.includes('localhost'),
        sameSite: 'strict' as const,
        expirationDate: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days
      });
    } catch (cookieError) {
      // Non-fatal: the auth hook will recover via device refresh, but the
      // initial page load may flash the signin page briefly.
      logger.warn('[Auth Exchange] Failed to set session cookie in BrowserWindow', { cookieError });
    }

    logger.info('[Auth Exchange] OAuth exchange successful', { provider });

    // Navigate to dashboard with auth=success query param
    // This allows the web auth hook to detect OAuth success and force session reload,
    // bypassing any authFailedPermanently flag that may have been set.
    // Note: We don't send auth-success IPC event here because the current renderer
    // is about to be destroyed by loadURL - the event would be lost in the race condition.
    // The ?auth=success param is the reliable way to communicate OAuth success across page loads.
    const dashboardUrl = new URL(getAppUrl());
    dashboardUrl.searchParams.set('auth', 'success');
    if (isNewUser) {
      dashboardUrl.searchParams.set('isNewUser', 'true');
    }
    mainWindow?.loadURL(dashboardUrl.toString());

    return true;
  } catch (error) {
    logger.error('[Auth Exchange] Unexpected error', { error });
    mainWindow?.webContents.send('auth-error', {
      error: 'Authentication failed unexpectedly',
    });
    return true;
  }
}

/**
 * Process a deep link URL, routing to appropriate handler.
 */
async function handleDeepLink(url: string): Promise<void> {
  // Try auth exchange first (secure OAuth flow)
  const handled = await handleAuthExchange(url);
  if (handled) {
    return;
  }

  // Forward other deep links to renderer
  if (mainWindow) {
    mainWindow.webContents.send('deep-link', url);
  }
}

// Handle the protocol on macOS
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
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
        handleDeepLink(url);
      }
    }
  });
}

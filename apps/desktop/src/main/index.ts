import { app, BrowserWindow, Menu, shell, ipcMain, Tray, nativeImage, dialog } from 'electron';
import electronUpdaterPkg from 'electron-updater';
const { autoUpdater } = electronUpdaterPkg;
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Store from 'electron-store';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// Get the app URL based on environment
function getAppUrl(): string {
  // Allow user to override the URL
  const customUrl = store.get('appUrl');
  if (customUrl) return customUrl;

  // Default URLs based on environment
  // Desktop app loads directly to dashboard, skipping landing page
  if (process.env.NODE_ENV === 'development') {
    return (process.env.PAGESPACE_URL || 'http://localhost:3000') + '/dashboard';
  }

  // Production URL - PageSpace cloud instance
  return (process.env.PAGESPACE_URL || 'https://pagespace.ai') + '/dashboard';
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
          autoUpdater.quitAndInstall();
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

// App lifecycle
app.whenReady().then(() => {
  createWindow();
  createMenu();
  createTray();

  app.on('activate', () => {
    // On macOS, re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
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

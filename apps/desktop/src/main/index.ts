import { app, BrowserWindow, Menu, shell, ipcMain, Tray, nativeImage } from 'electron';
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
  if (process.env.NODE_ENV === 'development') {
    return process.env.PAGESPACE_URL || 'http://localhost:3000';
  }

  // Production URL - PageSpace cloud instance
  return process.env.PAGESPACE_URL || 'https://pagespace.ai';
}

// Inject desktop-specific styles for titlebar and window dragging
function injectDesktopStyles(): void {
  if (!mainWindow) return;

  const css = `
    /* Make the top navbar/header draggable for window movement */
    header, nav, [role="banner"], .navbar, .header {
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
            await shell.openExternal('https://pagespace.com');
          },
        },
        {
          label: 'Documentation',
          click: async () => {
            await shell.openExternal('https://docs.pagespace.com');
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function setupAutoUpdater(): void {
  // Configure auto-updater
  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on('update-available', () => {
    console.log('Update available');
  });

  autoUpdater.on('update-downloaded', () => {
    console.log('Update downloaded');
    // You can show a notification here
  });
}

// IPC handlers
ipcMain.handle('get-app-url', () => getAppUrl());
ipcMain.handle('set-app-url', (_event, url: string) => {
  store.set('appUrl', url);
  return true;
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

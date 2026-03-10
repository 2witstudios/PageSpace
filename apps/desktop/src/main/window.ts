import { BrowserWindow, shell } from 'electron';
import * as path from 'path';
import { store } from './store';
import { getAppUrl } from './app-url';
import { mainWindow, setMainWindow, isQuitting } from './state';
import { injectDesktopStyles, injectDoubleClickHandler } from './window-injections';
import { setupAutoUpdater } from './updater';

const storeAny = store as any;

function saveBounds(): void {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  storeAny.set('windowBounds', bounds);
}

export function createWindow(): void {
  const windowBounds = storeAny.get('windowBounds') || { width: 1024, height: 700 };

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
      backgroundThrottling: false,
    },
    show: false,
  };

  if (windowBounds.x !== undefined && windowBounds.y !== undefined) {
    windowOptions.x = windowBounds.x;
    windowOptions.y = windowBounds.y;
  } else {
    windowOptions.center = true;
  }

  const window = new BrowserWindow(windowOptions);
  setMainWindow(window);

  const appUrl = getAppUrl();
  window.loadURL(appUrl);

  window.webContents.on('did-finish-load', () => {
    injectDesktopStyles();
    injectDoubleClickHandler();
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    const networkErrors = [
      -105,
      -106,
      -109,
      -118,
      -137,
    ];

    if (networkErrors.includes(errorCode)) {
      console.log(`Network error (${errorCode}): ${errorDescription} for ${validatedURL}`);

      const offlinePath = path.join(__dirname, '../../src/offline.html');
      const appUrl = getAppUrl();
      window.loadFile(offlinePath, { hash: encodeURIComponent(appUrl) });
    }
  });

  window.once('ready-to-show', () => {
    window.show();
    window.webContents.setBackgroundThrottling(true);
  });

  window.on('resize', saveBounds);
  window.on('move', saveBounds);

  window.on('close', (event) => {
    if (storeAny.get('minimizeToTray') && !isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });

  window.on('closed', () => {
    setMainWindow(null);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  if (process.env.NODE_ENV !== 'development') {
    setupAutoUpdater();
  }
}

export function reloadMainWindow(): void {
  if (mainWindow) {
    const appUrl = getAppUrl();
    mainWindow.loadURL(appUrl);
  }
}

export { mainWindow };

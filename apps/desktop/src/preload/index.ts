import { contextBridge, ipcRenderer } from 'electron';

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

  // Platform information
  platform: process.platform,

  // App version
  version: process.env.npm_package_version || '1.0.0',
});

// Type definitions for the exposed API
export interface ElectronAPI {
  getAppUrl: () => Promise<string>;
  setAppUrl: (url: string) => Promise<boolean>;
  onDeepLink: (callback: (url: string) => void) => void;
  onOpenPreferences: (callback: () => void) => void;
  platform: NodeJS.Platform;
  version: string;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

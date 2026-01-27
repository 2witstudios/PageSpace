/**
 * iOS Bridge Test Setup
 *
 * Provides mocks for all Capacitor plugins and native bridge functionality.
 * These mocks ensure tests can run in a JSDOM environment without native code.
 */

import { vi, beforeEach, afterEach } from 'vitest';

// Store for mocked Preferences data
export const mockPreferencesStore = new Map<string, string>();

// Store for mocked Keychain data
export const mockKeychainStore = new Map<string, string>();

// Mock PageSpaceKeychain plugin
vi.mock('../keychain-plugin', () => ({
  PageSpaceKeychain: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: mockKeychainStore.get(key) ?? null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      mockKeychainStore.set(key, value);
      return { success: true };
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      mockKeychainStore.delete(key);
      return { success: true };
    }),
  },
}));

// Mock @capacitor/preferences
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: mockPreferencesStore.get(key) ?? null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      mockPreferencesStore.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      mockPreferencesStore.delete(key);
    }),
  },
}));

// Mock @capacitor/app
export const mockAppListeners = new Map<string, Function[]>();

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((event: string, callback: Function) => {
      const listeners = mockAppListeners.get(event) || [];
      listeners.push(callback);
      mockAppListeners.set(event, listeners);
      return Promise.resolve({ remove: vi.fn() });
    }),
    removeAllListeners: vi.fn(async () => {
      mockAppListeners.clear();
    }),
  },
}));

// Mock @capacitor/splash-screen
export const mockSplashScreen = {
  hide: vi.fn(async () => {}),
  show: vi.fn(async () => {}),
};

vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: mockSplashScreen,
}));

// Mock @capacitor/status-bar
export const mockStatusBar = {
  setStyle: vi.fn(async () => {}),
  setBackgroundColor: vi.fn(async () => {}),
  show: vi.fn(async () => {}),
  hide: vi.fn(async () => {}),
};

vi.mock('@capacitor/status-bar', () => ({
  StatusBar: mockStatusBar,
  Style: {
    Light: 'LIGHT',
    Dark: 'DARK',
    Default: 'DEFAULT',
  },
}));

// Mock @capacitor/keyboard
export const mockKeyboardListeners = new Map<string, Function[]>();
export const mockKeyboard = {
  addListener: vi.fn(async (event: string, callback: Function) => {
    const listeners = mockKeyboardListeners.get(event) || [];
    listeners.push(callback);
    mockKeyboardListeners.set(event, listeners);
    return {
      remove: vi.fn(async () => {
        const current = mockKeyboardListeners.get(event) || [];
        const index = current.indexOf(callback);
        if (index > -1) current.splice(index, 1);
        mockKeyboardListeners.set(event, current);
      }),
    };
  }),
  removeAllListeners: vi.fn(async () => {
    mockKeyboardListeners.clear();
  }),
};

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: mockKeyboard,
}));

// Mock @capacitor/core
vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn((name: string) => {
    if (name === 'PageSpaceKeychain') {
      return {
        get: vi.fn(),
        set: vi.fn(),
        remove: vi.fn(),
      };
    }
    return {};
  }),
  Capacitor: {
    isNativePlatform: vi.fn(() => true),
    getPlatform: vi.fn(() => 'ios'),
  },
}));

// Mock @capacitor/browser
vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    removeAllListeners: vi.fn(async () => {}),
  },
}));

// Mock crypto.randomUUID
const mockRandomUUID = vi.fn(() => 'mock-uuid-12345678-1234-1234-1234-123456789012');
Object.defineProperty(globalThis, 'crypto', {
  value: {
    randomUUID: mockRandomUUID,
    getRandomValues: vi.fn((arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = Math.floor(Math.random() * 256);
      }
      return arr;
    }),
  },
  configurable: true,
});

// Mock window.location
const mockLocation = {
  href: 'http://localhost:3000',
  origin: 'http://localhost:3000',
  pathname: '/',
  search: '',
  hash: '',
  assign: vi.fn(),
  replace: vi.fn(),
  reload: vi.fn(),
};

Object.defineProperty(window, 'location', {
  value: mockLocation,
  writable: true,
  configurable: true,
});

// Mock fetch
export const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Mock console methods for cleaner test output
// Store original console methods
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
};

// Create mock functions
export const consoleSpy = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

// Replace console methods with mocks
console.log = consoleSpy.log;
console.warn = consoleSpy.warn;
console.error = consoleSpy.error;
console.info = consoleSpy.info;

// Cleanup before each test
beforeEach(() => {
  vi.clearAllMocks();
  mockPreferencesStore.clear();
  mockKeychainStore.clear();
  mockAppListeners.clear();
  mockKeyboardListeners.clear();
  mockFetch.mockReset();
  mockLocation.href = 'http://localhost:3000';
  mockLocation.pathname = '/';

  // Reset console spies
  consoleSpy.log.mockClear();
  consoleSpy.warn.mockClear();
  consoleSpy.error.mockClear();
  consoleSpy.info.mockClear();

  // Reset document state
  document.documentElement.className = '';
  document.body.className = '';
  document.body.style.cssText = '';
});

afterEach(() => {
  // Don't restore mocks - keep console mocks active
});

// Restore original console on process exit (cleanup)
if (typeof process !== 'undefined') {
  process.on('exit', () => {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.info = originalConsole.info;
  });
}

// Helper to simulate deep link events
export function simulateDeepLink(url: string) {
  const listeners = mockAppListeners.get('appUrlOpen') || [];
  listeners.forEach((listener) => listener({ url }));
}

// Helper to simulate keyboard events
export function simulateKeyboardShow(keyboardHeight: number) {
  const listeners = mockKeyboardListeners.get('keyboardWillShow') || [];
  listeners.forEach((listener) => listener({ keyboardHeight }));
}

export function simulateKeyboardHide() {
  const listeners = mockKeyboardListeners.get('keyboardWillHide') || [];
  listeners.forEach((listener) => listener());
}

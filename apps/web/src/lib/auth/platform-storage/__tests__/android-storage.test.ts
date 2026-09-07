/**
 * Android secure storage tests.
 *
 * Covers the four requirements of the Android storage wiring leaf:
 * - the factory resolves AndroidStorage on Android instead of WebStorage
 * - AndroidStorage drives the existing `PageSpaceKeychain` binding rather than
 *   a second registered plugin name
 * - a plugin rejection (what the Java plugin does when
 *   EncryptedSharedPreferences failed to initialize) surfaces as an error
 *   instead of a silent no-op
 * - the device id round-trips through `@capacitor/preferences` under the exact
 *   key iOS uses, asserted by driving both implementations against one store
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const keychainMock = {
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
};

vi.mock('@/lib/keychain-plugin', () => ({
  PageSpaceKeychain: keychainMock,
}));

/** In-memory stand-in for @capacitor/preferences, shared by both platforms. */
const preferencesStore = new Map<string, string>();
const preferencesMock = {
  get: vi.fn(async ({ key }: { key: string }) => ({
    value: preferencesStore.get(key) ?? null,
  })),
  set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
    preferencesStore.set(key, value);
  }),
};

vi.mock('@capacitor/preferences', () => ({ Preferences: preferencesMock }));

interface MockCapacitor {
  isNativePlatform: () => boolean;
  getPlatform: () => string;
}

function setPlatform(platform: 'ios' | 'android' | null): void {
  if (platform === null) {
    delete (window as Window & { Capacitor?: MockCapacitor }).Capacitor;
    return;
  }
  (window as Window & { Capacitor?: MockCapacitor }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
  };
}

/**
 * The plugin's own failure mode: `call.reject(...)` becomes a rejected promise
 * on the JS side. This is the string the Java plugin builds when
 * `EncryptedSharedPreferences.create()` threw during `load()`
 * (PageSpaceSecureStoragePlugin.java:46-49, :52-58).
 */
const INIT_FAILURE = 'Secure storage unavailable: keystore unavailable';

async function importAndroidStorage() {
  const { AndroidStorage } = await import('../android-storage');
  return new AndroidStorage();
}

describe('AndroidStorage', () => {
  beforeEach(() => {
    vi.resetModules();
    keychainMock.get.mockReset();
    keychainMock.set.mockReset();
    keychainMock.remove.mockReset();
    preferencesStore.clear();
    preferencesMock.get.mockClear();
    preferencesMock.set.mockClear();
    setPlatform('android');
  });

  afterEach(() => {
    setPlatform(null);
    vi.restoreAllMocks();
  });

  describe('platform-storage factory', () => {
    it('resolves AndroidStorage when running on Android', async () => {
      const { getPlatformStorage } = await import('../index');

      expect(getPlatformStorage().platform).toBe('android');
    });

    it('still resolves IOSStorage when running on iOS', async () => {
      setPlatform('ios');
      const { getPlatformStorage } = await import('../index');

      expect(getPlatformStorage().platform).toBe('ios');
    });

    it('falls back to WebStorage in a plain browser tab', async () => {
      setPlatform(null);
      const { getPlatformStorage } = await import('../index');

      expect(getPlatformStorage().platform).toBe('web');
    });
  });

  describe('auth transport flags', () => {
    it('uses Bearer tokens and does not support CSRF, matching iOS', async () => {
      const storage = await importAndroidStorage();

      expect(storage.usesBearer()).toBe(true);
      expect(storage.supportsCSRF()).toBe(false);
    });
  });

  describe('storeSession', () => {
    const session = {
      sessionToken: 'session-token',
      csrfToken: null,
      deviceId: 'device-1',
      deviceToken: 'device-token',
    };

    it('writes the session through the existing PageSpaceKeychain binding', async () => {
      keychainMock.set.mockResolvedValue({ success: true });
      const storage = await importAndroidStorage();

      await storage.storeSession(session);

      expect(keychainMock.set).toHaveBeenCalledWith({
        key: 'pagespace_session',
        value: JSON.stringify(session),
      });
    });

    it('surfaces an EncryptedSharedPreferences init failure as an error', async () => {
      keychainMock.set.mockRejectedValue(new Error(INIT_FAILURE));
      const storage = await importAndroidStorage();

      await expect(storage.storeSession(session)).rejects.toThrow(INIT_FAILURE);
    });
  });

  describe('getStoredSession', () => {
    it('returns the parsed session', async () => {
      keychainMock.get.mockResolvedValue({
        value: JSON.stringify({
          sessionToken: 'session-token',
          deviceId: 'device-1',
          deviceToken: 'device-token',
        }),
      });
      const storage = await importAndroidStorage();

      expect(await storage.getStoredSession()).toEqual({
        sessionToken: 'session-token',
        csrfToken: null,
        deviceId: 'device-1',
        deviceToken: 'device-token',
      });
    });

    it('returns null when nothing is stored', async () => {
      keychainMock.get.mockResolvedValue({ value: null });
      const storage = await importAndroidStorage();

      expect(await storage.getStoredSession()).toBeNull();
    });

    it('returns null for a payload missing a session token', async () => {
      keychainMock.get.mockResolvedValue({
        value: JSON.stringify({ deviceId: 'device-1' }),
      });
      const storage = await importAndroidStorage();

      expect(await storage.getStoredSession()).toBeNull();
    });

    it('returns null for a corrupt payload', async () => {
      keychainMock.get.mockResolvedValue({ value: 'not json' });
      const storage = await importAndroidStorage();

      expect(await storage.getStoredSession()).toBeNull();
    });

    it('throws rather than reporting "no session" when the store is broken', async () => {
      keychainMock.get.mockRejectedValue(new Error(INIT_FAILURE));
      const storage = await importAndroidStorage();

      await expect(storage.getStoredSession()).rejects.toThrow(INIT_FAILURE);
    });

    it('returns just the token from getSessionToken', async () => {
      keychainMock.get.mockResolvedValue({
        value: JSON.stringify({ sessionToken: 'session-token', deviceId: 'device-1' }),
      });
      const storage = await importAndroidStorage();

      expect(await storage.getSessionToken()).toBe('session-token');
    });
  });

  describe('clearSession', () => {
    it('removes the session and dispatches auth:cleared', async () => {
      keychainMock.remove.mockResolvedValue({ success: true });
      const storage = await importAndroidStorage();
      const listener = vi.fn();
      window.addEventListener('auth:cleared', listener);

      await storage.clearSession();

      expect(keychainMock.remove).toHaveBeenCalledWith({ key: 'pagespace_session' });
      expect(listener).toHaveBeenCalled();
      window.removeEventListener('auth:cleared', listener);
    });

    it('still completes the logout when the store rejects', async () => {
      keychainMock.remove.mockRejectedValue(new Error(INIT_FAILURE));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const storage = await importAndroidStorage();
      const listener = vi.fn();
      window.addEventListener('auth:cleared', listener);

      await expect(storage.clearSession()).resolves.toBeUndefined();

      expect(listener).toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(INIT_FAILURE));
      window.removeEventListener('auth:cleared', listener);
    });
  });

  describe('getDeviceId', () => {
    it('persists a generated id under pagespace_device_id', async () => {
      const storage = await importAndroidStorage();

      const id = await storage.getDeviceId();

      expect(id).toMatch(/^[a-z0-9]+$/);
      expect(preferencesStore.get('pagespace_device_id')).toBe(id);
    });

    it('reuses the stored id on a second call', async () => {
      const storage = await importAndroidStorage();

      const first = await storage.getDeviceId();
      const second = await storage.getDeviceId();

      expect(second).toBe(first);
      expect(preferencesMock.set).toHaveBeenCalledTimes(1);
    });

    it('keeps one identity: iOS reads back the id Android wrote', async () => {
      const android = await importAndroidStorage();
      const { IOSStorage } = await import('../ios-storage');

      const androidId = await android.getDeviceId();
      const iosId = await new IOSStorage().getDeviceId();

      expect(iosId).toBe(androidId);
      expect(preferencesMock.set).toHaveBeenCalledTimes(1);
    });

    it('reports the device id through getDeviceInfo', async () => {
      const storage = await importAndroidStorage();

      const info = await storage.getDeviceInfo();

      expect(info.deviceId).toBe(preferencesStore.get('pagespace_device_id'));
      expect(info.userAgent).toBe(navigator.userAgent);
    });
  });
});

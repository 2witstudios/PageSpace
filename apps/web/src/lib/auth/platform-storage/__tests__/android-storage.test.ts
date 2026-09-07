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
    localStorage.clear();
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

    it('spends the legacy device token once the keychain holds the session', async () => {
      // One-way migration: leaving it would keep the legacy fallback (and the
      // legacy device-id branch) firing against a session that has moved.
      localStorage.setItem('deviceToken', 'legacy-device-token');
      keychainMock.set.mockResolvedValue({ success: true });
      const storage = await importAndroidStorage();

      await storage.storeSession(session);

      expect(localStorage.getItem('deviceToken')).toBeNull();
    });

    it('keeps the legacy token when the keychain write fails', async () => {
      localStorage.setItem('deviceToken', 'legacy-device-token');
      keychainMock.set.mockRejectedValue(new Error(INIT_FAILURE));
      const storage = await importAndroidStorage();

      await expect(storage.storeSession(session)).rejects.toThrow(INIT_FAILURE);

      expect(localStorage.getItem('deviceToken')).toBe('legacy-device-token');
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

    it('returns null when an optional field is the wrong shape', async () => {
      keychainMock.get.mockResolvedValue({
        value: JSON.stringify({
          sessionToken: 'session-token',
          deviceId: 'device-1',
          deviceToken: 42,
        }),
      });
      const storage = await importAndroidStorage();

      expect(await storage.getStoredSession()).toBeNull();
    });

    it('returns null for a corrupt payload', async () => {
      keychainMock.get.mockResolvedValue({ value: 'not json' });
      const storage = await importAndroidStorage();

      expect(await storage.getStoredSession()).toBeNull();
    });

    it('falls back to the device token the web sign-in flow left behind', async () => {
      // Until native sign-in lands, Android signs in through the web flow,
      // which writes only localStorage (useAuth.ts, PasskeyLoginButton.tsx).
      // Ignoring it would strand a valid token and force a re-auth on the
      // first cookie expiry.
      localStorage.setItem('deviceToken', 'legacy-device-token');
      localStorage.setItem('browser_device_id', 'legacy-device-id');
      keychainMock.get.mockResolvedValue({ value: null });
      const storage = await importAndroidStorage();

      expect(await storage.getStoredSession()).toEqual({
        sessionToken: '',
        csrfToken: null,
        deviceId: 'legacy-device-id',
        deviceToken: 'legacy-device-token',
      });
    });

    it('prefers the keychain session over the legacy one', async () => {
      localStorage.setItem('deviceToken', 'legacy-device-token');
      keychainMock.get.mockResolvedValue({
        value: JSON.stringify({
          sessionToken: 'session-token',
          deviceId: 'device-1',
          deviceToken: 'native-device-token',
        }),
      });
      const storage = await importAndroidStorage();

      expect((await storage.getStoredSession())?.deviceToken).toBe('native-device-token');
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

    it('clears the legacy device token too, so the fallback cannot resurrect it', async () => {
      localStorage.setItem('deviceToken', 'legacy-device-token');
      localStorage.setItem('browser_device_id', 'web_abc123');
      keychainMock.remove.mockResolvedValue({ success: true });
      keychainMock.get.mockResolvedValue({ value: null });
      const storage = await importAndroidStorage();

      await storage.clearSession();

      expect(localStorage.getItem('deviceToken')).toBeNull();
      expect(await storage.getStoredSession()).toBeNull();
      // Logout ends a session, not the device's identity.
      expect(localStorage.getItem('browser_device_id')).toBe('web_abc123');
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

    it('adopts the id bound to a live legacy device token', async () => {
      // /api/auth/device/refresh enforces strict binding — a deviceId that does
      // not match the one the token was issued against is answered 401 as a
      // stolen token. Every web sign-in path binds to browser_device_id.
      localStorage.setItem('deviceToken', 'legacy-device-token');
      localStorage.setItem('browser_device_id', 'web_abc123');
      const storage = await importAndroidStorage();

      expect(await storage.getDeviceId()).toBe('web_abc123');
      expect(preferencesStore.get('pagespace_device_id')).toBe('web_abc123');
    });

    it('lets the live binding outrank an id already in preferences', async () => {
      // A refresh attempt before sign-in mints a preferences id; reporting that
      // one against a token bound to browser_device_id is the guaranteed 401.
      preferencesStore.set('pagespace_device_id', 'minted-before-sign-in');
      localStorage.setItem('deviceToken', 'legacy-device-token');
      localStorage.setItem('browser_device_id', 'web_abc123');
      const storage = await importAndroidStorage();

      expect(await storage.getDeviceId()).toBe('web_abc123');
      expect(preferencesStore.get('pagespace_device_id')).toBe('web_abc123');
    });

    it('ignores a legacy id with no live token behind it', async () => {
      // No token means no binding to preserve, so the native store keeps the
      // repo's own id format rather than inheriting a browser fingerprint.
      localStorage.setItem('browser_device_id', 'web_abc123');
      const storage = await importAndroidStorage();

      expect(await storage.getDeviceId()).not.toBe('web_abc123');
    });

    it('gives concurrent callers one id and writes once', async () => {
      const storage = await importAndroidStorage();

      const ids = await Promise.all([
        storage.getDeviceId(),
        storage.getDeviceId(),
        storage.getDeviceId(),
      ]);

      expect(new Set(ids).size).toBe(1);
      expect(preferencesMock.set).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failed resolution', async () => {
      preferencesMock.get.mockRejectedValueOnce(new Error('preferences unavailable'));
      const storage = await importAndroidStorage();

      await expect(storage.getDeviceId()).rejects.toThrow('preferences unavailable');

      expect(await storage.getDeviceId()).toBe(preferencesStore.get('pagespace_device_id'));
    });

    it('reports the device id through getDeviceInfo', async () => {
      const storage = await importAndroidStorage();

      const info = await storage.getDeviceInfo();

      expect(info.deviceId).toBe(preferencesStore.get('pagespace_device_id'));
      expect(info.userAgent).toBe(navigator.userAgent);
    });
  });
});

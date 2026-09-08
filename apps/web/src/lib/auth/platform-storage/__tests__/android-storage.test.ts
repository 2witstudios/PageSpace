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
    // The real plugin always resolves an object; default to an empty store so a
    // test only has to say what it puts in the keychain, not that one exists.
    keychainMock.get.mockResolvedValue({ value: null });
    keychainMock.set.mockResolvedValue({ success: true });
    keychainMock.remove.mockResolvedValue({ success: true });
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

    it('keeps a bearer-less refresh out of the keychain and in the legacy store', async () => {
      // The device/refresh web branch — which is what an Android device
      // registered by the in-WebView web flow gets — sets a session cookie and
      // returns no sessionToken. Storing that shape would strand the device
      // token in a blob getStoredSession rejects.
      localStorage.setItem('deviceToken', 'old-device-token');
      const storage = await importAndroidStorage();

      await storage.storeSession({
        sessionToken: '',
        csrfToken: 'csrf',
        deviceId: 'web_abc123',
        deviceToken: 'rotated-device-token',
      });

      expect(keychainMock.set).not.toHaveBeenCalled();
      // A rotated token must land somewhere, or the next refresh is a 401.
      expect(localStorage.getItem('deviceToken')).toBe('rotated-device-token');
      expect(localStorage.getItem('browser_device_id')).toBe('web_abc123');
    });

    it('clears a keychain session the bearer-less refresh supersedes', async () => {
      // getStoredSession reads the keychain first, so a stale blob left here
      // would shadow the token just written to the legacy store.
      keychainMock.get.mockResolvedValue({
        value: JSON.stringify({
          sessionToken: 'stale',
          deviceId: 'web_abc123',
          deviceToken: 'stale-device-token',
        }),
      });
      const storage = await importAndroidStorage();

      await storage.storeSession({
        sessionToken: '',
        csrfToken: null,
        deviceId: 'web_abc123',
        deviceToken: 'rotated-device-token',
      });

      expect(keychainMock.remove).toHaveBeenCalledWith({ key: 'pagespace_session' });
    });

    it('keeps the superseded session when the legacy write fails', async () => {
      // Clearing first would destroy the old token to make room for one that
      // never landed. A stale session the next refresh corrects beats none.
      keychainMock.get.mockResolvedValue({
        value: JSON.stringify({
          sessionToken: 'stale',
          deviceId: 'web_abc123',
          deviceToken: 'stale-device-token',
        }),
      });
      const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
      const storage = await importAndroidStorage();

      await expect(
        storage.storeSession({
          sessionToken: '',
          csrfToken: null,
          deviceId: 'web_abc123',
          deviceToken: 'rotated-device-token',
        })
      ).rejects.toThrow('QuotaExceededError');

      expect(keychainMock.remove).not.toHaveBeenCalled();
      setItem.mockRestore();
    });

    it('does not fail a landed token write because the id write could not', async () => {
      // Reporting failure for a refresh that actually persisted sends the
      // caller back into the rate limiter for nothing.
      const real = Storage.prototype.setItem;
      const setItem = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(function (this: Storage, key: string, value: string) {
          if (key === 'browser_device_id') throw new Error('QuotaExceededError');
          real.call(this, key, value);
        });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const storage = await importAndroidStorage();

      await expect(
        storage.storeSession({
          sessionToken: '',
          csrfToken: null,
          deviceId: 'web_abc123',
          deviceToken: 'rotated-device-token',
        })
      ).resolves.toBeUndefined();

      expect(localStorage.getItem('deviceToken')).toBe('rotated-device-token');
      setItem.mockRestore();
    });

    it('does not overwrite a browser device id that already exists', async () => {
      // browser_device_id belongs to getOrCreateDeviceId and is what every web
      // sign-in binds its token to; overwriting it would make a divergence
      // permanent rather than record a missing identity.
      localStorage.setItem('deviceToken', 'legacy-device-token');
      localStorage.setItem('browser_device_id', 'web_abc123');
      const storage = await importAndroidStorage();

      await storage.storeSession({
        sessionToken: '',
        csrfToken: null,
        deviceId: 'a-minted-cuid',
        deviceToken: 'rotated-device-token',
      });

      expect(localStorage.getItem('browser_device_id')).toBe('web_abc123');
    });

    it('throws rather than reporting success with nothing to store', async () => {
      const storage = await importAndroidStorage();

      await expect(
        storage.storeSession({
          sessionToken: '',
          csrfToken: null,
          deviceId: 'web_abc123',
          deviceToken: null,
        })
      ).rejects.toThrow(/neither a bearer token nor a device token/);
    });

    it('still recovers the session after a bearer-less refresh', async () => {
      localStorage.setItem('deviceToken', 'old-device-token');
      keychainMock.get.mockResolvedValue({ value: null });
      const storage = await importAndroidStorage();

      await storage.storeSession({
        sessionToken: '',
        csrfToken: null,
        deviceId: 'web_abc123',
        deviceToken: 'rotated-device-token',
      });

      const recovered = await storage.getStoredSession();
      expect(recovered?.deviceToken).toBe('rotated-device-token');
      expect(await storage.getDeviceId()).toBe('web_abc123');
    });

    it('surfaces a failure to persist a rotated device token', async () => {
      // The legacy store is the only home for it; swallowing the failure leaves
      // the next refresh holding a token the server has rotated away.
      const setItem = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
          throw new Error('QuotaExceededError');
        });
      const storage = await importAndroidStorage();

      await expect(
        storage.storeSession({
          sessionToken: '',
          csrfToken: null,
          deviceId: 'web_abc123',
          deviceToken: 'rotated-device-token',
        })
      ).rejects.toThrow('QuotaExceededError');

      setItem.mockRestore();
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

    it('falls back to the legacy session when the stored bytes are unusable', async () => {
      // One rule for every kind of emptiness: absent, unparseable, wrong shape.
      localStorage.setItem('deviceToken', 'legacy-device-token');
      keychainMock.get.mockResolvedValue({ value: 'not json' });
      const storage = await importAndroidStorage();

      expect((await storage.getStoredSession())?.deviceToken).toBe('legacy-device-token');
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

    it('reports no bearer token for a legacy cookie session', async () => {
      localStorage.setItem('deviceToken', 'legacy-device-token');
      keychainMock.get.mockResolvedValue({ value: null });
      const storage = await importAndroidStorage();

      expect(await storage.getSessionToken()).toBeNull();
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

    it('forgets the revoked session id, so a later sign-in is not shadowed', async () => {
      keychainMock.get.mockResolvedValueOnce({
        value: JSON.stringify({
          sessionToken: 'session-token',
          deviceId: 'native-device-id',
          deviceToken: 'native-device-token',
        }),
      });
      const storage = await importAndroidStorage();
      await storage.getStoredSession();

      await storage.clearSession();

      // A fresh web sign-in, then a keystore that refuses: the answer must come
      // from the new binding, not the session logout just revoked.
      localStorage.setItem('deviceToken', 'new-device-token');
      localStorage.setItem('browser_device_id', 'web_abc123');
      keychainMock.get.mockRejectedValue(new Error(INIT_FAILURE));

      expect(await storage.getDeviceId()).toBe('web_abc123');
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

    it('reports the id the keychain session is bound to, not a legacy one', async () => {
      // Both stores can hold a session at once — a keychain session plus a
      // fresh in-WebView web sign-in. Sending the keychain's device token with
      // the legacy id is read by the refresh route as a stolen token.
      keychainMock.get.mockResolvedValue({
        value: JSON.stringify({
          sessionToken: 'session-token',
          deviceId: 'native-device-id',
          deviceToken: 'native-device-token',
        }),
      });
      localStorage.setItem('deviceToken', 'legacy-device-token');
      localStorage.setItem('browser_device_id', 'web_abc123');
      const storage = await importAndroidStorage();

      expect(await storage.getDeviceId()).toBe('native-device-id');
      expect((await storage.getStoredSession())?.deviceToken).toBe('native-device-token');
    });

    it('does not hang on a keychain read that never settles', async () => {
      // getDeviceInfo sits inside refreshBearerSession with no timeout of its
      // own, so a hung native call would leave the refresh pending forever.
      vi.useFakeTimers();
      preferencesStore.set('pagespace_device_id', 'preferences-id');
      keychainMock.get.mockReturnValue(new Promise(() => {}));
      const storage = await importAndroidStorage();

      const pending = storage.getDeviceId();
      await vi.advanceTimersByTimeAsync(3000);

      expect(await pending).toBe('preferences-id');
      vi.useRealTimers();
    });

    it('falls back to preferences when no store names a binding', async () => {
      preferencesStore.set('pagespace_device_id', 'preferences-id');
      keychainMock.get.mockRejectedValue(new Error(INIT_FAILURE));
      const storage = await importAndroidStorage();

      expect(await storage.getDeviceId()).toBe('preferences-id');
    });

    it('never answers with an empty id when the legacy session names none', async () => {
      // readLegacySession yields deviceId '' when a token was stored without an
      // id; `??` would let that through where the contract says string | null.
      preferencesStore.set('pagespace_device_id', 'preferences-id');
      localStorage.setItem('deviceToken', 'legacy-device-token');
      keychainMock.get.mockRejectedValue(new Error(INIT_FAILURE));
      const storage = await importAndroidStorage();

      expect(await storage.getDeviceId()).toBe('preferences-id');
    });

    it('still reports the legacy binding when the keychain refuses', async () => {
      // A keystore that refuses is no reason to report the *wrong* id: the
      // legacy binding needs no bridge to read, and answering with the
      // preferences id instead is the mismatch the refresh route rejects as a
      // stolen token.
      preferencesStore.set('pagespace_device_id', 'preferences-id');
      localStorage.setItem('deviceToken', 'legacy-device-token');
      localStorage.setItem('browser_device_id', 'web_abc123');
      keychainMock.get.mockRejectedValue(new Error(INIT_FAILURE));
      const storage = await importAndroidStorage();

      expect(await storage.getDeviceId()).toBe('web_abc123');
    });

    it('answers a timed-out read the way the successful one did', async () => {
      // refreshBearerSession reads the session, then asks for the id through a
      // second bridge call on the same budget. If the first lands and the
      // second times out, answering from the legacy store pairs the keychain's
      // token with the legacy id — read as a stolen token, 401, and
      // clearSession then destroys both credentials over a slow keystore.
      vi.useFakeTimers();
      localStorage.setItem('deviceToken', 'legacy-device-token');
      localStorage.setItem('browser_device_id', 'web_abc123');
      keychainMock.get.mockResolvedValueOnce({
        value: JSON.stringify({
          sessionToken: 'session-token',
          deviceId: 'native-device-id',
          deviceToken: 'native-device-token',
        }),
      });
      const storage = await importAndroidStorage();

      // Read 1 — the one auth-fetch makes for itself — succeeds.
      expect((await storage.getStoredSession())?.deviceId).toBe('native-device-id');

      // Read 2, inside getDeviceInfo, hangs.
      keychainMock.get.mockReturnValue(new Promise(() => {}));
      const pending = storage.getDeviceId();
      await vi.advanceTimersByTimeAsync(3000);

      expect(await pending).toBe('native-device-id');
      vi.useRealTimers();
    });

    it('takes the id from a write that supersedes what a read last saw', async () => {
      // The bearer-less branch removes the keychain session a read had just
      // recorded; without updating the record, a later failed read would answer
      // with an id belonging to a session that no longer exists.
      keychainMock.get.mockResolvedValueOnce({
        value: JSON.stringify({
          sessionToken: 'session-token',
          deviceId: 'native-device-id',
          deviceToken: 'native-device-token',
        }),
      });
      const storage = await importAndroidStorage();
      await storage.getStoredSession();

      await storage.storeSession({
        sessionToken: '',
        csrfToken: null,
        deviceId: 'web_abc123',
        deviceToken: 'rotated-device-token',
      });

      keychainMock.get.mockRejectedValue(new Error(INIT_FAILURE));
      expect(await storage.getDeviceId()).toBe('web_abc123');
    });

    it('remembers the binding in force, not the one it declined to write', async () => {
      // The bearer-less branch leaves an existing browser_device_id alone, so
      // the session's own deviceId is not necessarily what ends up binding.
      // A prior read seeds the record with a different id, so this fails both
      // when the branch records the wrong value and when it records nothing.
      keychainMock.get.mockResolvedValueOnce({
        value: JSON.stringify({
          sessionToken: 'session-token',
          deviceId: 'native-device-id',
          deviceToken: 'native-device-token',
        }),
      });
      localStorage.setItem('browser_device_id', 'web_abc123');
      const storage = await importAndroidStorage();
      await storage.getStoredSession();

      await storage.storeSession({
        sessionToken: '',
        csrfToken: null,
        deviceId: 'a-minted-cuid',
        deviceToken: 'rotated-device-token',
      });

      keychainMock.get.mockRejectedValue(new Error(INIT_FAILURE));
      expect(await storage.getDeviceId()).toBe('web_abc123');
    });

    it('does not publish a minted id on the strength of a read that never answered', async () => {
      // Rewriting the browser's identity to a CUID2 no server token is bound to
      // needs better evidence than a keychain call that hung.
      vi.useFakeTimers();
      localStorage.setItem('deviceToken', 'legacy-device-token');
      keychainMock.get.mockReturnValue(new Promise(() => {}));
      const storage = await importAndroidStorage();

      const pending = storage.getDeviceId();
      await vi.advanceTimersByTimeAsync(3000);
      await pending;

      expect(localStorage.getItem('browser_device_id')).toBeNull();
      vi.useRealTimers();
    });

    it('publishes a minted id where the server binding will look for it', async () => {
      // A live token with no id recorded: minting only into preferences would
      // leave the native and web identities permanently divergent, where
      // WebStorage mints straight into browser_device_id.
      localStorage.setItem('deviceToken', 'legacy-device-token');
      const storage = await importAndroidStorage();

      const id = await storage.getDeviceId();

      expect(localStorage.getItem('browser_device_id')).toBe(id);
    });

    it('still reports the legacy binding when the keychain hangs', async () => {
      vi.useFakeTimers();
      preferencesStore.set('pagespace_device_id', 'preferences-id');
      localStorage.setItem('deviceToken', 'legacy-device-token');
      localStorage.setItem('browser_device_id', 'web_abc123');
      keychainMock.get.mockReturnValue(new Promise(() => {}));
      const storage = await importAndroidStorage();

      const pending = storage.getDeviceId();
      await vi.advanceTimersByTimeAsync(3000);

      expect(await pending).toBe('web_abc123');
      vi.useRealTimers();
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

    it('sees a binding established after an earlier call', async () => {
      // The instance is a module-level singleton and a passkey sign-in happens
      // in-page, so memoizing the first answer would report a minted id against
      // a token bound to browser_device_id until the next reload.
      const storage = await importAndroidStorage();
      const minted = await storage.getDeviceId();

      localStorage.setItem('deviceToken', 'legacy-device-token');
      localStorage.setItem('browser_device_id', 'web_abc123');

      expect(await storage.getDeviceId()).toBe('web_abc123');
      expect(minted).not.toBe('web_abc123');
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

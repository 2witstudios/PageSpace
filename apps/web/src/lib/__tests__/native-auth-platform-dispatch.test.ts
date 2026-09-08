import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `ios-google-auth.ts` / `ios-apple-auth.ts` became `native-google-auth.ts` /
 * `native-apple-auth.ts`, dispatching on platform instead of testing for iOS.
 *
 * The two providers are deliberately asymmetric: Android has a native Google SDK
 * but no native Sign in with Apple — that flow goes through Apple's web one — so
 * `supportsNativeAuthProvider` answers per provider and the Apple path falls back
 * to web OAuth on Android rather than gaining an Android branch.
 */

const socialLogin = {
  initialize: vi.fn().mockResolvedValue(undefined),
  login: vi.fn(),
};
const preferences = {
  get: vi.fn().mockResolvedValue({ value: 'device-1' }),
  set: vi.fn().mockResolvedValue(undefined),
};
const keychain = {
  get: vi.fn(),
  set: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@capgo/capacitor-social-login', () => ({ SocialLogin: socialLogin }));
vi.mock('@capacitor/preferences', () => ({ Preferences: preferences }));
vi.mock('@/lib/keychain-plugin', () => ({ PageSpaceKeychain: keychain }));

/** Put the shared bridge on the platform under test. */
function setPlatform(platform: 'ios' | 'android' | 'web') {
  Object.defineProperty(global, 'window', {
    value: {
      Capacitor: {
        isNativePlatform: () => platform !== 'web',
        getPlatform: () => platform,
      },
    },
    writable: true,
    configurable: true,
  });
}

describe('native auth: platform dispatch', () => {
  let originalFetch: typeof global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    originalFetch = global.fetch;
    fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ sessionToken: 'ps_sess_new', csrfToken: 'c', deviceToken: 'ps_dev_new', user: { id: 'u1' } }),
        { status: 200 }
      )
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;
    socialLogin.login.mockResolvedValue({
      result: { responseType: 'online', idToken: 'google-id-token' },
    });
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID', 'ios-client-id');
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID', 'web-client-id');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  describe('availability follows the capability table, not a platform equality', () => {
    it('given Android, should report native Google sign-in available', async () => {
      setPlatform('android');
      const { isNativeGoogleAuthAvailable } = await import('../native-google-auth');
      expect(isNativeGoogleAuthAvailable()).toBe(true);
    });

    it('given Android, should report native Apple sign-in UNavailable so the caller falls back to web OAuth', async () => {
      setPlatform('android');
      const { isNativeAppleAuthAvailable } = await import('../native-apple-auth');
      expect(isNativeAppleAuthAvailable()).toBe(false);
    });

    it('given iOS, should report both providers available as before', async () => {
      setPlatform('ios');
      const { isNativeGoogleAuthAvailable } = await import('../native-google-auth');
      const { isNativeAppleAuthAvailable } = await import('../native-apple-auth');
      expect(isNativeGoogleAuthAvailable()).toBe(true);
      expect(isNativeAppleAuthAvailable()).toBe(true);
    });

    it('given a browser, should report neither provider available', async () => {
      setPlatform('web');
      const { isNativeGoogleAuthAvailable } = await import('../native-google-auth');
      const { isNativeAppleAuthAvailable } = await import('../native-apple-auth');
      expect(isNativeGoogleAuthAvailable()).toBe(false);
      expect(isNativeAppleAuthAvailable()).toBe(false);
    });
  });

  describe('Google sign-in on Android', () => {
    it('should initialize the SDK with the web client ID, which is what the Android SDK requires', async () => {
      setPlatform('android');
      const { signInWithGoogle } = await import('../native-google-auth');

      await signInWithGoogle();

      expect(socialLogin.initialize).toHaveBeenCalledWith({
        google: { webClientId: 'web-client-id' },
      });
    });

    it('should send the real platform, not a hardcoded ios', async () => {
      setPlatform('android');
      const { signInWithGoogle } = await import('../native-google-auth');

      await signInWithGoogle();

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/auth/google/native');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.platform).toBe('android');
      expect(body.deviceName).toBe('Android App');
    });

    it('given no web client ID configured, should refuse rather than initialize with nothing', async () => {
      setPlatform('android');
      vi.stubEnv('NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID', '');
      const { signInWithGoogle } = await import('../native-google-auth');

      const result = await signInWithGoogle();

      expect(result).toEqual({ success: false, error: 'Android Google Sign-In not configured' });
      expect(socialLogin.initialize).not.toHaveBeenCalled();
    });
  });

  describe('Google sign-in on iOS is unchanged by the rename', () => {
    it('should initialize with the iOS client ID and send platform ios', async () => {
      setPlatform('ios');
      const { signInWithGoogle } = await import('../native-google-auth');

      await signInWithGoogle();

      expect(socialLogin.initialize).toHaveBeenCalledWith({
        google: { iOSClientId: 'ios-client-id' },
      });
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.platform).toBe('ios');
      expect(body.deviceName).toBe('iOS App');
    });

    it('given no iOS client ID configured, should keep the existing refusal message', async () => {
      setPlatform('ios');
      vi.stubEnv('NEXT_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID', '');
      const { signInWithGoogle } = await import('../native-google-auth');

      const result = await signInWithGoogle();

      expect(result).toEqual({ success: false, error: 'iOS Google Sign-In not configured' });
    });

    it('should store the session under the key both platforms share', async () => {
      setPlatform('ios');
      const { signInWithGoogle } = await import('../native-google-auth');

      await signInWithGoogle();

      expect(keychain.set).toHaveBeenCalledWith({
        key: 'pagespace_session',
        value: JSON.stringify({
          sessionToken: 'ps_sess_new',
          csrfToken: 'c',
          deviceId: 'device-1',
          deviceToken: 'ps_dev_new',
        }),
      });
    });

    it('should keep reporting a user cancellation as such', async () => {
      setPlatform('ios');
      socialLogin.login.mockRejectedValue(new Error('The user canceled the sign-in flow'));
      const { signInWithGoogle } = await import('../native-google-auth');

      expect(await signInWithGoogle()).toEqual({ success: false, error: 'Sign-in cancelled' });
    });
  });

  describe('Apple sign-in refuses to run where there is no native SDK', () => {
    it('given Android, should not touch the plugin', async () => {
      setPlatform('android');
      const { signInWithApple } = await import('../native-apple-auth');

      const result = await signInWithApple();

      expect(result.success).toBe(false);
      expect(socialLogin.initialize).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('reading the stored session distinguishes an empty store from a broken one', () => {
    it('given the secure store rejects, should throw rather than report "no session"', async () => {
      setPlatform('ios');
      keychain.get.mockRejectedValue(new Error('keystore unavailable'));
      const { getStoredSession } = await import('../native-google-auth');

      await expect(getStoredSession()).rejects.toThrow(/Secure storage read failed/);
    });

    it('given the store answers with nothing, should report no session', async () => {
      setPlatform('ios');
      keychain.get.mockResolvedValue({ value: null });
      const { getStoredSession } = await import('../native-google-auth');

      await expect(getStoredSession()).resolves.toBeNull();
    });

    it('given the store answers with unparseable bytes, should report no session rather than throw', async () => {
      setPlatform('ios');
      keychain.get.mockResolvedValue({ value: 'not json' });
      const { getStoredSession } = await import('../native-google-auth');

      await expect(getStoredSession()).resolves.toBeNull();
    });

    it('given a stored session, should return it', async () => {
      setPlatform('ios');
      keychain.get.mockResolvedValue({
        value: JSON.stringify({ sessionToken: 'ps_sess_1', deviceId: 'device-1', deviceToken: 'ps_dev_1' }),
      });
      const { getStoredSession } = await import('../native-google-auth');

      await expect(getStoredSession()).resolves.toEqual({
        sessionToken: 'ps_sess_1',
        csrfToken: null,
        deviceId: 'device-1',
        deviceToken: 'ps_dev_1',
      });
    });
  });
});

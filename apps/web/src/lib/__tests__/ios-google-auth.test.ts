import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to set the env var before the module is evaluated.
// ios-google-auth.ts reads IOS_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID
// as a module-level const, so it must be available at the time the module is first imported.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID = 'test-ios-client-id';
});

// Mock capacitor-bridge
vi.mock('../capacitor-bridge', () => ({
  isCapacitorApp: vi.fn(),
  getPlatform: vi.fn(),
}));

// Mock @paralleldrive/cuid2
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-device-id-google'),
}));

// Mock dynamic imports used inside the auth functions
const mockSocialLogin = {
  initialize: vi.fn().mockResolvedValue(undefined),
  login: vi.fn(),
};
const mockPreferences = {
  get: vi.fn(),
  set: vi.fn().mockResolvedValue(undefined),
};
const mockPageSpaceKeychain = {
  set: vi.fn().mockResolvedValue(undefined),
  get: vi.fn(),
  remove: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@capgo/capacitor-social-login', () => ({
  SocialLogin: mockSocialLogin,
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: mockPreferences,
}));

vi.mock('../keychain-plugin', () => ({
  PageSpaceKeychain: mockPageSpaceKeychain,
}));

import { isCapacitorApp, getPlatform } from '../capacitor-bridge';
import {
  signInWithGoogle,
  isNativeGoogleAuthAvailable,
  getStoredSession,
  getSessionToken,
  clearStoredSession,
} from '../ios-google-auth';

describe('ios-google-auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isNativeGoogleAuthAvailable', () => {
    it('returns true when in Capacitor iOS app', () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('ios');
      expect(isNativeGoogleAuthAvailable()).toBe(true);
    });

    it('returns false when not in Capacitor app', () => {
      vi.mocked(isCapacitorApp).mockReturnValue(false);
      vi.mocked(getPlatform).mockReturnValue('web');
      expect(isNativeGoogleAuthAvailable()).toBe(false);
    });

    it('returns false when in Capacitor but on Android', () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('android');
      expect(isNativeGoogleAuthAvailable()).toBe(false);
    });

    it('returns false when in Capacitor but on web platform', () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('web');
      expect(isNativeGoogleAuthAvailable()).toBe(false);
    });
  });

  describe('signInWithGoogle', () => {
    describe('guard conditions', () => {
      it('returns failure when not in Capacitor app', async () => {
        vi.mocked(isCapacitorApp).mockReturnValue(false);
        vi.mocked(getPlatform).mockReturnValue('web');

        const result = await signInWithGoogle();
        expect(result.success).toBe(false);
        expect(result.error).toBe('Not in iOS app');
      });

      it('returns failure when in Capacitor but not iOS', async () => {
        vi.mocked(isCapacitorApp).mockReturnValue(true);
        vi.mocked(getPlatform).mockReturnValue('android');

        const result = await signInWithGoogle();
        expect(result.success).toBe(false);
        expect(result.error).toBe('Not in iOS app');
      });
    });

    describe('when in iOS Capacitor app', () => {
      beforeEach(() => {
        vi.mocked(isCapacitorApp).mockReturnValue(true);
        vi.mocked(getPlatform).mockReturnValue('ios');
      });

      it('initializes SocialLogin with iOS client ID', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { responseType: 'online', idToken: 'google-id-token' },
        });
        mockPreferences.get.mockResolvedValue({ value: 'existing-device-id' });

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ sessionToken: 'sess-123' }),
        });

        await signInWithGoogle();
        expect(mockSocialLogin.initialize).toHaveBeenCalledWith({
          google: { iOSClientId: 'test-ios-client-id' },
        });
      });

      it('calls SocialLogin.login with google provider, email/profile scopes, and forcePrompt', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { responseType: 'online', idToken: 'google-id-token' },
        });
        mockPreferences.get.mockResolvedValue({ value: 'device-id' });

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ sessionToken: 'sess-123' }),
        });

        await signInWithGoogle();
        expect(mockSocialLogin.login).toHaveBeenCalledWith({
          provider: 'google',
          options: {
            scopes: ['email', 'profile'],
            forcePrompt: true,
          },
        });
      });

      it('returns failure when Google returns offline response type', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { responseType: 'offline', serverAuthCode: 'auth-code' },
        });
        mockPreferences.get.mockResolvedValue({ value: null });

        const result = await signInWithGoogle();
        expect(result.success).toBe(false);
        expect(result.error).toContain('No ID token');
      });

      it('returns failure when no idToken in online response', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { responseType: 'online', idToken: null },
        });
        mockPreferences.get.mockResolvedValue({ value: null });

        const result = await signInWithGoogle();
        expect(result.success).toBe(false);
        expect(result.error).toContain('No ID token');
      });

      it('uses existing device ID from Preferences when available', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { responseType: 'online', idToken: 'google-token' },
        });
        mockPreferences.get.mockResolvedValue({ value: 'existing-device-id' });

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ sessionToken: 'sess' }),
        });

        await signInWithGoogle();
        expect(mockPreferences.set).not.toHaveBeenCalled();
      });

      it('creates and saves new device ID when none exists', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { responseType: 'online', idToken: 'google-token' },
        });
        mockPreferences.get.mockResolvedValue({ value: null });

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ sessionToken: 'sess' }),
        });

        await signInWithGoogle();
        expect(mockPreferences.set).toHaveBeenCalledWith({
          key: 'pagespace_device_id',
          value: 'mock-device-id-google',
        });
      });

      it('exchanges Google ID token with backend and returns success', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { responseType: 'online', idToken: 'google-token' },
        });
        mockPreferences.get.mockResolvedValue({ value: 'device-id' });

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              sessionToken: 'sess-token',
              csrfToken: 'csrf-token',
              deviceToken: 'dev-token',
              isNewUser: true,
              user: { id: 'u2', name: 'Google User', email: 'guser@gmail.com' },
            }),
        });

        const result = await signInWithGoogle();
        expect(result.success).toBe(true);
        expect(result.isNewUser).toBe(true);
        expect(result.user?.email).toBe('guser@gmail.com');
      });

      it('stores session tokens in keychain after success', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { responseType: 'online', idToken: 'google-token' },
        });
        mockPreferences.get.mockResolvedValue({ value: 'device-id-xyz' });

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              sessionToken: 'sess-token',
              csrfToken: null,
              deviceToken: 'dev-tok',
            }),
        });

        await signInWithGoogle();
        expect(mockPageSpaceKeychain.set).toHaveBeenCalledWith({
          key: 'pagespace_session',
          value: JSON.stringify({
            sessionToken: 'sess-token',
            csrfToken: null,
            deviceId: 'device-id-xyz',
            deviceToken: 'dev-tok',
          }),
        });
      });

      it('returns failure when backend returns non-OK response', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { responseType: 'online', idToken: 'google-token' },
        });
        mockPreferences.get.mockResolvedValue({ value: 'device-id' });

        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: 'Forbidden' }),
        });

        const result = await signInWithGoogle();
        expect(result.success).toBe(false);
        expect(result.error).toBe('Forbidden');
      });

      it('returns failure when backend returns no sessionToken', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { responseType: 'online', idToken: 'google-token' },
        });
        mockPreferences.get.mockResolvedValue({ value: 'device-id' });

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ sessionToken: undefined }),
        });

        const result = await signInWithGoogle();
        expect(result.success).toBe(false);
        expect(result.error).toContain('No session token');
      });

      it('returns "Sign-in cancelled" when error message contains "cancel"', async () => {
        mockSocialLogin.login.mockRejectedValue(new Error('User cancelled sign-in'));

        const result = await signInWithGoogle();
        expect(result.success).toBe(false);
        expect(result.error).toBe('Sign-in cancelled');
      });

      it('returns the error message for generic errors', async () => {
        mockSocialLogin.login.mockRejectedValue(new Error('Unknown failure'));

        const result = await signInWithGoogle();
        expect(result.success).toBe(false);
        expect(result.error).toBe('Unknown failure');
      });

      it('returns "Sign-in failed" for non-Error thrown values', async () => {
        mockSocialLogin.login.mockRejectedValue(42);

        const result = await signInWithGoogle();
        expect(result.success).toBe(false);
        expect(result.error).toBe('Sign-in failed');
      });

      it('sends platform ios and deviceId to backend', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { responseType: 'online', idToken: 'google-token' },
        });
        mockPreferences.get.mockResolvedValue({ value: 'dev-id-123' });

        const fetchMock = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ sessionToken: 'sess' }),
        });
        global.fetch = fetchMock;

        await signInWithGoogle();

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.platform).toBe('ios');
        expect(body.deviceId).toBe('dev-id-123');
        expect(body.deviceName).toBe('iOS App');
      });
    });
  });

  describe('getStoredSession', () => {
    it('returns null when not in Capacitor iOS app', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(false);
      vi.mocked(getPlatform).mockReturnValue('web');

      const result = await getStoredSession();
      expect(result).toBeNull();
    });

    it('returns null when in Capacitor but not iOS', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('android');

      const result = await getStoredSession();
      expect(result).toBeNull();
    });

    it('returns parsed session when keychain has valid session', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('ios');

      const storedSession = {
        sessionToken: 'sess-abc',
        csrfToken: 'csrf-abc',
        deviceId: 'dev-abc',
        deviceToken: 'dev-tok-abc',
      };
      mockPageSpaceKeychain.get.mockResolvedValue({
        value: JSON.stringify(storedSession),
      });

      const result = await getStoredSession();
      expect(result).toEqual(storedSession);
    });

    it('returns null when keychain has no value', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('ios');

      mockPageSpaceKeychain.get.mockResolvedValue({ value: null });

      const result = await getStoredSession();
      expect(result).toBeNull();
    });

    it('returns null when parsed session is missing sessionToken', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('ios');

      mockPageSpaceKeychain.get.mockResolvedValue({
        value: JSON.stringify({ deviceId: 'dev-id' }),
      });

      const result = await getStoredSession();
      expect(result).toBeNull();
    });

    it('returns null when parsed session is missing deviceId', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('ios');

      mockPageSpaceKeychain.get.mockResolvedValue({
        value: JSON.stringify({ sessionToken: 'sess' }),
      });

      const result = await getStoredSession();
      expect(result).toBeNull();
    });

    it('returns null when keychain throws', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('ios');

      mockPageSpaceKeychain.get.mockRejectedValue(new Error('Keychain error'));

      const result = await getStoredSession();
      expect(result).toBeNull();
    });

    it('normalizes missing optional fields to null', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('ios');

      mockPageSpaceKeychain.get.mockResolvedValue({
        value: JSON.stringify({
          sessionToken: 'sess',
          deviceId: 'dev-id',
          // csrfToken and deviceToken omitted
        }),
      });

      const result = await getStoredSession();
      expect(result).not.toBeNull();
      expect(result!.csrfToken).toBeNull();
      expect(result!.deviceToken).toBeNull();
    });
  });

  describe('getSessionToken', () => {
    it('returns null when not in iOS Capacitor app', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(false);
      vi.mocked(getPlatform).mockReturnValue('web');

      const token = await getSessionToken();
      expect(token).toBeNull();
    });

    it('returns the sessionToken from the stored session', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('ios');

      mockPageSpaceKeychain.get.mockResolvedValue({
        value: JSON.stringify({
          sessionToken: 'my-session-token',
          deviceId: 'dev-id',
        }),
      });

      const token = await getSessionToken();
      expect(token).toBe('my-session-token');
    });

    it('returns null when getStoredSession returns null', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('ios');

      mockPageSpaceKeychain.get.mockResolvedValue({ value: null });

      const token = await getSessionToken();
      expect(token).toBeNull();
    });
  });

  describe('clearStoredSession', () => {
    it('does nothing when not in Capacitor iOS app', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(false);
      vi.mocked(getPlatform).mockReturnValue('web');

      await clearStoredSession();
      expect(mockPageSpaceKeychain.remove).not.toHaveBeenCalled();
    });

    it('does nothing when in Capacitor but not iOS', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('android');

      await clearStoredSession();
      expect(mockPageSpaceKeychain.remove).not.toHaveBeenCalled();
    });

    it('removes pagespace_session and pagespace_csrf from keychain', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('ios');

      await clearStoredSession();
      expect(mockPageSpaceKeychain.remove).toHaveBeenCalledWith({
        key: 'pagespace_session',
      });
      expect(mockPageSpaceKeychain.remove).toHaveBeenCalledWith({
        key: 'pagespace_csrf',
      });
    });

    it('does not throw when keychain.remove throws', async () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('ios');

      mockPageSpaceKeychain.remove.mockRejectedValueOnce(new Error('Keychain error'));

      await expect(clearStoredSession()).resolves.toBeUndefined();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock capacitor-bridge
vi.mock('../capacitor-bridge', () => ({
  isCapacitorApp: vi.fn(),
  getPlatform: vi.fn(),
}));

// Mock @paralleldrive/cuid2
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-device-id-123'),
}));

// Mock dynamic imports used inside signInWithApple
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
import { signInWithApple, isNativeAppleAuthAvailable } from '../ios-apple-auth';

describe('ios-apple-auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isNativeAppleAuthAvailable', () => {
    it('returns true when in Capacitor iOS app', () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('ios');
      expect(isNativeAppleAuthAvailable()).toBe(true);
    });

    it('returns false when not in Capacitor app', () => {
      vi.mocked(isCapacitorApp).mockReturnValue(false);
      vi.mocked(getPlatform).mockReturnValue('web');
      expect(isNativeAppleAuthAvailable()).toBe(false);
    });

    it('returns false when in Capacitor but not iOS (android)', () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('android');
      expect(isNativeAppleAuthAvailable()).toBe(false);
    });

    it('returns false when in Capacitor but on web platform', () => {
      vi.mocked(isCapacitorApp).mockReturnValue(true);
      vi.mocked(getPlatform).mockReturnValue('web');
      expect(isNativeAppleAuthAvailable()).toBe(false);
    });
  });

  describe('signInWithApple', () => {
    describe('guard conditions', () => {
      it('returns failure when not in Capacitor app', async () => {
        vi.mocked(isCapacitorApp).mockReturnValue(false);
        vi.mocked(getPlatform).mockReturnValue('web');

        const result = await signInWithApple();
        expect(result.success).toBe(false);
        expect(result.error).toBe('Not in iOS app');
      });

      it('returns failure when in Capacitor but not iOS', async () => {
        vi.mocked(isCapacitorApp).mockReturnValue(true);
        vi.mocked(getPlatform).mockReturnValue('android');

        const result = await signInWithApple();
        expect(result.success).toBe(false);
        expect(result.error).toBe('Not in iOS app');
      });
    });

    describe('when in iOS Capacitor app', () => {
      beforeEach(() => {
        vi.mocked(isCapacitorApp).mockReturnValue(true);
        vi.mocked(getPlatform).mockReturnValue('ios');
      });

      it('initializes SocialLogin with Apple client ID', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { idToken: 'apple-id-token', profile: {} },
        });
        mockPreferences.get.mockResolvedValue({ value: 'existing-device-id' });

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              sessionToken: 'sess-123',
              csrfToken: 'csrf-123',
              deviceToken: null,
              isNewUser: false,
              user: { id: 'u1', name: 'Test', email: 'test@test.com' },
            }),
        });

        await signInWithApple();
        expect(mockSocialLogin.initialize).toHaveBeenCalledWith({
          apple: { clientId: 'ai.pagespace.ios' },
        });
      });

      it('calls SocialLogin.login with apple provider and correct scopes', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { idToken: 'apple-id-token', profile: {} },
        });
        mockPreferences.get.mockResolvedValue({ value: 'existing-device-id' });

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              sessionToken: 'sess-123',
            }),
        });

        await signInWithApple();
        expect(mockSocialLogin.login).toHaveBeenCalledWith({
          provider: 'apple',
          options: { scopes: ['email', 'name'] },
        });
      });

      it('uses existing device ID from Preferences if available', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { idToken: 'apple-id-token', profile: {} },
        });
        mockPreferences.get.mockResolvedValue({ value: 'pre-existing-device-id' });

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ sessionToken: 'sess-123' }),
        });

        await signInWithApple();
        expect(mockPreferences.set).not.toHaveBeenCalled();
      });

      it('creates and saves a new device ID when none exists', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { idToken: 'apple-id-token', profile: {} },
        });
        mockPreferences.get.mockResolvedValue({ value: null });

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ sessionToken: 'sess-123' }),
        });

        await signInWithApple();
        expect(mockPreferences.set).toHaveBeenCalledWith({
          key: 'pagespace_device_id',
          value: 'mock-device-id-123',
        });
      });

      it('returns failure with error message when no idToken is received', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { idToken: null, profile: {} },
        });
        mockPreferences.get.mockResolvedValue({ value: null });

        const result = await signInWithApple();
        expect(result.success).toBe(false);
        expect(result.error).toContain('No ID token');
      });

      it('exchanges idToken with backend and returns success', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: {
            idToken: 'apple-id-token',
            profile: { givenName: 'John', familyName: 'Doe' },
          },
        });
        mockPreferences.get.mockResolvedValue({ value: 'device-id-abc' });

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              sessionToken: 'sess-token',
              csrfToken: 'csrf-token',
              deviceToken: 'dev-token',
              isNewUser: true,
              user: { id: 'u1', name: 'John Doe', email: 'john@example.com' },
            }),
        });

        const result = await signInWithApple();
        expect(result.success).toBe(true);
        expect(result.isNewUser).toBe(true);
        expect(result.user?.name).toBe('John Doe');
      });

      it('stores session tokens in keychain after success', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { idToken: 'apple-id-token', profile: {} },
        });
        mockPreferences.get.mockResolvedValue({ value: 'device-id-abc' });

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              sessionToken: 'sess-token',
              csrfToken: 'csrf-token',
              deviceToken: null,
            }),
        });

        await signInWithApple();
        expect(mockPageSpaceKeychain.set).toHaveBeenCalledWith({
          key: 'pagespace_session',
          value: JSON.stringify({
            sessionToken: 'sess-token',
            csrfToken: 'csrf-token',
            deviceId: 'device-id-abc',
            deviceToken: null,
          }),
        });
      });

      it('returns failure when backend returns non-OK response', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { idToken: 'apple-id-token', profile: {} },
        });
        mockPreferences.get.mockResolvedValue({ value: 'device-id-abc' });

        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: 'Unauthorized' }),
        });

        const result = await signInWithApple();
        expect(result.success).toBe(false);
        expect(result.error).toBe('Unauthorized');
      });

      it('returns failure when backend returns no sessionToken', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: { idToken: 'apple-id-token', profile: {} },
        });
        mockPreferences.get.mockResolvedValue({ value: 'device-id-abc' });

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ sessionToken: null }),
        });

        const result = await signInWithApple();
        expect(result.success).toBe(false);
        expect(result.error).toContain('No session token');
      });

      it('returns "Sign-in cancelled" when error message contains "cancel"', async () => {
        mockSocialLogin.login.mockRejectedValue(new Error('User cancelled the sign-in'));

        const result = await signInWithApple();
        expect(result.success).toBe(false);
        expect(result.error).toBe('Sign-in cancelled');
      });

      it('returns "Sign-in cancelled" when error message contains "Cancel" (capital C)', async () => {
        mockSocialLogin.login.mockRejectedValue(new Error('Cancel button tapped'));

        const result = await signInWithApple();
        expect(result.success).toBe(false);
        expect(result.error).toBe('Sign-in cancelled');
      });

      it('returns the error message for generic errors', async () => {
        mockSocialLogin.login.mockRejectedValue(new Error('Network timeout'));

        const result = await signInWithApple();
        expect(result.success).toBe(false);
        expect(result.error).toBe('Network timeout');
      });

      it('returns "Sign-in failed" for non-Error thrown values', async () => {
        mockSocialLogin.login.mockRejectedValue('unexpected error string');

        const result = await signInWithApple();
        expect(result.success).toBe(false);
        expect(result.error).toBe('Sign-in failed');
      });

      it('sends givenName and familyName from Apple profile to backend', async () => {
        mockSocialLogin.login.mockResolvedValue({
          result: {
            idToken: 'apple-id-token',
            profile: { givenName: 'Jane', familyName: 'Smith' },
          },
        });
        mockPreferences.get.mockResolvedValue({ value: 'device-id' });

        const fetchMock = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ sessionToken: 'sess' }),
        });
        global.fetch = fetchMock;

        await signInWithApple();

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.givenName).toBe('Jane');
        expect(body.familyName).toBe('Smith');
        expect(body.platform).toBe('ios');
      });
    });
  });
});

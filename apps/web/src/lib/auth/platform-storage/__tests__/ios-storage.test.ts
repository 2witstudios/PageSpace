import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IOSStorage } from '../ios-storage';

// Mock all dynamic imports used by ios-storage
vi.mock('@/lib/ios-google-auth', () => ({
  getSessionToken: vi.fn(),
  getStoredSession: vi.fn(),
  clearStoredSession: vi.fn(),
}));

vi.mock('@/lib/keychain-plugin', () => ({
  PageSpaceKeychain: {
    set: vi.fn(),
  },
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'generated-cuid'),
}));

import { getSessionToken as mockGetSessionToken, getStoredSession as mockGetStoredSession, clearStoredSession as mockClearStoredSession } from '@/lib/ios-google-auth';
import { PageSpaceKeychain } from '@/lib/keychain-plugin';
import { Preferences } from '@capacitor/preferences';
import { createId } from '@paralleldrive/cuid2';

describe('IOSStorage', () => {
  let storage: IOSStorage;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up window and navigator globals
    Object.defineProperty(global, 'window', {
      value: {
        dispatchEvent: vi.fn(),
      },
      writable: true,
      configurable: true,
    });

    Object.defineProperty(global, 'navigator', {
      value: { userAgent: 'iOS-test-agent' },
      writable: true,
      configurable: true,
    });

    storage = new IOSStorage();
  });

  describe('platform identity', () => {
    it('should have platform set to ios', () => {
      expect(storage.platform).toBe('ios');
    });
  });

  describe('usesBearer', () => {
    it('should return true (iOS uses Bearer token transport)', () => {
      expect(storage.usesBearer()).toBe(true);
    });
  });

  describe('supportsCSRF', () => {
    it('should return false (iOS does not use CSRF cookies)', () => {
      expect(storage.supportsCSRF()).toBe(false);
    });
  });

  describe('getSessionToken', () => {
    it('should return the token from ios-google-auth.getSessionToken', async () => {
      vi.mocked(mockGetSessionToken).mockResolvedValue('ios-session-token');
      const result = await storage.getSessionToken();
      expect(result).toBe('ios-session-token');
    });

    it('should return null when getSessionToken returns null', async () => {
      vi.mocked(mockGetSessionToken).mockResolvedValue(null);
      const result = await storage.getSessionToken();
      expect(result).toBeNull();
    });

    it('should delegate to ios-google-auth module', async () => {
      vi.mocked(mockGetSessionToken).mockResolvedValue('token');
      await storage.getSessionToken();
      expect(mockGetSessionToken).toHaveBeenCalledOnce();
    });
  });

  describe('getStoredSession', () => {
    it('should return null when ios-google-auth.getStoredSession returns null', async () => {
      vi.mocked(mockGetStoredSession).mockResolvedValue(null);
      const result = await storage.getStoredSession();
      expect(result).toBeNull();
    });

    it('should return mapped StoredSession when session exists', async () => {
      vi.mocked(mockGetStoredSession).mockResolvedValue({
        sessionToken: 'sess-abc',
        csrfToken: 'csrf-xyz',
        deviceId: 'dev-123',
        deviceToken: 'dev-tok',
      });

      const result = await storage.getStoredSession();

      expect(result).toEqual({
        sessionToken: 'sess-abc',
        csrfToken: 'csrf-xyz',
        deviceId: 'dev-123',
        deviceToken: 'dev-tok',
      });
    });

    it('should use null for csrfToken when undefined', async () => {
      vi.mocked(mockGetStoredSession).mockResolvedValue({
        sessionToken: 'sess',
        csrfToken: undefined,
        deviceId: 'dev-1',
        deviceToken: null,
      });

      const result = await storage.getStoredSession();

      expect(result?.csrfToken).toBeNull();
    });

    it('should use null for deviceToken when undefined', async () => {
      vi.mocked(mockGetStoredSession).mockResolvedValue({
        sessionToken: 'sess',
        csrfToken: null,
        deviceId: 'dev-1',
        deviceToken: undefined,
      });

      const result = await storage.getStoredSession();

      expect(result?.deviceToken).toBeNull();
    });
  });

  describe('storeSession', () => {
    it('should store session via PageSpaceKeychain', async () => {
      vi.mocked(PageSpaceKeychain.set).mockResolvedValue(undefined);

      const session = {
        sessionToken: 'sess-tok',
        csrfToken: 'csrf-tok',
        deviceToken: 'dev-tok',
        deviceId: 'dev-id',
      };

      await storage.storeSession(session);

      expect(PageSpaceKeychain.set).toHaveBeenCalledWith({
        key: 'pagespace_session',
        value: JSON.stringify(session),
      });
    });

    it('should serialize the full session object as JSON', async () => {
      vi.mocked(PageSpaceKeychain.set).mockResolvedValue(undefined);

      const session = {
        sessionToken: 'tok',
        csrfToken: null,
        deviceToken: null,
        deviceId: 'some-device',
      };

      await storage.storeSession(session);

      const callArg = vi.mocked(PageSpaceKeychain.set).mock.calls[0][0];
      expect(JSON.parse(callArg.value)).toEqual(session);
    });
  });

  describe('clearSession', () => {
    it('should call clearStoredSession from ios-google-auth', async () => {
      vi.mocked(mockClearStoredSession).mockResolvedValue(undefined);

      await storage.clearSession();

      expect(mockClearStoredSession).toHaveBeenCalledOnce();
    });

    it('should dispatch auth:cleared event after clearing', async () => {
      vi.mocked(mockClearStoredSession).mockResolvedValue(undefined);

      await storage.clearSession();

      expect(window.dispatchEvent).toHaveBeenCalledOnce();
      const event = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(event.type).toBe('auth:cleared');
    });
  });

  describe('getDeviceId', () => {
    it('should return existing device ID from Preferences', async () => {
      vi.mocked(Preferences.get).mockResolvedValue({ value: 'existing-device-id' });

      const result = await storage.getDeviceId();

      expect(result).toBe('existing-device-id');
      expect(Preferences.get).toHaveBeenCalledWith({ key: 'pagespace_device_id' });
    });

    it('should generate a new CUID2 ID when no device ID is stored', async () => {
      vi.mocked(Preferences.get).mockResolvedValue({ value: null });
      vi.mocked(Preferences.set).mockResolvedValue(undefined);
      vi.mocked(createId).mockReturnValue('generated-cuid');

      const result = await storage.getDeviceId();

      expect(result).toBe('generated-cuid');
      expect(createId).toHaveBeenCalledOnce();
    });

    it('should persist the generated device ID to Preferences', async () => {
      vi.mocked(Preferences.get).mockResolvedValue({ value: null });
      vi.mocked(Preferences.set).mockResolvedValue(undefined);
      vi.mocked(createId).mockReturnValue('new-cuid-id');

      await storage.getDeviceId();

      expect(Preferences.set).toHaveBeenCalledWith({
        key: 'pagespace_device_id',
        value: 'new-cuid-id',
      });
    });

    it('should not call createId when device ID already exists', async () => {
      vi.mocked(Preferences.get).mockResolvedValue({ value: 'existing-id' });

      await storage.getDeviceId();

      expect(createId).not.toHaveBeenCalled();
    });
  });

  describe('getDeviceInfo', () => {
    it('should return deviceId and userAgent', async () => {
      vi.mocked(Preferences.get).mockResolvedValue({ value: 'ios-device-id' });

      const result = await storage.getDeviceInfo();

      expect(result.deviceId).toBe('ios-device-id');
      expect(result.userAgent).toBe('iOS-test-agent');
    });

    it('should use navigator.userAgent for userAgent field', async () => {
      vi.mocked(Preferences.get).mockResolvedValue({ value: 'dev-id' });

      Object.defineProperty(global, 'navigator', {
        value: { userAgent: 'CustomIOSAgent/1.0' },
        writable: true,
        configurable: true,
      });

      const result = await storage.getDeviceInfo();

      expect(result.userAgent).toBe('CustomIOSAgent/1.0');
    });
  });

  describe('dispatchAuthEvent', () => {
    it('should dispatch auth:cleared event on window', () => {
      storage.dispatchAuthEvent('auth:cleared');
      expect(window.dispatchEvent).toHaveBeenCalledOnce();
      const event = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(event.type).toBe('auth:cleared');
    });

    it('should dispatch auth:refreshed event', () => {
      storage.dispatchAuthEvent('auth:refreshed');
      const event = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(event.type).toBe('auth:refreshed');
    });

    it('should dispatch auth:expired event', () => {
      storage.dispatchAuthEvent('auth:expired');
      const event = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(event.type).toBe('auth:expired');
    });

    it('should dispatch a CustomEvent', () => {
      storage.dispatchAuthEvent('auth:cleared');
      const event = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(event).toBeInstanceOf(CustomEvent);
    });
  });
});

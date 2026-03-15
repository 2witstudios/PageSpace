import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebStorage } from '../web-storage';

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'generated-cuid'),
}));

import { createId } from '@paralleldrive/cuid2';

describe('WebStorage', () => {
  let storage: WebStorage;
  let mockLocalStorage: {
    getItem: ReturnType<typeof vi.fn>;
    setItem: ReturnType<typeof vi.fn>;
    removeItem: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockLocalStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    };

    Object.defineProperty(global, 'localStorage', {
      value: mockLocalStorage,
      writable: true,
      configurable: true,
    });

    Object.defineProperty(global, 'navigator', {
      value: { userAgent: 'web-test-agent' },
      writable: true,
      configurable: true,
    });

    storage = new WebStorage();
  });

  describe('platform identity', () => {
    it('should have platform set to web', () => {
      expect(storage.platform).toBe('web');
    });
  });

  describe('usesBearer', () => {
    it('should return false (web uses cookies via credentials: include)', () => {
      expect(storage.usesBearer()).toBe(false);
    });
  });

  describe('supportsCSRF', () => {
    it('should return true (web supports CSRF protection)', () => {
      expect(storage.supportsCSRF()).toBe(true);
    });
  });

  describe('getSessionToken', () => {
    it('should return null (web uses cookies, not Bearer tokens)', async () => {
      const result = await storage.getSessionToken();
      expect(result).toBeNull();
    });
  });

  describe('getStoredSession', () => {
    it('should return null when deviceToken is not in localStorage', async () => {
      mockLocalStorage.getItem.mockReturnValue(null);
      const result = await storage.getStoredSession();
      expect(result).toBeNull();
    });

    it('should return a session when deviceToken exists', async () => {
      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === 'deviceToken') return 'dev-token-value';
        if (key === 'browser_device_id') return 'browser-dev-id';
        return null;
      });

      const result = await storage.getStoredSession();

      expect(result).toEqual({
        sessionToken: '',
        csrfToken: null,
        deviceId: 'browser-dev-id',
        deviceToken: 'dev-token-value',
      });
    });

    it('should use browser_device_id key preferentially', async () => {
      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === 'deviceToken') return 'tok';
        if (key === 'browser_device_id') return 'browser-id';
        if (key === 'deviceId') return 'old-id';
        return null;
      });

      const result = await storage.getStoredSession();

      expect(result?.deviceId).toBe('browser-id');
    });

    it('should fall back to deviceId key when browser_device_id is absent', async () => {
      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === 'deviceToken') return 'tok';
        if (key === 'browser_device_id') return null;
        if (key === 'deviceId') return 'legacy-id';
        return null;
      });

      const result = await storage.getStoredSession();

      expect(result?.deviceId).toBe('legacy-id');
    });

    it('should use empty string for deviceId when neither key is set', async () => {
      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === 'deviceToken') return 'tok';
        return null;
      });

      const result = await storage.getStoredSession();

      expect(result?.deviceId).toBe('');
    });

    it('should always set sessionToken to empty string', async () => {
      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === 'deviceToken') return 'tok';
        return null;
      });

      const result = await storage.getStoredSession();

      expect(result?.sessionToken).toBe('');
    });

    it('should always set csrfToken to null', async () => {
      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === 'deviceToken') return 'tok';
        return null;
      });

      const result = await storage.getStoredSession();

      expect(result?.csrfToken).toBeNull();
    });
  });

  describe('storeSession', () => {
    it('should store deviceToken in localStorage when provided', async () => {
      await storage.storeSession({
        sessionToken: '',
        csrfToken: null,
        deviceToken: 'new-dev-token',
        deviceId: 'dev-123',
      });

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('deviceToken', 'new-dev-token');
    });

    it('should store deviceId as browser_device_id in localStorage when provided', async () => {
      await storage.storeSession({
        sessionToken: '',
        csrfToken: null,
        deviceToken: 'tok',
        deviceId: 'my-device-id',
      });

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('browser_device_id', 'my-device-id');
    });

    it('should not store deviceToken when it is null', async () => {
      await storage.storeSession({
        sessionToken: '',
        csrfToken: null,
        deviceToken: null,
        deviceId: 'dev-id',
      });

      expect(mockLocalStorage.setItem).not.toHaveBeenCalledWith('deviceToken', expect.anything());
    });

    it('should not store deviceId when it is empty string (falsy)', async () => {
      await storage.storeSession({
        sessionToken: '',
        csrfToken: null,
        deviceToken: 'tok',
        deviceId: '',
      });

      expect(mockLocalStorage.setItem).not.toHaveBeenCalledWith('browser_device_id', expect.anything());
    });

    it('should store both deviceToken and deviceId when both are provided', async () => {
      await storage.storeSession({
        sessionToken: '',
        csrfToken: null,
        deviceToken: 'device-tok',
        deviceId: 'device-id',
      });

      expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(2);
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('deviceToken', 'device-tok');
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('browser_device_id', 'device-id');
    });
  });

  describe('clearSession', () => {
    it('should remove deviceToken from localStorage', async () => {
      await storage.clearSession();
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('deviceToken');
    });

    it('should only remove deviceToken (not other keys)', async () => {
      await storage.clearSession();
      expect(mockLocalStorage.removeItem).toHaveBeenCalledTimes(1);
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('deviceToken');
    });
  });

  describe('getDeviceId', () => {
    it('should return existing browser_device_id from localStorage', async () => {
      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === 'browser_device_id') return 'existing-browser-id';
        return null;
      });

      const result = await storage.getDeviceId();

      expect(result).toBe('existing-browser-id');
      expect(createId).not.toHaveBeenCalled();
    });

    it('should fall back to deviceId key for backwards compatibility', async () => {
      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === 'browser_device_id') return null;
        if (key === 'deviceId') return 'legacy-device-id';
        return null;
      });

      const result = await storage.getDeviceId();

      expect(result).toBe('legacy-device-id');
    });

    it('should generate a new CUID2 ID when no device ID exists', async () => {
      mockLocalStorage.getItem.mockReturnValue(null);
      vi.mocked(createId).mockReturnValue('new-cuid');

      const result = await storage.getDeviceId();

      expect(result).toBe('new-cuid');
      expect(createId).toHaveBeenCalledOnce();
    });

    it('should persist the new generated ID to localStorage under browser_device_id', async () => {
      mockLocalStorage.getItem.mockReturnValue(null);
      vi.mocked(createId).mockReturnValue('persisted-cuid');

      await storage.getDeviceId();

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('browser_device_id', 'persisted-cuid');
    });

    it('should not generate a new ID when browser_device_id is already set', async () => {
      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === 'browser_device_id') return 'already-exists';
        return null;
      });

      await storage.getDeviceId();

      expect(createId).not.toHaveBeenCalled();
      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
    });
  });

  describe('getDeviceInfo', () => {
    it('should return deviceId and userAgent', async () => {
      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === 'browser_device_id') return 'web-device-id';
        return null;
      });

      const result = await storage.getDeviceInfo();

      expect(result.deviceId).toBe('web-device-id');
      expect(result.userAgent).toBe('web-test-agent');
    });

    it('should use navigator.userAgent for the userAgent field', async () => {
      mockLocalStorage.getItem.mockImplementation((key: string) => {
        if (key === 'browser_device_id') return 'dev-id';
        return null;
      });

      Object.defineProperty(global, 'navigator', {
        value: { userAgent: 'Mozilla/5.0 Chrome/100' },
        writable: true,
        configurable: true,
      });

      const result = await storage.getDeviceInfo();

      expect(result.userAgent).toBe('Mozilla/5.0 Chrome/100');
    });
  });

  describe('dispatchAuthEvent (optional interface method)', () => {
    it('should not have a dispatchAuthEvent method (WebStorage does not implement it)', () => {
      // WebStorage does not declare dispatchAuthEvent
      expect((storage as unknown as { dispatchAuthEvent?: unknown }).dispatchAuthEvent).toBeUndefined();
    });
  });
});

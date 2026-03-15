import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DesktopStorage } from '../desktop-storage';

// desktop-storage depends entirely on window.electron and window.dispatchEvent
// We mock the global window object to avoid needing a browser environment

describe('DesktopStorage', () => {
  let storage: DesktopStorage;
  let mockElectronAuth: {
    getSessionToken: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    getDeviceInfo: ReturnType<typeof vi.fn>;
    storeSession: ReturnType<typeof vi.fn>;
    clearAuth: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockElectronAuth = {
      getSessionToken: vi.fn(),
      getSession: vi.fn(),
      getDeviceInfo: vi.fn(),
      storeSession: vi.fn(),
      clearAuth: vi.fn(),
    };

    // Set up window.electron mock
    Object.defineProperty(global, 'window', {
      value: {
        electron: { auth: mockElectronAuth },
        dispatchEvent: vi.fn(),
        navigator: { userAgent: 'test-agent' },
      },
      writable: true,
      configurable: true,
    });

    // Also mock navigator.userAgent
    Object.defineProperty(global, 'navigator', {
      value: { userAgent: 'test-agent' },
      writable: true,
      configurable: true,
    });

    storage = new DesktopStorage();
  });

  describe('platform identity', () => {
    it('should have platform set to desktop', () => {
      expect(storage.platform).toBe('desktop');
    });
  });

  describe('usesBearer', () => {
    it('should return true (desktop uses Bearer token transport)', () => {
      expect(storage.usesBearer()).toBe(true);
    });
  });

  describe('supportsCSRF', () => {
    it('should return false (desktop does not use CSRF cookies)', () => {
      expect(storage.supportsCSRF()).toBe(false);
    });
  });

  describe('getSessionToken', () => {
    it('should return the token from electron.auth.getSessionToken', async () => {
      mockElectronAuth.getSessionToken.mockReturnValue('test-session-token');
      const result = await storage.getSessionToken();
      expect(result).toBe('test-session-token');
    });

    it('should return null when electron.auth.getSessionToken returns undefined', async () => {
      mockElectronAuth.getSessionToken.mockReturnValue(undefined);
      const result = await storage.getSessionToken();
      expect(result).toBeNull();
    });

    it('should return null when window.electron is not available', async () => {
      (global.window as unknown as { electron: undefined }).electron = undefined;
      const result = await storage.getSessionToken();
      expect(result).toBeNull();
    });
  });

  describe('getStoredSession', () => {
    it('should return null when electron.auth.getSession returns null', async () => {
      mockElectronAuth.getSession.mockResolvedValue(null);
      const result = await storage.getStoredSession();
      expect(result).toBeNull();
    });

    it('should return null when electron.auth.getSession returns undefined', async () => {
      mockElectronAuth.getSession.mockResolvedValue(undefined);
      const result = await storage.getStoredSession();
      expect(result).toBeNull();
    });

    it('should return a StoredSession when session and device info are available', async () => {
      mockElectronAuth.getSession.mockResolvedValue({
        sessionToken: 'sess-abc',
        csrfToken: 'csrf-xyz',
        deviceToken: 'dev-tok',
      });
      mockElectronAuth.getDeviceInfo.mockResolvedValue({
        deviceId: 'device-123',
        userAgent: 'Electron/1.0',
        appVersion: '1.2.3',
      });

      const result = await storage.getStoredSession();

      expect(result).toEqual({
        sessionToken: 'sess-abc',
        csrfToken: 'csrf-xyz',
        deviceId: 'device-123',
        deviceToken: 'dev-tok',
      });
    });

    it('should use empty string for sessionToken when session.sessionToken is falsy', async () => {
      mockElectronAuth.getSession.mockResolvedValue({ sessionToken: '' });
      mockElectronAuth.getDeviceInfo.mockResolvedValue({ deviceId: 'dev-1' });

      const result = await storage.getStoredSession();

      expect(result?.sessionToken).toBe('');
    });

    it('should use null for csrfToken when session.csrfToken is falsy', async () => {
      mockElectronAuth.getSession.mockResolvedValue({
        sessionToken: 'sess',
        csrfToken: null,
        deviceToken: null,
      });
      mockElectronAuth.getDeviceInfo.mockResolvedValue({ deviceId: 'dev-1' });

      const result = await storage.getStoredSession();

      expect(result?.csrfToken).toBeNull();
    });

    it('should use empty string for deviceId when getDeviceInfo returns no deviceId', async () => {
      mockElectronAuth.getSession.mockResolvedValue({ sessionToken: 'sess' });
      mockElectronAuth.getDeviceInfo.mockResolvedValue({});

      const result = await storage.getStoredSession();

      expect(result?.deviceId).toBe('');
    });
  });

  describe('storeSession', () => {
    it('should call electron.auth.storeSession with session data', async () => {
      mockElectronAuth.storeSession.mockResolvedValue(undefined);

      await storage.storeSession({
        sessionToken: 'sess-tok',
        csrfToken: 'csrf-tok',
        deviceToken: 'dev-tok',
        deviceId: 'dev-id',
      });

      expect(mockElectronAuth.storeSession).toHaveBeenCalledWith({
        sessionToken: 'sess-tok',
        csrfToken: 'csrf-tok',
        deviceToken: 'dev-tok',
      });
    });

    it('should not throw when electron is unavailable', async () => {
      (global.window as unknown as { electron: undefined }).electron = undefined;
      await expect(
        storage.storeSession({ sessionToken: '', csrfToken: null, deviceToken: null, deviceId: '' })
      ).resolves.not.toThrow();
    });
  });

  describe('clearSession', () => {
    it('should call electron.auth.clearAuth', async () => {
      mockElectronAuth.clearAuth.mockResolvedValue(undefined);
      await storage.clearSession();
      expect(mockElectronAuth.clearAuth).toHaveBeenCalledOnce();
    });

    it('should not throw when electron is unavailable', async () => {
      (global.window as unknown as { electron: undefined }).electron = undefined;
      await expect(storage.clearSession()).resolves.not.toThrow();
    });
  });

  describe('getDeviceId', () => {
    it('should return deviceId from electron.auth.getDeviceInfo', async () => {
      mockElectronAuth.getDeviceInfo.mockResolvedValue({ deviceId: 'electron-device-id' });
      const result = await storage.getDeviceId();
      expect(result).toBe('electron-device-id');
    });

    it('should return empty string when getDeviceInfo returns no deviceId', async () => {
      mockElectronAuth.getDeviceInfo.mockResolvedValue({});
      const result = await storage.getDeviceId();
      expect(result).toBe('');
    });

    it('should return empty string when electron is unavailable', async () => {
      (global.window as unknown as { electron: undefined }).electron = undefined;
      const result = await storage.getDeviceId();
      expect(result).toBe('');
    });
  });

  describe('getDeviceInfo', () => {
    it('should return device info with deviceId and userAgent from electron', async () => {
      mockElectronAuth.getDeviceInfo.mockResolvedValue({
        deviceId: 'elec-id',
        userAgent: 'Electron/2.0',
        appVersion: '2.0.0',
      });

      const result = await storage.getDeviceInfo();

      expect(result.deviceId).toBe('elec-id');
      expect(result.userAgent).toBe('Electron/2.0');
      expect(result.appVersion).toBe('2.0.0');
    });

    it('should fall back to navigator.userAgent when info.userAgent is falsy', async () => {
      mockElectronAuth.getDeviceInfo.mockResolvedValue({ deviceId: 'elec-id', userAgent: '' });

      const result = await storage.getDeviceInfo();

      expect(result.userAgent).toBe('test-agent');
    });

    it('should have undefined appVersion when not provided', async () => {
      mockElectronAuth.getDeviceInfo.mockResolvedValue({ deviceId: 'elec-id' });

      const result = await storage.getDeviceInfo();

      expect(result.appVersion).toBeUndefined();
    });
  });

  describe('dispatchAuthEvent', () => {
    it('should dispatch auth:cleared event', () => {
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

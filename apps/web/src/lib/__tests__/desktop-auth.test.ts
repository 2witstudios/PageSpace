import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock window.electron
const mockStoreSession = vi.fn();
const mockGetDeviceInfo = vi.fn();

function setupDesktopWindow() {
  Object.defineProperty(globalThis, 'window', {
    value: {
      electron: {
        isDesktop: true,
        auth: {
          storeSession: mockStoreSession,
          getDeviceInfo: mockGetDeviceInfo,
        },
      },
      location: { href: '' },
    },
    writable: true,
    configurable: true,
  });
}

function setupWebWindow() {
  Object.defineProperty(globalThis, 'window', {
    value: {
      location: { href: '' },
    },
    writable: true,
    configurable: true,
  });
}

describe('desktop-auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('handleDesktopAuthTokens', () => {
    it('should store tokens via electron IPC bridge', async () => {
      setupDesktopWindow();
      mockStoreSession.mockResolvedValue({ success: true });

      const { handleDesktopAuthTokens } = await import('../desktop-auth');

      await handleDesktopAuthTokens({
        sessionToken: 'ps_sess_abc',
        csrfToken: 'csrf_123',
        deviceToken: 'ps_dev_xyz',
      });

      expect(mockStoreSession).toHaveBeenCalledWith({
        sessionToken: 'ps_sess_abc',
        csrfToken: 'csrf_123',
        deviceToken: 'ps_dev_xyz',
      });
    });

    it('should throw if electron bridge is not available', async () => {
      setupWebWindow();

      const { handleDesktopAuthTokens } = await import('../desktop-auth');

      await expect(
        handleDesktopAuthTokens({
          sessionToken: 'ps_sess_abc',
          csrfToken: 'csrf_123',
          deviceToken: 'ps_dev_xyz',
        })
      ).rejects.toThrow('Desktop auth bridge not available');
    });
  });

  describe('isDesktopPlatform', () => {
    it('should return true when electron bridge is present', async () => {
      setupDesktopWindow();
      const { isDesktopPlatform } = await import('../desktop-auth');
      expect(isDesktopPlatform()).toBe(true);
    });

    it('should return false on web', async () => {
      setupWebWindow();
      const { isDesktopPlatform } = await import('../desktop-auth');
      expect(isDesktopPlatform()).toBe(false);
    });
  });

  describe('getDesktopDeviceInfo', () => {
    it('should return device info from electron bridge', async () => {
      setupDesktopWindow();
      mockGetDeviceInfo.mockResolvedValue({
        deviceId: 'dev-123',
        deviceName: 'My Mac',
        platform: 'darwin',
        appVersion: '1.0.0',
        userAgent: 'Darwin 25.0',
      });

      const { getDesktopDeviceInfo } = await import('../desktop-auth');
      const info = await getDesktopDeviceInfo();

      expect(info).toEqual({
        deviceId: 'dev-123',
        deviceName: 'My Mac',
      });
    });

    it('should return null on web', async () => {
      setupWebWindow();
      const { getDesktopDeviceInfo } = await import('../desktop-auth');
      const info = await getDesktopDeviceInfo();
      expect(info).toBeNull();
    });
  });
});

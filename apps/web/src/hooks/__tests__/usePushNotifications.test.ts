import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockUseCapacitor = vi.hoisted(() => vi.fn(() => ({
  isNative: false,
  platform: 'web' as 'web' | 'ios' | 'android',
  isIOS: false,
  isAndroid: false,
  isIPad: false,
  isReady: true,
})));

const mockUseAuth = vi.hoisted(() => vi.fn(() => ({
  isAuthenticated: false,
  user: null,
  isLoading: false,
})));

const mockPost = vi.hoisted(() => vi.fn());
const mockDel = vi.hoisted(() => vi.fn());
const mockGetOrCreateDeviceId = vi.hoisted(() => vi.fn(() => 'device-123'));
const mockGetDeviceName = vi.hoisted(() => vi.fn(() => 'Test Device'));

vi.mock('./useCapacitor', () => ({
  useCapacitor: mockUseCapacitor,
}));

vi.mock('./useAuth', () => ({
  useAuth: mockUseAuth,
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  post: mockPost,
  del: mockDel,
}));

vi.mock('@/lib/analytics', () => ({
  getOrCreateDeviceId: mockGetOrCreateDeviceId,
  getDeviceName: mockGetDeviceName,
}));

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    register: vi.fn(),
    addListener: vi.fn(),
  },
}));

import { usePushNotifications } from '../usePushNotifications';

describe('usePushNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCapacitor.mockReturnValue({
      isNative: false,
      platform: 'web' as 'web' | 'ios' | 'android',
      isIOS: false,
      isAndroid: false,
      isIPad: false,
      isReady: true,
    });
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      user: null,
      isLoading: false,
    });
  });

  describe('support detection', () => {
    it('should report isSupported=false when not in native app', () => {
      mockUseCapacitor.mockReturnValue({
        isNative: false,
        platform: 'web' as const,
        isIOS: false,
        isAndroid: false,
        isIPad: false,
        isReady: true,
      });

      const { result } = renderHook(() => usePushNotifications());

      expect(result.current.isSupported).toBe(false);
    });

    it('should report isSupported=false when native but not iOS', () => {
      mockUseCapacitor.mockReturnValue({
        isNative: true,
        platform: 'android',
        isIOS: false,
        isAndroid: true,
        isIPad: false,
        isReady: true,
      });

      const { result } = renderHook(() => usePushNotifications());

      // isSupported starts as false in initial state and is only set to true
      // when the useEffect runs and detects iOS native
      expect(result.current.isSupported).toBe(false);
    });

    it('should report isSupported=false when not ready', () => {
      mockUseCapacitor.mockReturnValue({
        isNative: true,
        platform: 'ios',
        isIOS: true,
        isAndroid: false,
        isIPad: false,
        isReady: false,
      });

      const { result } = renderHook(() => usePushNotifications());

      // Not ready yet, so support check hasn't run
      expect(result.current.isSupported).toBe(false);
    });
  });

  describe('initial state values', () => {
    it('should have permissionStatus=unknown initially', () => {
      const { result } = renderHook(() => usePushNotifications());

      expect(result.current.permissionStatus).toBe('unknown');
    });

    it('should have isRegistered=false initially', () => {
      const { result } = renderHook(() => usePushNotifications());

      expect(result.current.isRegistered).toBe(false);
    });

    it('should have isLoading=false initially', () => {
      const { result } = renderHook(() => usePushNotifications());

      expect(result.current.isLoading).toBe(false);
    });

    it('should have error=null initially', () => {
      const { result } = renderHook(() => usePushNotifications());

      expect(result.current.error).toBeNull();
    });
  });

  describe('actions', () => {
    it('should provide requestPermission function', () => {
      const { result } = renderHook(() => usePushNotifications());

      expect(result.current.requestPermission).toBeInstanceOf(Function);
    });

    it('should provide registerToken function', () => {
      const { result } = renderHook(() => usePushNotifications());

      expect(result.current.registerToken).toBeInstanceOf(Function);
    });

    it('should provide unregisterToken function', () => {
      const { result } = renderHook(() => usePushNotifications());

      expect(result.current.unregisterToken).toBeInstanceOf(Function);
    });

    it('should return false from requestPermission when not supported', async () => {
      const { result } = renderHook(() => usePushNotifications());

      const granted = await result.current.requestPermission();

      expect(granted).toBe(false);
    });

    it('should return false from registerToken when not supported', async () => {
      const { result } = renderHook(() => usePushNotifications());

      const registered = await result.current.registerToken();

      expect(registered).toBe(false);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const {
  mockAddListener,
  mockRegister,
  mockCheckPermissions,
  mockRequestPermissions,
  mockPost,
  mockDel,
} = vi.hoisted(() => ({
  mockAddListener: vi.fn(),
  mockRegister: vi.fn(),
  mockCheckPermissions: vi.fn(),
  mockRequestPermissions: vi.fn(),
  mockPost: vi.fn(),
  mockDel: vi.fn(),
}));

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    addListener: mockAddListener,
    register: mockRegister,
    checkPermissions: mockCheckPermissions,
    requestPermissions: mockRequestPermissions,
  },
}));

vi.mock('@/lib/auth/auth-fetch', () => ({ post: mockPost, del: mockDel }));

vi.mock('@/lib/analytics', () => ({
  getOrCreateDeviceId: () => 'device-abc',
  getDeviceName: () => 'Pixel 8',
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ isAuthenticated: true, user: { id: 'user-1' } }),
}));

type MockCapacitorState = {
  isNative: boolean;
  platform: 'ios' | 'android' | 'web';
  isIOS: boolean;
  isAndroid: boolean;
  isIPad: boolean;
  capabilities: { secureStore: boolean; nativeAuth: boolean; push: boolean; badge: boolean };
  isReady: boolean;
};

const ANDROID_STATE: MockCapacitorState = {
  isNative: true,
  platform: 'android',
  isIOS: false,
  isAndroid: true,
  isIPad: false,
  capabilities: { secureStore: true, nativeAuth: true, push: true, badge: true },
  isReady: true,
};

const WEB_STATE: MockCapacitorState = {
  isNative: false,
  platform: 'web',
  isIOS: false,
  isAndroid: false,
  isIPad: false,
  capabilities: { secureStore: false, nativeAuth: false, push: false, badge: false },
  isReady: true,
};

let mockCapacitorState: MockCapacitorState = ANDROID_STATE;

vi.mock('@/hooks/useCapacitor', () => ({
  useCapacitor: () => mockCapacitorState,
}));

import { usePushNotifications } from '../usePushNotifications';

/** The key usePushNotifications persists a refusal under. */
const DENIAL_KEY = 'push_permission_denied';

/**
 * Handlers captured from PushNotifications.addListener, keyed by event name.
 * Held as `unknown` because the four handlers take four different payloads;
 * each test narrows the one it fires.
 */
let listeners: Record<string, unknown>;

describe('usePushNotifications', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    listeners = {};
    mockCapacitorState = ANDROID_STATE;
    mockAddListener.mockImplementation(async (event: string, handler: unknown) => {
      listeners[event] = handler;
      return { remove: vi.fn() };
    });
    mockCheckPermissions.mockResolvedValue({ receive: 'prompt' });
    mockRequestPermissions.mockResolvedValue({ receive: 'granted' });
    mockRegister.mockResolvedValue(undefined);
    mockPost.mockResolvedValue({ success: true, tokenId: 't1' });
    mockDel.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports supported on Android — the gate is the push capability, not a platform equality check', async () => {
    const { result } = renderHook(() => usePushNotifications());

    await waitFor(() => expect(result.current.isSupported).toBe(true));
  });

  it('reports unsupported, and attaches no listeners, on a platform without the push capability', async () => {
    mockCapacitorState = WEB_STATE;

    const { result } = renderHook(() => usePushNotifications());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isSupported).toBe(false);
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('regression: attaches all four listeners BEFORE reporting supported, so nothing downstream can register into a missing registration listener', async () => {
    let releaseListeners: () => void = () => {};
    const attached = new Promise<void>((resolve) => {
      releaseListeners = resolve;
    });
    mockAddListener.mockImplementation(async (event: string, handler: unknown) => {
      listeners[event] = handler;
      await attached;
      return { remove: vi.fn() };
    });

    const { result } = renderHook(() => usePushNotifications());

    await waitFor(() => expect(mockAddListener).toHaveBeenCalledTimes(4));
    // All four addListener calls are in flight and none has resolved yet — if
    // isSupported were set first, a consumer could call register() here.
    expect(result.current.isSupported).toBe(false);

    await act(async () => {
      releaseListeners();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.isSupported).toBe(true));
    expect(Object.keys(listeners).sort()).toEqual([
      'pushNotificationActionPerformed',
      'pushNotificationReceived',
      'registration',
      'registrationError',
    ]);
  });

  it('posts the FCM token to the push-token endpoint with platform "android"', async () => {
    const { result } = renderHook(() => usePushNotifications());
    await waitFor(() => expect(result.current.isSupported).toBe(true));

    const onRegistration = listeners.registration as (token: { value: string }) => void;
    await act(async () => {
      onRegistration({ value: 'fcm-token-0123456789abcdef' });
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/notifications/push-tokens', {
        token: 'fcm-token-0123456789abcdef',
        platform: 'android',
        deviceId: 'device-abc',
        deviceName: 'Pixel 8',
      })
    );
  });

  it('regression: a rotated FCM token reaches the server — registration is tracked per token, not as a one-shot boolean', async () => {
    const { result } = renderHook(() => usePushNotifications());
    await waitFor(() => expect(result.current.isSupported).toBe(true));

    const onRegistration = listeners.registration as (token: { value: string }) => void;
    await act(async () => {
      onRegistration({ value: 'fcm-token-original' });
      await Promise.resolve();
    });
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));

    // FCM rotates the token while the hook stays mounted.
    await act(async () => {
      onRegistration({ value: 'fcm-token-rotated' });
      await Promise.resolve();
    });

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(mockPost).toHaveBeenLastCalledWith('/api/notifications/push-tokens', {
      token: 'fcm-token-rotated',
      platform: 'android',
      deviceId: 'device-abc',
      deviceName: 'Pixel 8',
    });
  });

  it('re-emitting the SAME token does not POST again', async () => {
    const { result } = renderHook(() => usePushNotifications());
    await waitFor(() => expect(result.current.isSupported).toBe(true));

    const onRegistration = listeners.registration as (token: { value: string }) => void;
    await act(async () => {
      onRegistration({ value: 'fcm-token-same' });
      await Promise.resolve();
    });
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));

    await act(async () => {
      onRegistration({ value: 'fcm-token-same' });
      await Promise.resolve();
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('records the refusal when the user denies, and does not register', async () => {
    mockRequestPermissions.mockResolvedValue({ receive: 'denied' });

    const { result } = renderHook(() => usePushNotifications());
    await waitFor(() => expect(result.current.isSupported).toBe(true));

    let granted: boolean | undefined;
    await act(async () => {
      granted = await result.current.requestPermission();
    });

    expect(granted).toBe(false);
    expect(localStorage.getItem(DENIAL_KEY)).toBe('android');
    expect(mockRegister).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.hasPreviouslyDenied).toBe(true));
  });

  it('regression: a recorded refusal survives a relaunch — the next mount never re-asks the OS', async () => {
    // Android reports 'prompt-with-rationale' on the launch after a refusal,
    // and the OS would still allow the dialog, so nothing native stops a
    // re-prompt here; only the recorded denial does.
    localStorage.setItem(DENIAL_KEY, 'android');
    mockCheckPermissions.mockResolvedValue({ receive: 'prompt-with-rationale' });

    const { result } = renderHook(() => usePushNotifications());
    await waitFor(() => expect(result.current.isSupported).toBe(true));
    await waitFor(() => expect(result.current.hasPreviouslyDenied).toBe(true));

    let granted: boolean | undefined;
    await act(async () => {
      granted = await result.current.requestPermission();
    });

    expect(granted).toBe(false);
    expect(mockRequestPermissions).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('an explicitly user-initiated retry can override the recorded refusal', async () => {
    localStorage.setItem(DENIAL_KEY, 'android');
    mockCheckPermissions.mockResolvedValue({ receive: 'prompt-with-rationale' });

    const { result } = renderHook(() => usePushNotifications());
    await waitFor(() => expect(result.current.isSupported).toBe(true));

    let granted: boolean | undefined;
    await act(async () => {
      granted = await result.current.requestPermission({ ignoreRecordedDenial: true });
    });

    expect(granted).toBe(true);
    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(DENIAL_KEY)).toBeNull();
  });

  it('drops the recorded refusal when the OS reports the permission granted (enabled from system settings)', async () => {
    localStorage.setItem(DENIAL_KEY, 'android');
    mockCheckPermissions.mockResolvedValue({ receive: 'granted' });

    const { result } = renderHook(() => usePushNotifications());

    await waitFor(() => expect(result.current.permissionStatus).toBe('granted'));
    expect(localStorage.getItem(DENIAL_KEY)).toBeNull();
    expect(result.current.hasPreviouslyDenied).toBe(false);
  });

  it('registerToken() with a recorded refusal falls through to requestPermission and stays blocked', async () => {
    localStorage.setItem(DENIAL_KEY, 'android');
    mockCheckPermissions.mockResolvedValue({ receive: 'prompt-with-rationale' });

    const { result } = renderHook(() => usePushNotifications());
    await waitFor(() => expect(result.current.isSupported).toBe(true));

    let registered: boolean | undefined;
    await act(async () => {
      registered = await result.current.registerToken();
    });

    expect(registered).toBe(false);
    expect(mockRegister).not.toHaveBeenCalled();
  });
});

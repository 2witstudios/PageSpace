import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';

const { mockUsePushNotifications, mockUseCapacitor } = vi.hoisted(() => ({
  mockUsePushNotifications: vi.fn(),
  mockUseCapacitor: vi.fn(),
}));

vi.mock('@/hooks/usePushNotifications', () => ({
  usePushNotifications: () => mockUsePushNotifications(),
}));

vi.mock('@/hooks/useCapacitor', () => ({
  useCapacitor: () => mockUseCapacitor(),
}));

import { PushNotificationManager } from '../PushNotificationManager';

const defaultPushState = {
  isSupported: true,
  permissionStatus: 'prompt' as const,
  isRegistered: false,
  isLoading: false,
  error: null,
  requestPermission: vi.fn().mockResolvedValue(true),
  registerToken: vi.fn().mockResolvedValue(true),
  unregisterToken: vi.fn().mockResolvedValue(undefined),
};

describe('PushNotificationManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseCapacitor.mockReturnValue({ isNative: true });
    mockUsePushNotifications.mockReturnValue({ ...defaultPushState });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('given non-native environment, should not call requestPermission or registerToken', async () => {
    mockUseCapacitor.mockReturnValue({ isNative: false });

    render(<PushNotificationManager />);

    expect(defaultPushState.requestPermission).not.toHaveBeenCalled();
    expect(defaultPushState.registerToken).not.toHaveBeenCalled();
  });

  it('given not supported, should not call requestPermission or registerToken', async () => {
    mockUsePushNotifications.mockReturnValue({
      ...defaultPushState,
      isSupported: false,
    });

    render(<PushNotificationManager />);

    expect(defaultPushState.requestPermission).not.toHaveBeenCalled();
    expect(defaultPushState.registerToken).not.toHaveBeenCalled();
  });

  it('given native + supported + permission prompt, should call requestPermission immediately', async () => {
    const requestPermission = vi.fn().mockResolvedValue(true);
    mockUsePushNotifications.mockReturnValue({
      ...defaultPushState,
      permissionStatus: 'prompt',
      requestPermission,
    });

    render(<PushNotificationManager />);

    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it('given native + supported + permission granted + not registered, should call registerToken immediately', async () => {
    const registerToken = vi.fn().mockResolvedValue(true);
    mockUsePushNotifications.mockReturnValue({
      ...defaultPushState,
      permissionStatus: 'granted',
      isRegistered: false,
      registerToken,
    });

    render(<PushNotificationManager />);

    expect(registerToken).toHaveBeenCalledOnce();
  });

  it('given native + supported + permission granted + already registered, should not call registerToken', async () => {
    const registerToken = vi.fn().mockResolvedValue(true);
    mockUsePushNotifications.mockReturnValue({
      ...defaultPushState,
      permissionStatus: 'granted',
      isRegistered: true,
      registerToken,
    });

    render(<PushNotificationManager />);

    expect(registerToken).not.toHaveBeenCalled();
    expect(defaultPushState.requestPermission).not.toHaveBeenCalled();
  });

  it('given permission denied, should not call requestPermission or registerToken', async () => {
    const requestPermission = vi.fn().mockResolvedValue(false);
    const registerToken = vi.fn().mockResolvedValue(false);
    mockUsePushNotifications.mockReturnValue({
      ...defaultPushState,
      permissionStatus: 'denied',
      requestPermission,
      registerToken,
    });

    render(<PushNotificationManager />);

    expect(requestPermission).not.toHaveBeenCalled();
    expect(registerToken).not.toHaveBeenCalled();
  });

  it('should render null (no DOM output)', () => {
    const { container } = render(<PushNotificationManager />);

    expect(container.firstChild).toBeNull();
  });

  it('regression: does not burn the attempt guard while permissionStatus is unknown, then prompts exactly once when it resolves to prompt', () => {
    const requestPermission = vi.fn().mockResolvedValue(true);
    mockUsePushNotifications.mockReturnValue({
      ...defaultPushState,
      permissionStatus: 'unknown',
      requestPermission,
    });

    const { rerender } = render(<PushNotificationManager />);
    expect(requestPermission).not.toHaveBeenCalled();

    mockUsePushNotifications.mockReturnValue({
      ...defaultPushState,
      permissionStatus: 'prompt',
      requestPermission,
    });
    rerender(<PushNotificationManager />);
    expect(requestPermission).toHaveBeenCalledOnce();

    // Further rerenders (e.g. unrelated state changes) must not re-trigger the prompt.
    rerender(<PushNotificationManager />);
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it('regression: denied never calls requestPermission or registerToken, even after transitioning through unknown', () => {
    const requestPermission = vi.fn().mockResolvedValue(false);
    const registerToken = vi.fn().mockResolvedValue(false);
    mockUsePushNotifications.mockReturnValue({
      ...defaultPushState,
      permissionStatus: 'unknown',
      requestPermission,
      registerToken,
    });

    const { rerender } = render(<PushNotificationManager />);
    expect(requestPermission).not.toHaveBeenCalled();

    mockUsePushNotifications.mockReturnValue({
      ...defaultPushState,
      permissionStatus: 'denied',
      requestPermission,
      registerToken,
    });
    rerender(<PushNotificationManager />);

    expect(requestPermission).not.toHaveBeenCalled();
    expect(registerToken).not.toHaveBeenCalled();
  });
});

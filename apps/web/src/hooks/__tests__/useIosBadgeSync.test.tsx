import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { mockBadgeSet, mockFetchNotifications } = vi.hoisted(() => ({
  mockBadgeSet: vi.fn().mockResolvedValue(undefined),
  mockFetchNotifications: vi.fn().mockResolvedValue(undefined),
}));

type MockCapacitorState = {
  isNative: boolean;
  platform: 'ios' | 'android' | 'web';
  isIOS: boolean;
  isAndroid: boolean;
  isIPad: boolean;
  isReady: boolean;
};

let mockCapacitorState: MockCapacitorState = {
  isNative: true,
  platform: 'ios',
  isIOS: true,
  isAndroid: false,
  isIPad: false,
  isReady: true,
};

// isCapacitorApp() is what useAppStateRecovery uses internally to pick its Capacitor
// vs. web resume path — forcing it false makes the test drive resume via
// document.visibilitychange (jsdom has no real Capacitor bridge to fire appStateChange).
vi.mock('@/hooks/useCapacitor', () => ({
  useCapacitor: () => mockCapacitorState,
  isCapacitorApp: () => false,
}));

vi.mock('@capawesome/capacitor-badge', () => ({
  Badge: { set: mockBadgeSet },
}));

import { useIosBadgeSync } from '../useIosBadgeSync';
import { useNotificationStore } from '@/stores/useNotificationStore';

/** Drive useAppStateRecovery's web visibilitychange resume path. */
const backgroundThenResume = async () => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });

  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
  });
};

describe('useIosBadgeSync', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockBadgeSet.mockResolvedValue(undefined);
    mockFetchNotifications.mockResolvedValue(undefined);
    mockCapacitorState = {
      isNative: true,
      platform: 'ios',
      isIOS: true,
      isAndroid: false,
      isIPad: false,
      isReady: true,
    };
    useNotificationStore.setState({
      notifications: [],
      unreadCount: 0,
      fetchNotifications: mockFetchNotifications,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never calls Badge.set when not on iOS', async () => {
    mockCapacitorState = { ...mockCapacitorState, isNative: false, platform: 'web', isIOS: false };
    useNotificationStore.setState({ unreadCount: 3 });

    renderHook(() => useIosBadgeSync());
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockBadgeSet).not.toHaveBeenCalled();
  });

  it('projects count 0 on mount when iOS and unreadCount is 0', async () => {
    renderHook(() => useIosBadgeSync());

    await waitFor(() => expect(mockBadgeSet).toHaveBeenCalledWith({ count: 0 }));
  });

  it('projects unreadCount 3 on mount', async () => {
    useNotificationStore.setState({ unreadCount: 3 });

    renderHook(() => useIosBadgeSync());

    await waitFor(() => expect(mockBadgeSet).toHaveBeenCalledWith({ count: 3 }));
  });

  it('re-projects when the count changes from 3 to 0', async () => {
    useNotificationStore.setState({ unreadCount: 3 });
    renderHook(() => useIosBadgeSync());
    await waitFor(() => expect(mockBadgeSet).toHaveBeenCalledWith({ count: 3 }));

    act(() => {
      useNotificationStore.getState().setUnreadCount(0);
    });

    await waitFor(() => expect(mockBadgeSet).toHaveBeenLastCalledWith({ count: 0 }));
  });

  it('on app resume, refreshes the store from the server and re-projects the refreshed count', async () => {
    useNotificationStore.setState({ unreadCount: 1 });
    renderHook(() => useIosBadgeSync());
    await waitFor(() => expect(mockBadgeSet).toHaveBeenCalledWith({ count: 1 }));

    mockFetchNotifications.mockImplementation(async () => {
      useNotificationStore.setState({ unreadCount: 5 });
    });

    await backgroundThenResume();

    expect(mockFetchNotifications).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockBadgeSet).toHaveBeenLastCalledWith({ count: 5 }));
  });

  it('swallows a Badge.set failure without throwing', async () => {
    mockBadgeSet.mockRejectedValueOnce(new Error('not supported on this device'));
    useNotificationStore.setState({ unreadCount: 2 });

    expect(() => renderHook(() => useIosBadgeSync())).not.toThrow();
    await waitFor(() => expect(mockBadgeSet).toHaveBeenCalledWith({ count: 2 }));
  });

  it('stops projecting after unmount', async () => {
    useNotificationStore.setState({ unreadCount: 1 });
    const { unmount } = renderHook(() => useIosBadgeSync());
    await waitFor(() => expect(mockBadgeSet).toHaveBeenCalledWith({ count: 1 }));

    unmount();
    mockBadgeSet.mockClear();

    act(() => {
      useNotificationStore.getState().setUnreadCount(9);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockBadgeSet).not.toHaveBeenCalled();
  });
});

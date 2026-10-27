import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { LegacyNotification } from '@pagespace/lib/notifications/types';

const { mockPush, mockHandleNotificationRead, mockToastDismiss } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockHandleNotificationRead: vi.fn().mockResolvedValue(undefined),
  mockToastDismiss: vi.fn(),
}));

let mockToastLevel: 'all' | 'mentions' | 'off' = 'all';
let mockIsLoadingPreferences = false;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('sonner', () => ({
  toast: {
    dismiss: mockToastDismiss,
  },
}));

vi.mock('@/hooks/useToastPreferences', () => ({
  useToastPreferences: () => ({
    level: mockToastLevel,
    isLoading: mockIsLoadingPreferences,
    updateLevel: vi.fn(),
  }),
}));

import { useDesktopNotifications } from '../useDesktopNotifications';
import { useNotificationStore } from '@/stores/useNotificationStore';

type TestNotification = LegacyNotification & { title: string; message: string };

function build(overrides: Partial<TestNotification> = {}): TestNotification {
  return {
    id: 'notif-1',
    userId: 'user-1',
    type: 'MENTION',
    title: 'You were mentioned',
    message: 'Jonathan mentioned you in "Roadmap"',
    isRead: false,
    createdAt: new Date(),
    metadata: { mentionerName: 'Jonathan', pageTitle: 'Roadmap', pageType: 'DOCUMENT' },
    pageId: 'page-1',
    driveId: 'drive-1',
    ...overrides,
  };
}

class MockNotification {
  static permission: NotificationPermission = 'granted';
  static instances: MockNotification[] = [];

  onclick: (() => void) | null = null;
  title: string;
  options?: NotificationOptions;
  close = vi.fn();

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    MockNotification.instances.push(this);
  }
}

describe('useDesktopNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToastLevel = 'all';
    mockIsLoadingPreferences = false;
    useNotificationStore.setState({
      notifications: [],
      unreadCount: 0,
      handleNotificationRead: mockHandleNotificationRead,
    });

    MockNotification.permission = 'granted';
    MockNotification.instances = [];
    // @ts-expect-error -- test stub replaces global Notification constructor
    global.Notification = MockNotification;

    // @ts-expect-error -- test stub for Electron desktop detection
    window.electron = { isDesktop: true };

    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    vi.spyOn(window, 'focus').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.electron;
    // @ts-expect-error -- cleanup test stub
    delete global.Notification;
  });

  it('does not construct a Notification when not on desktop', () => {
    delete window.electron;

    renderHook(() => useDesktopNotifications());

    act(() => {
      useNotificationStore.getState().addNotification(build());
    });

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('does not construct a Notification when permission is not granted', () => {
    MockNotification.permission = 'default';

    renderHook(() => useDesktopNotifications());

    act(() => {
      useNotificationStore.getState().addNotification(build());
    });

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('does not construct a Notification when the window is focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    renderHook(() => useDesktopNotifications());

    act(() => {
      useNotificationStore.getState().addNotification(build());
    });

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('constructs a Notification with title/body/tag when unfocused and eligible', () => {
    renderHook(() => useDesktopNotifications());

    act(() => {
      useNotificationStore.getState().addNotification(build());
    });

    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0].title).toBe('You were mentioned');
    expect(MockNotification.instances[0].options).toEqual({
      body: 'Jonathan mentioned you in "Roadmap"',
      tag: 'notif-1',
    });
  });

  it('constructs only once for the same id + same signature', () => {
    renderHook(() => useDesktopNotifications());

    const notification = build();

    act(() => {
      useNotificationStore.getState().addNotification(notification);
    });
    expect(MockNotification.instances).toHaveLength(1);

    act(() => {
      useNotificationStore.getState().setIsDropdownOpen(true);
    });

    expect(MockNotification.instances).toHaveLength(1);
  });

  it('constructs again for the same id when the signature changes (e.g. NEW_DIRECT_MESSAGE update-in-place)', () => {
    renderHook(() => useDesktopNotifications());

    const dm = build({
      id: 'notif-dm',
      type: 'NEW_DIRECT_MESSAGE',
      message: 'First message',
      metadata: { conversationId: 'conv-1', messageId: 'm1', senderId: 'sender-1' },
      pageId: null,
      driveId: null,
    });

    act(() => {
      useNotificationStore.getState().addNotification(dm);
    });

    act(() => {
      useNotificationStore.getState().addNotification({
        ...dm,
        message: 'Second message',
        createdAt: new Date(dm.createdAt.getTime() + 1000),
      });
    });

    expect(MockNotification.instances).toHaveLength(2);
  });

  it('regression: does not construct a Notification while the toast preference is still loading, even though the provisional level defaults to all', () => {
    mockIsLoadingPreferences = true;
    mockToastLevel = 'all';

    renderHook(() => useDesktopNotifications());

    act(() => {
      useNotificationStore.getState().addNotification(build());
    });

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('does not construct a Notification when the preference level is off', () => {
    mockToastLevel = 'off';

    renderHook(() => useDesktopNotifications());

    act(() => {
      useNotificationStore.getState().addNotification(build());
    });

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('on click: focuses the window, marks as read, navigates to the resolved destination, and dismisses the sibling toast', () => {
    renderHook(() => useDesktopNotifications());

    act(() => {
      useNotificationStore.getState().addNotification(build());
    });

    const instance = MockNotification.instances[0];

    act(() => {
      instance.onclick?.();
    });

    expect(window.focus).toHaveBeenCalled();
    expect(mockHandleNotificationRead).toHaveBeenCalledWith('notif-1');
    expect(mockPush).toHaveBeenCalledWith('/dashboard/drive-1/page-1');
    expect(instance.close).toHaveBeenCalled();
    expect(mockToastDismiss).toHaveBeenCalledWith('notif-1');
  });

  it('regression: on click, reads the LIVE store state rather than the stale closure — does not re-mark-read a notification already read via another surface (e.g. the sibling toast) before the click', () => {
    renderHook(() => useDesktopNotifications());

    act(() => {
      useNotificationStore.getState().addNotification(build());
    });

    const instance = MockNotification.instances[0];

    // Simulate the notification being marked read through another surface
    // (e.g. the in-app dropdown, or the sibling sonner toast) before the
    // user clicks the still-visible native OS notification.
    act(() => {
      useNotificationStore.setState((state) => ({
        notifications: state.notifications.map((n) =>
          n.id === 'notif-1' ? { ...n, isRead: true } : n
        ),
      }));
    });

    act(() => {
      instance.onclick?.();
    });

    expect(mockHandleNotificationRead).not.toHaveBeenCalled();
  });
});

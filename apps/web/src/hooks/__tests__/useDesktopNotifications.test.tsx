import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { LegacyNotification } from '@pagespace/lib/notifications/types';

const { mockPush } = vi.hoisted(() => ({
  mockPush: vi.fn(),
}));

let mockToastLevel: 'all' | 'mentions' | 'off' = 'all';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useToastPreferences', () => ({
  useToastPreferences: () => ({
    level: mockToastLevel,
    isLoading: false,
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

interface MockNotificationInstance {
  title: string;
  body?: string;
  tag?: string;
  onclick: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
}

let notificationInstances: MockNotificationInstance[];
let NotificationMock: ReturnType<typeof vi.fn>;

describe('useDesktopNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToastLevel = 'all';
    useNotificationStore.setState({ notifications: [], unreadCount: 0 });
    useNotificationStore.setState({ handleNotificationRead: vi.fn().mockResolvedValue(undefined) });

    notificationInstances = [];
    NotificationMock = vi.fn().mockImplementation((title: string, options?: { body?: string; tag?: string }) => {
      const instance: MockNotificationInstance = {
        title,
        body: options?.body,
        tag: options?.tag,
        onclick: null,
        close: vi.fn(),
      };
      notificationInstances.push(instance);
      return instance;
    });
    Object.defineProperty(NotificationMock, 'permission', { value: 'granted', configurable: true });
    // @ts-expect-error - test stub of the global Notification constructor
    global.Notification = NotificationMock;

    // @ts-expect-error - test stub of Electron's renderer bridge
    window.electron = { isDesktop: true };

    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    vi.spyOn(window, 'focus').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.electron;
    // @ts-expect-error - cleanup test stub
    delete global.Notification;
  });

  it('does not construct a Notification when not running in the desktop app', () => {
    delete window.electron;
    renderHook(() => useDesktopNotifications());

    act(() => {
      useNotificationStore.getState().addNotification(build());
    });

    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('does not construct a Notification when the window is focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    renderHook(() => useDesktopNotifications());

    act(() => {
      useNotificationStore.getState().addNotification(build());
    });

    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('constructs a Notification with title/body/tag when unfocused and eligible', () => {
    renderHook(() => useDesktopNotifications());

    act(() => {
      useNotificationStore.getState().addNotification(build());
    });

    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock).toHaveBeenCalledWith('You were mentioned', {
      body: 'Jonathan mentioned you in "Roadmap"',
      tag: 'notif-1',
    });
  });

  it('does not construct a second Notification for the same id and signature', () => {
    renderHook(() => useDesktopNotifications());

    const notification = build();

    act(() => {
      useNotificationStore.getState().addNotification(notification);
    });
    expect(NotificationMock).toHaveBeenCalledTimes(1);

    act(() => {
      useNotificationStore.getState().markAllAsRead();
    });

    expect(NotificationMock).toHaveBeenCalledTimes(1);
  });

  it('constructs a second Notification when the signature changes for the same id', () => {
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

    expect(NotificationMock).toHaveBeenCalledTimes(2);
  });

  it('does not construct a Notification when the preference level is off', () => {
    mockToastLevel = 'off';
    renderHook(() => useDesktopNotifications());

    act(() => {
      useNotificationStore.getState().addNotification(build());
    });

    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('on click: focuses the window, marks the notification read, navigates, and closes', () => {
    renderHook(() => useDesktopNotifications());

    act(() => {
      useNotificationStore.getState().addNotification(build());
    });

    const instance = notificationInstances[0];
    expect(instance.onclick).toBeTypeOf('function');

    act(() => {
      instance.onclick?.();
    });

    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(useNotificationStore.getState().handleNotificationRead).toHaveBeenCalledWith('notif-1');
    expect(mockPush).toHaveBeenCalledWith('/dashboard/drive-1/page-1');
    expect(instance.close).toHaveBeenCalledTimes(1);
  });
});

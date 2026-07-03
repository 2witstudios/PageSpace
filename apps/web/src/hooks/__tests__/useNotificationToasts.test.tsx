import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { LegacyNotification } from '@pagespace/lib/notifications/types';

const { mockPush, mockToastCustom, mockToastDismiss } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockToastCustom: vi.fn(),
  mockToastDismiss: vi.fn(),
}));

let mockPathname = '/dashboard/some-other-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => mockPathname,
}));

vi.mock('sonner', () => ({
  toast: {
    custom: mockToastCustom,
    dismiss: mockToastDismiss,
  },
}));

import { useNotificationToasts } from '../useNotificationToasts';
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

describe('useNotificationToasts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/dashboard/some-other-page';
    useNotificationStore.setState({ notifications: [], unreadCount: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a custom toast for a new eligible notification', () => {
    renderHook(() => useNotificationToasts());

    act(() => {
      useNotificationStore.getState().addNotification(build());
    });

    expect(mockToastCustom).toHaveBeenCalledTimes(1);
    expect(mockToastCustom.mock.calls[0][1]).toMatchObject({ id: 'notif-1' });
  });

  it('does not toast for excluded types', () => {
    renderHook(() => useNotificationToasts());

    act(() => {
      useNotificationStore.getState().addNotification(
        build({ id: 'notif-2', type: 'EMAIL_VERIFICATION_REQUIRED', metadata: { email: 'a@b.com' } }),
      );
    });

    expect(mockToastCustom).not.toHaveBeenCalled();
  });

  it('does not toast for TOS_PRIVACY_UPDATED', () => {
    renderHook(() => useNotificationToasts());

    act(() => {
      useNotificationStore.getState().addNotification(
        build({
          id: 'notif-3',
          type: 'TOS_PRIVACY_UPDATED',
          metadata: { documentType: 'tos', documentUrl: '/legal/tos', updatedAt: new Date().toISOString() },
        }),
      );
    });

    expect(mockToastCustom).not.toHaveBeenCalled();
  });

  it('does not toast when the user is already viewing the destination page', () => {
    mockPathname = '/dashboard/drive-1/page-1';
    renderHook(() => useNotificationToasts());

    act(() => {
      useNotificationStore.getState().addNotification(build());
    });

    expect(mockToastCustom).not.toHaveBeenCalled();
  });

  it('reuses the same toast id when a NEW_DIRECT_MESSAGE updates in place', () => {
    renderHook(() => useNotificationToasts());

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

    expect(mockToastCustom).toHaveBeenCalledTimes(2);
    expect(mockToastCustom.mock.calls[0][1]).toMatchObject({ id: 'notif-dm' });
    expect(mockToastCustom.mock.calls[1][1]).toMatchObject({ id: 'notif-dm' });
  });

  it('does not re-toast an identical notification for an unrelated store change', () => {
    renderHook(() => useNotificationToasts());

    const notification = build();

    act(() => {
      useNotificationStore.getState().addNotification(notification);
    });
    expect(mockToastCustom).toHaveBeenCalledTimes(1);

    act(() => {
      useNotificationStore.getState().setIsDropdownOpen(true);
    });

    expect(mockToastCustom).toHaveBeenCalledTimes(1);
  });
});

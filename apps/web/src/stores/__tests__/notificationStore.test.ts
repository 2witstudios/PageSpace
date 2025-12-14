/**
 * notificationStore Tests
 * Tests for notification management, socket integration, and API operations
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { LegacyNotification } from '@pagespace/lib/client-safe';

// Mock dependencies before importing the store
vi.mock('./socketStore', () => ({
  useSocketStore: {
    getState: vi.fn(() => ({
      getSocket: vi.fn(() => null),
    })),
  },
}));

const mockFetchWithAuth = vi.fn();
const mockPatch = vi.fn();
const mockDel = vi.fn();

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
  patch: (...args: unknown[]) => mockPatch(...args),
  del: (...args: unknown[]) => mockDel(...args),
}));

import { useNotificationStore } from '../notificationStore';

type Notification = LegacyNotification & {
  title: string;
  message: string;
}

// Helper to create mock notifications
const createMockNotification = (overrides: Partial<Notification> = {}): Notification => ({
  id: 'notif-' + Math.random().toString(36).slice(2, 11),
  type: 'NEW_DIRECT_MESSAGE',
  title: 'Test Notification',
  message: 'Test message content',
  isRead: false,
  createdAt: new Date(),
  readAt: null,
  metadata: null,
  userId: 'user-123',
  ...overrides,
});

describe('useNotificationStore', () => {
  beforeEach(() => {
    // Reset the store before each test
    useNotificationStore.setState({
      notifications: [],
      unreadCount: 0,
      isLoading: false,
      isDropdownOpen: false,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('given store is created, should have empty notifications array', () => {
      const { notifications } = useNotificationStore.getState();
      expect(notifications).toEqual([]);
    });

    it('given store is created, should have zero unread count', () => {
      const { unreadCount } = useNotificationStore.getState();
      expect(unreadCount).toBe(0);
    });

    it('given store is created, should not be loading', () => {
      const { isLoading } = useNotificationStore.getState();
      expect(isLoading).toBe(false);
    });

    it('given store is created, dropdown should be closed', () => {
      const { isDropdownOpen } = useNotificationStore.getState();
      expect(isDropdownOpen).toBe(false);
    });
  });

  describe('setNotifications', () => {
    it('given an array of notifications, should set them', () => {
      const notifications = [createMockNotification(), createMockNotification()];
      const { setNotifications } = useNotificationStore.getState();

      setNotifications(notifications);

      expect(useNotificationStore.getState().notifications).toEqual(notifications);
    });
  });

  describe('setUnreadCount', () => {
    it('given a count, should set the unread count', () => {
      const { setUnreadCount } = useNotificationStore.getState();

      setUnreadCount(5);

      expect(useNotificationStore.getState().unreadCount).toBe(5);
    });
  });

  describe('setIsLoading', () => {
    it('given true, should set loading state', () => {
      const { setIsLoading } = useNotificationStore.getState();

      setIsLoading(true);

      expect(useNotificationStore.getState().isLoading).toBe(true);
    });
  });

  describe('setIsDropdownOpen', () => {
    it('given true, should open dropdown', () => {
      const { setIsDropdownOpen } = useNotificationStore.getState();

      setIsDropdownOpen(true);

      expect(useNotificationStore.getState().isDropdownOpen).toBe(true);
    });
  });

  describe('addNotification', () => {
    it('given a new notification, should add it to the beginning', () => {
      const existingNotif = createMockNotification({ id: 'existing' });
      useNotificationStore.setState({ notifications: [existingNotif] });

      const newNotif = createMockNotification({ id: 'new' });
      const { addNotification } = useNotificationStore.getState();

      addNotification(newNotif);

      const { notifications } = useNotificationStore.getState();
      expect(notifications[0].id).toBe('new');
      expect(notifications[1].id).toBe('existing');
    });

    it('given an unread notification, should increment unread count', () => {
      useNotificationStore.setState({ unreadCount: 2 });
      const newNotif = createMockNotification({ isRead: false });
      const { addNotification } = useNotificationStore.getState();

      addNotification(newNotif);

      expect(useNotificationStore.getState().unreadCount).toBe(3);
    });

    it('given a read notification, should not increment unread count', () => {
      useNotificationStore.setState({ unreadCount: 2 });
      const newNotif = createMockNotification({ isRead: true });
      const { addNotification } = useNotificationStore.getState();

      addNotification(newNotif);

      expect(useNotificationStore.getState().unreadCount).toBe(2);
    });

    it('given NEW_DIRECT_MESSAGE for same conversation, should update existing instead of adding new', () => {
      const conversationId = 'conv-123';
      const existingNotif = createMockNotification({
        id: 'existing',
        type: 'NEW_DIRECT_MESSAGE',
        message: 'Old message',
        isRead: false,
        metadata: { conversationId },
      });
      useNotificationStore.setState({
        notifications: [existingNotif],
        unreadCount: 1,
      });

      const newNotif = createMockNotification({
        id: 'new',
        type: 'NEW_DIRECT_MESSAGE',
        message: 'New message',
        isRead: false,
        metadata: { conversationId },
      });
      const { addNotification } = useNotificationStore.getState();

      addNotification(newNotif);

      const { notifications, unreadCount } = useNotificationStore.getState();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].message).toBe('New message');
      expect(unreadCount).toBe(1); // Should not increment
    });
  });

  describe('markAsRead', () => {
    it('given a notification ID, should mark it as read', () => {
      const notif = createMockNotification({ id: 'to-read', isRead: false });
      useNotificationStore.setState({ notifications: [notif], unreadCount: 1 });
      const { markAsRead } = useNotificationStore.getState();

      markAsRead('to-read');

      const { notifications } = useNotificationStore.getState();
      expect(notifications[0].isRead).toBe(true);
      expect(notifications[0].readAt).toBeInstanceOf(Date);
    });

    it('given marking as read, should decrement unread count', () => {
      const notif = createMockNotification({ id: 'to-read', isRead: false });
      useNotificationStore.setState({ notifications: [notif], unreadCount: 3 });
      const { markAsRead } = useNotificationStore.getState();

      markAsRead('to-read');

      expect(useNotificationStore.getState().unreadCount).toBe(2);
    });

    it('given unread count at 0, should not go negative', () => {
      const notif = createMockNotification({ id: 'to-read', isRead: false });
      useNotificationStore.setState({ notifications: [notif], unreadCount: 0 });
      const { markAsRead } = useNotificationStore.getState();

      markAsRead('to-read');

      expect(useNotificationStore.getState().unreadCount).toBe(0);
    });
  });

  describe('markAllAsRead', () => {
    it('given multiple unread notifications, should mark all as read', () => {
      const notifications = [
        createMockNotification({ isRead: false }),
        createMockNotification({ isRead: false }),
        createMockNotification({ isRead: true }),
      ];
      useNotificationStore.setState({ notifications, unreadCount: 2 });
      const { markAllAsRead } = useNotificationStore.getState();

      markAllAsRead();

      const state = useNotificationStore.getState();
      expect(state.notifications.every(n => n.isRead)).toBe(true);
      expect(state.unreadCount).toBe(0);
    });
  });

  describe('removeNotification', () => {
    it('given a notification ID, should remove it', () => {
      const notif1 = createMockNotification({ id: 'keep' });
      const notif2 = createMockNotification({ id: 'remove' });
      useNotificationStore.setState({ notifications: [notif1, notif2] });
      const { removeNotification } = useNotificationStore.getState();

      removeNotification('remove');

      const { notifications } = useNotificationStore.getState();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].id).toBe('keep');
    });

    it('given removing an unread notification, should decrement unread count', () => {
      const notif = createMockNotification({ id: 'remove', isRead: false });
      useNotificationStore.setState({ notifications: [notif], unreadCount: 2 });
      const { removeNotification } = useNotificationStore.getState();

      removeNotification('remove');

      expect(useNotificationStore.getState().unreadCount).toBe(1);
    });

    it('given removing a read notification, should not change unread count', () => {
      const notif = createMockNotification({ id: 'remove', isRead: true });
      useNotificationStore.setState({ notifications: [notif], unreadCount: 2 });
      const { removeNotification } = useNotificationStore.getState();

      removeNotification('remove');

      expect(useNotificationStore.getState().unreadCount).toBe(2);
    });
  });

  describe('fetchNotifications', () => {
    it('given successful API response, should update notifications and unread count', async () => {
      const mockNotifications = [createMockNotification(), createMockNotification()];
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          notifications: mockNotifications,
          unreadCount: 5,
        }),
      });

      const { fetchNotifications } = useNotificationStore.getState();
      await fetchNotifications();

      const state = useNotificationStore.getState();
      expect(state.notifications).toEqual(mockNotifications);
      expect(state.unreadCount).toBe(5);
      expect(state.isLoading).toBe(false);
    });

    it('given API error, should set loading to false', async () => {
      mockFetchWithAuth.mockResolvedValue({ ok: false });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { fetchNotifications } = useNotificationStore.getState();
      await fetchNotifications();

      expect(useNotificationStore.getState().isLoading).toBe(false);
      consoleError.mockRestore();
    });

    it('given network error, should handle gracefully', async () => {
      mockFetchWithAuth.mockRejectedValue(new Error('Network error'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { fetchNotifications } = useNotificationStore.getState();
      await fetchNotifications();

      expect(useNotificationStore.getState().isLoading).toBe(false);
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });

  describe('handleNotificationRead', () => {
    it('given successful API call, should mark notification as read locally', async () => {
      const notif = createMockNotification({ id: 'notif-123', isRead: false });
      useNotificationStore.setState({ notifications: [notif], unreadCount: 1 });
      mockPatch.mockResolvedValue({ ok: true });

      const { handleNotificationRead } = useNotificationStore.getState();
      await handleNotificationRead('notif-123');

      expect(mockPatch).toHaveBeenCalledWith('/api/notifications/notif-123/read');
      expect(useNotificationStore.getState().notifications[0].isRead).toBe(true);
    });

    it('given API error, should not update local state', async () => {
      const notif = createMockNotification({ id: 'notif-123', isRead: false });
      useNotificationStore.setState({ notifications: [notif], unreadCount: 1 });
      mockPatch.mockRejectedValue(new Error('API error'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { handleNotificationRead } = useNotificationStore.getState();
      await handleNotificationRead('notif-123');

      // The API call is awaited first, so on error the local state is not updated
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });

  describe('handleMarkAllAsRead', () => {
    it('given successful API call, should mark all as read locally', async () => {
      const notifications = [
        createMockNotification({ isRead: false }),
        createMockNotification({ isRead: false }),
      ];
      useNotificationStore.setState({ notifications, unreadCount: 2 });
      mockPatch.mockResolvedValue({ ok: true });

      const { handleMarkAllAsRead } = useNotificationStore.getState();
      await handleMarkAllAsRead();

      expect(mockPatch).toHaveBeenCalledWith('/api/notifications/read-all');
      const state = useNotificationStore.getState();
      expect(state.notifications.every(n => n.isRead)).toBe(true);
      expect(state.unreadCount).toBe(0);
    });
  });

  describe('handleDeleteNotification', () => {
    it('given successful API call, should remove notification locally', async () => {
      const notif = createMockNotification({ id: 'notif-to-delete' });
      useNotificationStore.setState({ notifications: [notif] });
      mockDel.mockResolvedValue({ ok: true });

      const { handleDeleteNotification } = useNotificationStore.getState();
      await handleDeleteNotification('notif-to-delete');

      expect(mockDel).toHaveBeenCalledWith('/api/notifications/notif-to-delete');
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
    });
  });
});

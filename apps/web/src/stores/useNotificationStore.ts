import { create } from 'zustand';
import { useSocketStore } from './useSocketStore';
import type { LegacyNotification } from '@pagespace/lib/client-safe';
import { patch, del, fetchWithAuth } from '@/lib/auth/auth-fetch';

// Use LegacyNotification type for backward compatibility
type Notification = LegacyNotification & {
  title: string;
  message: string;
}

interface NotificationStore {
  notifications: Notification[];
  unreadCount: number;
  isLoading: boolean;
  isDropdownOpen: boolean;
  
  setNotifications: (notifications: Notification[]) => void;
  setUnreadCount: (count: number) => void;
  setIsLoading: (loading: boolean) => void;
  setIsDropdownOpen: (open: boolean) => void;
  
  addNotification: (notification: Notification) => void;
  markAsRead: (notificationId: string) => void;
  markAllAsRead: () => void;
  removeNotification: (notificationId: string) => void;
  
  fetchNotifications: () => Promise<void>;
  handleNotificationRead: (notificationId: string) => Promise<void>;
  handleMarkAllAsRead: () => Promise<void>;
  handleDeleteNotification: (notificationId: string) => Promise<void>;
  
  initializeSocketListeners: () => void;
  cleanupSocketListeners: () => void;
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: [],
  unreadCount: 0,
  isLoading: false,
  isDropdownOpen: false,
  
  setNotifications: (notifications) => set({ notifications }),
  setUnreadCount: (count) => set({ unreadCount: count }),
  setIsLoading: (loading) => set({ isLoading: loading }),
  setIsDropdownOpen: (open) => set({ isDropdownOpen: open }),
  
  addNotification: (notification) => set((state) => {
    // Check if we already have a notification for the same conversation
    if (notification.type === 'NEW_DIRECT_MESSAGE' &&
        notification.metadata &&
        typeof notification.metadata === 'object' &&
        'conversationId' in notification.metadata) {

      const conversationId = notification.metadata.conversationId;
      const existingIndex = state.notifications.findIndex(n =>
        n.type === 'NEW_DIRECT_MESSAGE' &&
        !n.isRead &&
        n.metadata &&
        typeof n.metadata === 'object' &&
        'conversationId' in n.metadata &&
        n.metadata.conversationId === conversationId
      );

      if (existingIndex !== -1) {
        // Update existing notification
        const updatedNotifications = [...state.notifications];
        updatedNotifications[existingIndex] = {
          ...updatedNotifications[existingIndex],
          message: notification.message,
          createdAt: notification.createdAt,
        };

        // Sort by createdAt to bring updated notification to top
        updatedNotifications.sort((a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

        return {
          notifications: updatedNotifications,
          unreadCount: state.unreadCount, // Count stays the same
        };
      }
    }

    // Add new notification if not updating existing
    return {
      notifications: [notification, ...state.notifications],
      unreadCount: state.unreadCount + (notification.isRead ? 0 : 1),
    };
  }),
  
  markAsRead: (notificationId) => set((state) => ({
    notifications: state.notifications.map(n => 
      n.id === notificationId ? { ...n, isRead: true, readAt: new Date() } : n
    ),
    unreadCount: Math.max(0, state.unreadCount - 1),
  })),
  
  markAllAsRead: () => set((state) => ({
    notifications: state.notifications.map(n => ({ ...n, isRead: true, readAt: new Date() })),
    unreadCount: 0,
  })),
  
  removeNotification: (notificationId) => set((state) => {
    const notification = state.notifications.find(n => n.id === notificationId);
    return {
      notifications: state.notifications.filter(n => n.id !== notificationId),
      unreadCount: notification && !notification.isRead 
        ? Math.max(0, state.unreadCount - 1) 
        : state.unreadCount,
    };
  }),
  
  fetchNotifications: async () => {
    const { setIsLoading, setNotifications, setUnreadCount } = get();
    setIsLoading(true);

    try {
      const response = await fetchWithAuth('/api/notifications');

      if (response.ok) {
        const data = await response.json();
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
      }
    } catch (error) {
      console.error('Failed to fetch notifications:', error);
    } finally {
      setIsLoading(false);
    }
  },
  
  handleNotificationRead: async (notificationId) => {
    const { markAsRead } = get();

    try {
      await patch(`/api/notifications/${notificationId}/read`);
      markAsRead(notificationId);
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
    }
  },
  
  handleMarkAllAsRead: async () => {
    const { markAllAsRead } = get();

    try {
      await patch('/api/notifications/read-all');
      markAllAsRead();
    } catch (error) {
      console.error('Failed to mark all notifications as read:', error);
    }
  },
  
  handleDeleteNotification: async (notificationId) => {
    const { removeNotification } = get();

    try {
      await del(`/api/notifications/${notificationId}`);
      removeNotification(notificationId);
    } catch (error) {
      console.error('Failed to delete notification:', error);
    }
  },
  
  initializeSocketListeners: () => {
    const socket = useSocketStore.getState().getSocket();
    if (!socket) return;
    
    const { addNotification } = get();
    
    // Listen for new notifications
    socket.on('notification:new', (notification: Notification) => {
      console.log('New notification received:', notification);
      addNotification(notification);
    });
  },
  
  cleanupSocketListeners: () => {
    const socket = useSocketStore.getState().getSocket();
    if (!socket) return;
    
    socket.off('notification:new');
  },
}));
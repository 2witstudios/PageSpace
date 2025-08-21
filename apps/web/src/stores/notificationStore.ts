import { create } from 'zustand';
import { useSocketStore } from './socketStore';

interface Notification {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  isRead: boolean;
  createdAt: Date;
  readAt?: Date | null;
  pageId?: string | null;
  driveId?: string | null;
  triggeredByUserId?: string | null;
  triggeredByUser?: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  } | null;
  drive?: {
    id: string;
    slug: string;
    name: string;
  } | null;
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
  
  addNotification: (notification) => set((state) => ({
    notifications: [notification, ...state.notifications],
    unreadCount: state.unreadCount + (notification.isRead ? 0 : 1),
  })),
  
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
      const response = await fetch('/api/notifications', {
        credentials: 'include',
      });
      
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
      const response = await fetch(`/api/notifications/${notificationId}/read`, {
        method: 'PATCH',
        credentials: 'include',
      });
      
      if (response.ok) {
        markAsRead(notificationId);
      }
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
    }
  },
  
  handleMarkAllAsRead: async () => {
    const { markAllAsRead } = get();
    
    try {
      const response = await fetch('/api/notifications/read-all', {
        method: 'PATCH',
        credentials: 'include',
      });
      
      if (response.ok) {
        markAllAsRead();
      }
    } catch (error) {
      console.error('Failed to mark all notifications as read:', error);
    }
  },
  
  handleDeleteNotification: async (notificationId) => {
    const { removeNotification } = get();
    
    try {
      const response = await fetch(`/api/notifications/${notificationId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      
      if (response.ok) {
        removeNotification(notificationId);
      }
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
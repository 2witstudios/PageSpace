'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCheck,
  Inbox,
  Clock,
  ArrowLeft,
  Bell,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { useSocketStore } from '@/stores/useSocketStore';
import { isConnectionRequest } from '@pagespace/lib/notifications/guards';
import { type LegacyNotification } from '@pagespace/lib/notifications/types';
import { patch } from '@/lib/auth/auth-fetch';
import { PullToRefresh } from '@/components/ui/pull-to-refresh';
import { CustomScrollArea } from '@/components/ui/custom-scroll-area';
import { NotificationItem } from '@/components/notifications/NotificationItem';
import { getNotificationIcon } from '@/components/notifications/notificationIcons';

type StoredNotification = LegacyNotification & { title: string; message: string };

function formatTypeLabel(type: string): string {
  return type.replace(/_/g, ' ').toLowerCase();
}

export default function NotificationsPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [selectedType, setSelectedType] = useState<string | null>(null);

  const notifications = useNotificationStore((state) => state.notifications);
  const isLoading = useNotificationStore((state) => state.isLoading);
  const fetchNotifications = useNotificationStore((state) => state.fetchNotifications);
  const handleNotificationRead = useNotificationStore((state) => state.handleNotificationRead);
  const handleMarkAllAsRead = useNotificationStore((state) => state.handleMarkAllAsRead);
  const handleDeleteNotification = useNotificationStore((state) => state.handleDeleteNotification);
  const initializeSocketListeners = useNotificationStore((state) => state.initializeSocketListeners);
  const cleanupSocketListeners = useNotificationStore((state) => state.cleanupSocketListeners);

  const connectionStatus = useSocketStore((state) => state.connectionStatus);

  useEffect(() => {
    fetchNotifications();

    if (connectionStatus === 'connected') {
      initializeSocketListeners();
    }

    return () => {
      cleanupSocketListeners();
    };
  }, [connectionStatus, fetchNotifications, initializeSocketListeners, cleanupSocketListeners]);

  const filteredNotifications = useMemo(() => {
    let filtered = notifications;

    if (filter === 'unread') {
      filtered = filtered.filter((n) => !n.isRead);
    }

    if (selectedType) {
      filtered = filtered.filter((n) => n.type === selectedType);
    }

    return filtered;
  }, [notifications, filter, selectedType]);

  const groupedNotifications = useMemo(() => {
    const groups: Record<string, StoredNotification[]> = {
      Today: [],
      Yesterday: [],
      'This Week': [],
      'This Month': [],
      Older: [],
    };

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(today);
    monthAgo.setMonth(monthAgo.getMonth() - 1);

    filteredNotifications.forEach((notification) => {
      const notifDate = new Date(notification.createdAt);
      if (notifDate >= today) {
        groups.Today.push(notification);
      } else if (notifDate >= yesterday) {
        groups.Yesterday.push(notification);
      } else if (notifDate >= weekAgo) {
        groups['This Week'].push(notification);
      } else if (notifDate >= monthAgo) {
        groups['This Month'].push(notification);
      } else {
        groups.Older.push(notification);
      }
    });

    return Object.entries(groups).filter(([, items]) => items.length > 0);
  }, [filteredNotifications]);

  const unreadCount = notifications.filter((n) => !n.isRead).length;
  const notificationTypes = [...new Set(notifications.map((n) => n.type))];

  const handleSelect = (notification: StoredNotification) => {
    if (!notification.isRead) {
      handleNotificationRead(notification.id);
    }
    if (notification.drive?.id) {
      router.push(`/dashboard/${notification.drive.id}`);
    }
  };

  const handleConnectionAction = async (
    connectionId: string,
    action: 'accept' | 'reject',
    notificationId: string,
  ) => {
    try {
      await patch(`/api/connections/${connectionId}`, { action });
      const { notifications: storeNotifications, updateNotification } =
        useNotificationStore.getState();
      const stale = storeNotifications.find((n) => n.id === notificationId);
      if (stale) {
        updateNotification(notificationId, {
          isRead: true,
          metadata: {
            ...(stale.metadata as Record<string, unknown>),
            actioned: true,
            actionedStatus: action === 'accept' ? 'accepted' : 'rejected',
          },
        });
      }
    } catch (error) {
      console.error(`Error ${action}ing connection:`, error);
    }
  };

  const handleRefresh = useCallback(async () => {
    await fetchNotifications();
  }, [fetchNotifications]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b bg-card">
        <div className="container mx-auto max-w-6xl px-4 py-4">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.back()}
              className="shrink-0"
            >
              <ArrowLeft className="size-5" />
            </Button>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <Bell className="size-6" />
                <h1 className="text-2xl font-bold">Notifications</h1>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Stay updated on changes to your shared content and permissions
              </p>
            </div>
          </div>
        </div>
      </div>

      <PullToRefresh direction="top" onRefresh={handleRefresh}>
        <CustomScrollArea className="flex-1">
          <div className="container mx-auto max-w-6xl px-4 py-6">
            <div className="flex flex-col gap-6">
              <Card className="flex-1">
                <CardHeader className="pb-4">
                  <div className="flex items-center justify-between">
                    <Tabs value={filter} onValueChange={(v) => setFilter(v as 'all' | 'unread')}>
                      <TabsList>
                        <TabsTrigger value="all">
                          All
                          {notifications.length > 0 && (
                            <Badge variant="secondary" className="ml-2">
                              {notifications.length}
                            </Badge>
                          )}
                        </TabsTrigger>
                        <TabsTrigger value="unread">
                          Unread
                          {unreadCount > 0 && (
                            <Badge variant="destructive" className="ml-2">
                              {unreadCount}
                            </Badge>
                          )}
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>

                    {unreadCount > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleMarkAllAsRead}
                      >
                        <CheckCheck className="mr-2 size-4" />
                        Mark all as read
                      </Button>
                    )}
                  </div>

                  {notificationTypes.length > 1 && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        variant={selectedType === null ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setSelectedType(null)}
                      >
                        All types
                      </Button>
                      {notificationTypes.map((type) => {
                        const Icon = getNotificationIcon(type);
                        return (
                          <Button
                            key={type}
                            variant={selectedType === type ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setSelectedType(type)}
                          >
                            <Icon className="size-4" aria-hidden />
                            <span className="ml-2">{formatTypeLabel(type)}</span>
                          </Button>
                        );
                      })}
                    </div>
                  )}
                </CardHeader>

                <CardContent className="p-0">
                  <ScrollArea className="h-[600px]">
                    {isLoading ? (
                      <div className="p-8 text-center text-muted-foreground">
                        Loading notifications...
                      </div>
                    ) : filteredNotifications.length === 0 ? (
                      <div className="p-8 text-center">
                        <Inbox className="mx-auto mb-4 size-12 text-muted-foreground/50" />
                        <p className="text-muted-foreground">
                          {filter === 'unread'
                            ? "You're all caught up! No unread notifications."
                            : selectedType
                              ? `No ${formatTypeLabel(selectedType)} notifications.`
                              : 'No notifications yet.'}
                        </p>
                      </div>
                    ) : (
                      <div className="px-4 pb-4">
                        {groupedNotifications.map(([group, items]) => (
                          <div key={group} className="mb-6">
                            <div className="mb-3 flex items-center gap-2">
                              <Clock className="size-4 text-muted-foreground" />
                              <h3 className="text-sm font-medium text-muted-foreground">
                                {group}
                              </h3>
                              <Separator className="flex-1" />
                            </div>

                            <div className="space-y-1">
                              {items.map((notification) => (
                                <NotificationItem
                                  key={notification.id}
                                  notification={notification}
                                  variant="page"
                                  onSelect={() => handleSelect(notification)}
                                  onDismiss={() => handleDeleteNotification(notification.id)}
                                  onAccept={
                                    isConnectionRequest(notification) && !notification.metadata.actioned
                                      ? () =>
                                          handleConnectionAction(
                                            notification.metadata.connectionId,
                                            'accept',
                                            notification.id,
                                          )
                                      : undefined
                                  }
                                  onDecline={
                                    isConnectionRequest(notification) && !notification.metadata.actioned
                                      ? () =>
                                          handleConnectionAction(
                                            notification.metadata.connectionId,
                                            'reject',
                                            notification.id,
                                          )
                                      : undefined
                                  }
                                />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>
          </div>
        </CustomScrollArea>
      </PullToRefresh>
    </div>
  );
}

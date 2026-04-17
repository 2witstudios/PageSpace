'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { Bell, CheckCheck, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { isConnectionRequest, type LegacyNotification } from '@pagespace/lib/client-safe';
import { patch } from '@/lib/auth/auth-fetch';
import { NotificationItem } from './NotificationItem';

type StoredNotification = LegacyNotification & { title: string; message: string };

function resolveDestination(notification: StoredNotification): string | null {
  if (notification.type === 'EMAIL_VERIFICATION_REQUIRED') {
    return '/settings/account';
  }

  if (
    notification.type === 'TOS_PRIVACY_UPDATED' &&
    notification.metadata &&
    typeof notification.metadata === 'object' &&
    'documentUrl' in notification.metadata &&
    typeof notification.metadata.documentUrl === 'string'
  ) {
    return notification.metadata.documentUrl;
  }

  if (
    notification.type === 'NEW_DIRECT_MESSAGE' &&
    notification.metadata &&
    typeof notification.metadata === 'object' &&
    'conversationId' in notification.metadata &&
    typeof notification.metadata.conversationId === 'string'
  ) {
    return `/dashboard/inbox/dm/${notification.metadata.conversationId}`;
  }

  if (
    (notification.type === 'MENTION' || notification.type === 'TASK_ASSIGNED') &&
    notification.pageId &&
    notification.driveId
  ) {
    return `/dashboard/${notification.driveId}/${notification.pageId}`;
  }

  if (notification.drive?.id) {
    return `/dashboard/${notification.drive.id}`;
  }

  return null;
}

export default function NotificationDropdown() {
  const router = useRouter();
  const notifications = useNotificationStore((state) => state.notifications);
  const isLoading = useNotificationStore((state) => state.isLoading);
  const handleNotificationRead = useNotificationStore((state) => state.handleNotificationRead);
  const handleMarkAllAsRead = useNotificationStore((state) => state.handleMarkAllAsRead);
  const handleDeleteNotification = useNotificationStore((state) => state.handleDeleteNotification);
  const setIsDropdownOpen = useNotificationStore((state) => state.setIsDropdownOpen);

  const handleConnectionAction = async (
    connectionId: string,
    action: 'accept' | 'reject',
    notificationId: string,
  ) => {
    try {
      await patch(`/api/connections/${connectionId}`, { action });
      handleDeleteNotification(notificationId);
      toast.success(
        action === 'accept'
          ? 'Connection request accepted successfully!'
          : 'Connection request declined.',
      );
    } catch (error) {
      console.error(`Error ${action}ing connection:`, error);
      toast.error(`Failed to ${action} connection request. Please try again.`);
    }
  };

  const groupedNotifications = useMemo(() => {
    const groups: Record<string, StoredNotification[]> = {
      Today: [],
      Yesterday: [],
      'This Week': [],
      Older: [],
    };

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    notifications.forEach((notification) => {
      const notifDate = new Date(notification.createdAt);
      if (notifDate >= today) {
        groups.Today.push(notification);
      } else if (notifDate >= yesterday) {
        groups.Yesterday.push(notification);
      } else if (notifDate >= weekAgo) {
        groups['This Week'].push(notification);
      } else {
        groups.Older.push(notification);
      }
    });

    return Object.entries(groups).filter(([, items]) => items.length > 0);
  }, [notifications]);

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  const handleSelect = (notification: StoredNotification) => {
    if (!notification.isRead) {
      handleNotificationRead(notification.id);
    }
    const destination = resolveDestination(notification);
    if (destination) {
      setIsDropdownOpen(false);
      router.push(destination);
    }
  };

  return (
    <div className="flex h-[500px] flex-col overflow-hidden">
      <div className="shrink-0 border-b p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Notifications</h3>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleMarkAllAsRead}
              className="text-xs"
            >
              <CheckCheck className="mr-1 size-3" />
              Mark all as read
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        {isLoading ? (
          <div className="p-4 text-center text-muted-foreground">
            Loading notifications...
          </div>
        ) : notifications.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            <Bell className="mx-auto mb-4 size-12 opacity-20" />
            <p>No notifications yet</p>
            <p className="mt-2 text-sm">
              You&apos;ll see notifications here when someone shares content with you
              or changes your permissions.
            </p>
          </div>
        ) : (
          <div className="p-1.5">
            {groupedNotifications.map(([group, items]) => (
              <div key={group}>
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                  {group}
                </div>
                <div className="space-y-0.5">
                  {items.map((notification) => (
                    <NotificationItem
                      key={notification.id}
                      notification={notification}
                      variant="dropdown"
                      onSelect={() => handleSelect(notification)}
                      onDismiss={() => handleDeleteNotification(notification.id)}
                      onAccept={
                        isConnectionRequest(notification)
                          ? () =>
                              handleConnectionAction(
                                notification.metadata.connectionId,
                                'accept',
                                notification.id,
                              )
                          : undefined
                      }
                      onDecline={
                        isConnectionRequest(notification)
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

      <Separator className="shrink-0" />
      <div className="shrink-0 p-2">
        <Link href="/notifications" className="w-full">
          <Button
            variant="ghost"
            className="w-full justify-between"
            size="sm"
            onClick={() => setIsDropdownOpen(false)}
          >
            <span className="text-sm">View all notifications</span>
            <ChevronRight className="size-4" />
          </Button>
        </Link>
      </div>
    </div>
  );
}

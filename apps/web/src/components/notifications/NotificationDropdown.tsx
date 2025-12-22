'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  X,
  FileText,
  Share2,
  UserPlus,
  UserCheck,
  Shield,
  Users,
  ChevronRight,
  CheckCheck,
  Bell,
  MessageCircle,
  Mail
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { cn } from '@/lib/utils';
import { isConnectionRequest } from '@pagespace/lib/client-safe';
import { patch } from '@/lib/auth/auth-fetch';

const NotificationIcon = ({ type }: { type: string }) => {
  switch (type) {
    case 'PAGE_SHARED':
    case 'PERMISSION_GRANTED':
      return <Share2 className="h-4 w-4" />;
    case 'PERMISSION_UPDATED':
      return <Shield className="h-4 w-4" />;
    case 'PERMISSION_REVOKED':
      return <X className="h-4 w-4" />;
    case 'DRIVE_INVITED':
      return <UserPlus className="h-4 w-4" />;
    case 'CONNECTION_REQUEST':
      return <UserPlus className="h-4 w-4" />;
    case 'CONNECTION_ACCEPTED':
      return <UserCheck className="h-4 w-4" />;
    case 'CONNECTION_REJECTED':
      return <X className="h-4 w-4" />;
    case 'NEW_DIRECT_MESSAGE':
      return <MessageCircle className="h-4 w-4" />;
    case 'EMAIL_VERIFICATION_REQUIRED':
      return <Mail className="h-4 w-4" />;
    case 'TOS_PRIVACY_UPDATED':
      return <FileText className="h-4 w-4" />;
    case 'DRIVE_JOINED':
    case 'DRIVE_ROLE_CHANGED':
      return <Users className="h-4 w-4" />;
    default:
      return <FileText className="h-4 w-4" />;
  }
};

export default function NotificationDropdown() {
  const router = useRouter();
  const {
    notifications,
    isLoading,
    handleNotificationRead,
    handleMarkAllAsRead,
    handleDeleteNotification,
    setIsDropdownOpen,
  } = useNotificationStore();

  const handleConnectionAction = async (connectionId: string, action: 'accept' | 'reject', notificationId: string) => {
    try {
      await patch(`/api/connections/${connectionId}`, { action });

      // Remove the notification immediately for visual feedback
      handleDeleteNotification(notificationId);

      // Show success message
      const message = action === 'accept'
        ? 'Connection request accepted successfully!'
        : 'Connection request declined.';

      toast.success(message);
    } catch (error) {
      console.error(`Error ${action}ing connection:`, error);
      toast.error(`Failed to ${action} connection request. Please try again.`);
    }
  };

  const groupedNotifications = useMemo(() => {
    const groups: Record<string, typeof notifications> = {
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

    notifications.forEach(notification => {
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

  const unreadCount = notifications.filter(n => !n.isRead).length;

  return (
    <div className="flex flex-col h-[500px] overflow-hidden">
      <div className="p-4 border-b shrink-0">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Notifications</h3>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleMarkAllAsRead}
              className="text-xs"
            >
              <CheckCheck className="h-3 w-3 mr-1" />
              Mark all as read
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0 overflow-hidden">
        {isLoading ? (
          <div className="p-4 text-center text-muted-foreground">
            Loading notifications...
          </div>
        ) : notifications.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            <Bell className="h-12 w-12 mx-auto mb-4 opacity-20" />
            <p>No notifications yet</p>
            <p className="text-sm mt-2">
              You&apos;ll see notifications here when someone shares content with you
              or changes your permissions.
            </p>
          </div>
        ) : (
          <div className="p-2">
            {groupedNotifications.map(([group, items]) => (
              <div key={group}>
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                  {group}
                </div>
                {items.map((notification) => (
                  <div
                    key={notification.id}
                    className={cn(
                      "group relative px-3 py-3 hover:bg-accent rounded-md cursor-pointer transition-colors",
                      !notification.isRead && "bg-accent/50"
                    )}
                    onClick={() => {
                      if (!notification.isRead) {
                        handleNotificationRead(notification.id);
                      }

                      // Navigate based on notification type
                      if (notification.type === 'EMAIL_VERIFICATION_REQUIRED') {
                        // Navigate to account settings
                        setIsDropdownOpen(false);
                        router.push('/settings/account');
                      } else if (notification.type === 'TOS_PRIVACY_UPDATED' &&
                          notification.metadata &&
                          typeof notification.metadata === 'object' &&
                          'documentUrl' in notification.metadata &&
                          typeof notification.metadata.documentUrl === 'string') {
                        // Navigate to the TOS or Privacy page
                        setIsDropdownOpen(false);
                        router.push(notification.metadata.documentUrl);
                      } else if (notification.type === 'NEW_DIRECT_MESSAGE' &&
                          notification.metadata &&
                          typeof notification.metadata === 'object' &&
                          'conversationId' in notification.metadata) {
                        // Navigate to the direct message conversation
                        setIsDropdownOpen(false);
                        router.push(`/dashboard/messages/${notification.metadata.conversationId}`);
                      } else if (notification.drive?.id) {
                        // Navigate to drive if available
                        setIsDropdownOpen(false);
                        router.push(`/dashboard/${notification.drive.id}`);
                      }
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <div className={cn(
                        "mt-1 p-2 rounded-full",
                        !notification.isRead ? "bg-primary/10" : "bg-muted"
                      )}>
                        <NotificationIcon type={notification.type} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={cn(
                          "text-sm",
                          !notification.isRead && "font-medium"
                        )}>
                          {notification.title}
                        </p>
                        <p className="text-sm text-muted-foreground mt-1">
                          {notification.message}
                        </p>
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true })}
                          </span>
                          {notification.triggeredByUser && (
                            <>
                              <span className="text-xs text-muted-foreground">•</span>
                              <span className="text-xs text-muted-foreground">
                                by {notification.triggeredByUser.name}
                              </span>
                            </>
                          )}
                        </div>
                        {isConnectionRequest(notification) && (
                          <div className="flex gap-2 mt-3" onClick={(e) => e.stopPropagation()}>
                            <Button
                              size="sm"
                              variant="default"
                              className="h-7"
                              onClick={() => handleConnectionAction(
                                notification.metadata.connectionId,
                                'accept',
                                notification.id
                              )}
                            >
                              Accept
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7"
                              onClick={() => handleConnectionAction(
                                notification.metadata.connectionId,
                                'reject',
                                notification.id
                              )}
                            >
                              Decline
                            </Button>
                          </div>
                        )}
                      </div>
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteNotification(notification.id);
                          }}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    {!notification.isRead && (
                      <div className="absolute left-1 top-1/2 -translate-y-1/2 w-2 h-2 bg-primary rounded-full" />
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      <Separator className="shrink-0" />
      <div className="p-2 shrink-0">
        <Link href="/notifications" className="w-full">
          <Button 
            variant="ghost" 
            className="w-full justify-between" 
            size="sm"
            onClick={() => setIsDropdownOpen(false)}
          >
            <span className="text-sm">View all notifications</span>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </Link>
      </div>
    </div>
  );
}
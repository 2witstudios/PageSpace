'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import {
  X,
  FileText,
  Share2,
  UserPlus,
  UserCheck,
  Shield,
  Users,
  CheckCheck,
  Inbox,
  Clock,
  ArrowLeft,
  Bell
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { useSocketStore } from '@/stores/useSocketStore';
import { isConnectionRequest } from '@pagespace/lib/client-safe';
import { patch } from '@/lib/auth/auth-fetch';
import { PullToRefresh } from '@/components/ui/pull-to-refresh';
import { CustomScrollArea } from '@/components/ui/custom-scroll-area';

const NotificationIcon = ({ type, size = 'default' }: { type: string; size?: 'default' | 'large' }) => {
  const sizeClass = size === 'large' ? 'h-5 w-5' : 'h-4 w-4';

  switch (type) {
    case 'PAGE_SHARED':
    case 'PERMISSION_GRANTED':
      return <Share2 className={sizeClass} />;
    case 'PERMISSION_UPDATED':
      return <Shield className={sizeClass} />;
    case 'PERMISSION_REVOKED':
      return <X className={sizeClass} />;
    case 'DRIVE_INVITED':
      return <UserPlus className={sizeClass} />;
    case 'CONNECTION_REQUEST':
      return <UserPlus className={sizeClass} />;
    case 'CONNECTION_ACCEPTED':
      return <UserCheck className={sizeClass} />;
    case 'CONNECTION_REJECTED':
      return <X className={sizeClass} />;
    case 'DRIVE_JOINED':
    case 'DRIVE_ROLE_CHANGED':
      return <Users className={sizeClass} />;
    default:
      return <FileText className={sizeClass} />;
  }
};

const NotificationTypeLabel = ({ type }: { type: string }) => {
  const getTypeInfo = () => {
    switch (type) {
      case 'PAGE_SHARED':
      case 'PERMISSION_GRANTED':
        return { label: 'Shared', color: 'bg-blue-500/10 text-blue-500' };
      case 'PERMISSION_UPDATED':
        return { label: 'Updated', color: 'bg-amber-500/10 text-amber-500' };
      case 'PERMISSION_REVOKED':
        return { label: 'Revoked', color: 'bg-red-500/10 text-red-500' };
      case 'DRIVE_INVITED':
        return { label: 'Added', color: 'bg-purple-500/10 text-purple-500' };
      case 'CONNECTION_REQUEST':
        return { label: 'Connection', color: 'bg-purple-500/10 text-purple-500' };
      case 'CONNECTION_ACCEPTED':
        return { label: 'Accepted', color: 'bg-green-500/10 text-green-500' };
      case 'CONNECTION_REJECTED':
        return { label: 'Rejected', color: 'bg-red-500/10 text-red-500' };
      case 'DRIVE_JOINED':
        return { label: 'Joined', color: 'bg-green-500/10 text-green-500' };
      case 'DRIVE_ROLE_CHANGED':
        return { label: 'Role Changed', color: 'bg-indigo-500/10 text-indigo-500' };
      default:
        return { label: 'Notification', color: 'bg-gray-500/10 text-gray-500' };
    }
  };

  const { label, color } = getTypeInfo();
  return <Badge variant="secondary" className={cn("text-xs", color)}>{label}</Badge>;
};

export default function NotificationsPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [selectedType, setSelectedType] = useState<string | null>(null);
  
  const {
    notifications,
    isLoading,
    fetchNotifications,
    handleNotificationRead,
    handleMarkAllAsRead,
    handleDeleteNotification,
    initializeSocketListeners,
    cleanupSocketListeners,
  } = useNotificationStore();
  
  const { connectionStatus } = useSocketStore();

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
      filtered = filtered.filter(n => !n.isRead);
    }
    
    if (selectedType) {
      filtered = filtered.filter(n => n.type === selectedType);
    }
    
    return filtered;
  }, [notifications, filter, selectedType]);

  const groupedNotifications = useMemo(() => {
    const groups: Record<string, typeof notifications> = {
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

    filteredNotifications.forEach(notification => {
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

  const unreadCount = notifications.filter(n => !n.isRead).length;
  const notificationTypes = [...new Set(notifications.map(n => n.type))];

  const handleNotificationClick = (notification: typeof notifications[0]) => {
    if (!notification.isRead) {
      handleNotificationRead(notification.id);
    }
    if (notification.drive?.id) {
      router.push(`/dashboard/${notification.drive.id}`);
    }
  };

  const handleConnectionAction = async (connectionId: string, action: 'accept' | 'reject', notificationId: string) => {
    try {
      await patch(`/api/connections/${connectionId}`, { action });

      // Mark notification as read
      handleNotificationRead(notificationId);

      // Refresh the notifications list
      window.location.reload();
    } catch (error) {
      console.error(`Error ${action}ing connection:`, error);
    }
  };

  const handleRefresh = useCallback(async () => {
    await fetchNotifications();
  }, [fetchNotifications]);

  return (
    <div className="h-full flex flex-col">
      {/* Header with Back Button */}
      <div className="border-b bg-card">
        <div className="container mx-auto px-4 py-4 max-w-6xl">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.back()}
              className="shrink-0"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <Bell className="h-6 w-6" />
                <h1 className="text-2xl font-bold">Notifications</h1>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Stay updated on changes to your shared content and permissions
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <PullToRefresh
        direction="top"
        onRefresh={handleRefresh}
      >
        <CustomScrollArea className="flex-1">
          <div className="container mx-auto py-6 px-4 max-w-6xl">
            <div className="flex flex-col gap-6">

          <div className="flex flex-col md:flex-row gap-4">
          <Card className="flex-1">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
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
                </div>
                
                {unreadCount > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleMarkAllAsRead}
                  >
                    <CheckCheck className="h-4 w-4 mr-2" />
                    Mark all as read
                  </Button>
                )}
              </div>

              {notificationTypes.length > 1 && (
                <div className="flex gap-2 mt-4 flex-wrap">
                  <Button
                    variant={selectedType === null ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedType(null)}
                  >
                    All types
                  </Button>
                  {notificationTypes.map(type => (
                    <Button
                      key={type}
                      variant={selectedType === type ? "default" : "outline"}
                      size="sm"
                      onClick={() => setSelectedType(type)}
                    >
                      <NotificationIcon type={type} />
                      <span className="ml-2">{type.replace(/_/g, ' ').toLowerCase()}</span>
                    </Button>
                  ))}
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
                    <Inbox className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
                    <p className="text-muted-foreground">
                      {filter === 'unread' 
                        ? "You're all caught up! No unread notifications."
                        : selectedType 
                          ? `No ${selectedType.replace(/_/g, ' ').toLowerCase()} notifications.`
                          : "No notifications yet."}
                    </p>
                  </div>
                ) : (
                  <div className="px-6 pb-4">
                    {groupedNotifications.map(([group, items]) => (
                      <div key={group} className="mb-6">
                        <div className="flex items-center gap-2 mb-3">
                          <Clock className="h-4 w-4 text-muted-foreground" />
                          <h3 className="text-sm font-medium text-muted-foreground">
                            {group}
                          </h3>
                          <Separator className="flex-1" />
                        </div>
                        
                        <div className="space-y-2">
                          {items.map((notification) => (
                            <Card
                              key={notification.id}
                              className={cn(
                                "group cursor-pointer transition-all hover:shadow-md",
                                !notification.isRead && "border-primary/50 bg-accent/30"
                              )}
                              onClick={() => handleNotificationClick(notification)}
                            >
                              <CardContent className="p-4">
                                <div className="flex items-start gap-4">
                                  <div className={cn(
                                    "p-2.5 rounded-full shrink-0",
                                    !notification.isRead ? "bg-primary/10" : "bg-muted"
                                  )}>
                                    <NotificationIcon type={notification.type} size="large" />
                                  </div>
                                  
                                  <div className="flex-1 min-w-0 space-y-1">
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="space-y-1">
                                        <p className={cn(
                                          "text-sm",
                                          !notification.isRead && "font-semibold"
                                        )}>
                                          {notification.title}
                                        </p>
                                        <p className="text-sm text-muted-foreground">
                                          {notification.message}
                                        </p>
                                      </div>
                                      <NotificationTypeLabel type={notification.type} />
                                    </div>
                                    
                                    <div className="flex items-center gap-3 pt-2">
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
                                      {notification.drive && (
                                        <>
                                          <span className="text-xs text-muted-foreground">•</span>
                                          <span className="text-xs text-primary">
                                            {notification.drive.name}
                                          </span>
                                        </>
                                      )}
                                    </div>

                                    {isConnectionRequest(notification) && (
                                      <div className="flex gap-2 mt-3" onClick={(e) => e.stopPropagation()}>
                                        <Button
                                          size="sm"
                                          variant="default"
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

                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDeleteNotification(notification.id);
                                    }}
                                  >
                                    <X className="h-4 w-4" />
                                  </Button>
                                </div>
                                
                                {!notification.isRead && (
                                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r" />
                                )}
                              </CardContent>
                            </Card>
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
          </div>
        </CustomScrollArea>
      </PullToRefresh>
    </div>
  );
}
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Settings, X } from 'lucide-react';
import { Button } from '@/retained/components/ui/button';
import { ScrollArea } from '@/retained/components/ui/scroll-area';
import {
  isShownNotification,
  groupForBell,
  notificationHref,
  type StoredNotification,
} from '@/retained/lib/notifications/notification-groups';
import { isConnectionRequest } from '@pagespace/lib/notifications/guards';
import { NotificationItem } from './notification-item';
import { useNotificationFeed } from './use-notification-feed';

export type NotificationDropdownProps = {
  /** Closes the popover that holds this list. */
  readonly onClose: () => void;
};

/**
 * The bell's popover body (C-Shell-Notifications): "Notifications", Mark all as read while anything
 * is unread, the settings gear and Close; Today / Yesterday / Older rows; View all notifications.
 * Ported from apps/web's NotificationDropdown, with the board's three groups.
 */
export default function NotificationDropdown({ onClose }: NotificationDropdownProps) {
  const router = useRouter();
  const feed = useNotificationFeed();
  const shown = feed.notifications.filter(isShownNotification);
  const unread = shown.filter((notification) => !notification.isRead).length;
  const groups = groupForBell(shown);

  const open = (notification: StoredNotification) => {
    if (!notification.isRead) void feed.markRead(notification.id);
    const href = notificationHref(notification);
    if (href === null) return;
    onClose();
    router.push(href);
  };

  return (
    <div className="flex max-h-[640px] w-[400px] max-w-[90vw] flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b py-0 pr-2 pl-4">
        <span className="flex-1 font-semibold">Notifications</span>
        {unread > 0 ? (
          <Button variant="ghost" size="sm" className="text-xs text-primary" onClick={() => void feed.markAll()}>
            Mark all as read
          </Button>
        ) : null}
        <Link
          href="/account/notifications"
          aria-label="Notification settings"
          title="Notification settings"
          onClick={onClose}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
        >
          <Settings className="size-3.5" aria-hidden />
        </Link>
        <Button variant="ghost" size="icon" aria-label="Close" title="Close" className="size-7" onClick={onClose}>
          <X className="size-3" aria-hidden />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {feed.isLoading && shown.length === 0 ? (
          <p className="p-4 text-center text-muted-foreground">Loading notifications...</p>
        ) : groups.length === 0 ? (
          <p className="p-8 text-center text-muted-foreground">No notifications yet</p>
        ) : (
          <div className="p-1.5">
            {groups.map(([label, items]) => (
              <section key={label} aria-label={label}>
                <div className="px-2.5 pt-2.5 pb-1 text-xs font-medium text-muted-foreground">{label}</div>
                {items.map((notification) => (
                  <NotificationItem
                    key={notification.id}
                    notification={notification}
                    variant="dropdown"
                    onSelect={() => open(notification)}
                    onAccept={isConnectionRequest(notification) ? () => void feed.respond(notification, 'accept') : undefined}
                    onDecline={isConnectionRequest(notification) ? () => void feed.respond(notification, 'reject') : undefined}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </ScrollArea>

      <div className="shrink-0 border-t p-2">
        <Link
          href="/notifications"
          onClick={onClose}
          className="flex h-8 w-full items-center justify-center rounded-md text-sm hover:bg-accent"
        >
          View all notifications
        </Link>
      </div>
    </div>
  );
}

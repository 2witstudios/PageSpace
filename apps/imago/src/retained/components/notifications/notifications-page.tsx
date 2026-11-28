'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCheck, RefreshCw } from 'lucide-react';
import { isConnectionRequest } from '@pagespace/lib/notifications/guards';
import { Button } from '@/retained/components/ui/button';
import { ScrollArea } from '@/retained/components/ui/scroll-area';
import {
  formatTypeLabel,
  groupForPage,
  isShownNotification,
  notificationHref,
  type StoredNotification,
} from '@/retained/lib/notifications/notification-groups';
import { cn } from '@/retained/lib/utils';
import { NotificationItem } from './notification-item';
import { useNotificationFeed } from './use-notification-feed';

type Filter = 'all' | 'unread';

const tabClass = (on: boolean) =>
  cn('inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs', on ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground');

const chipClass = (on: boolean) =>
  cn('h-7 rounded-full border px-2.5 text-xs', on ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-foreground');

const emptyCopy = (filter: Filter, type: string | null): string => {
  if (filter === 'unread') return 'You’re all caught up! No unread notifications.';
  if (type !== null) return `No ${formatTypeLabel(type)} notifications.`;
  return 'No notifications yet.';
};

/**
 * The full notifications page (C-Notifications), ported from apps/web's app/notifications/page.tsx
 * onto classic's retained primitives: All / Unread, Mark all as read, Refresh, a type filter, the
 * grouped rows, and Accept / Decline on connection requests. Rows whose types the board hides
 * (wallet cap, skipped automation) are left out here as in the popover.
 */
export default function NotificationsPage() {
  const router = useRouter();
  const feed = useNotificationFeed();
  const [filter, setFilter] = useState<Filter>('all');
  const [type, setType] = useState<string | null>(null);

  const shown = useMemo(() => feed.notifications.filter(isShownNotification), [feed.notifications]);
  const unread = shown.filter((notification) => !notification.isRead).length;
  const types = useMemo(() => [...new Set(shown.map((notification) => notification.type))], [shown]);
  const visible = shown.filter(
    (notification) => (filter === 'all' || !notification.isRead) && (type === null || notification.type === type),
  );
  const groups = groupForPage(visible);

  const open = (notification: StoredNotification) => {
    if (!notification.isRead) void feed.markRead(notification.id);
    const href = notificationHref(notification);
    if (href !== null) router.push(href);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <div role="tablist" aria-label="Show" className="flex rounded-lg bg-muted p-0.5">
          <button type="button" role="tab" aria-selected={filter === 'all'} className={tabClass(filter === 'all')} onClick={() => setFilter('all')}>
            All
            <span className="rounded-full bg-background px-1.5 text-[11px]">{shown.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={filter === 'unread'} className={tabClass(filter === 'unread')} onClick={() => setFilter('unread')}>
            Unread
            {unread > 0 ? (
              <span className="rounded-full bg-destructive px-1.5 text-[11px] text-white">{unread}</span>
            ) : null}
          </button>
        </div>
        <div className="flex-1" />
        {unread > 0 ? (
          <Button variant="outline" size="sm" onClick={() => void feed.markAll()}>
            <CheckCheck className="size-4" aria-hidden />
            Mark all as read
          </Button>
        ) : null}
        <Button variant="ghost" size="icon" aria-label="Refresh" title="Refresh" onClick={() => void feed.refresh()}>
          <RefreshCw className="size-4" aria-hidden />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl px-8 pt-8 pb-16">
          <div className="mb-2 text-xs text-muted-foreground">Every drive · {unread > 0 ? `${unread} unread` : 'all read'}</div>
          <h1 className="mb-4 text-3xl font-bold tracking-tight">Notifications</h1>

          <div role="group" aria-label="Filter by type" className="mb-6 flex flex-wrap gap-1.5">
            <button type="button" aria-pressed={type === null} className={chipClass(type === null)} onClick={() => setType(null)}>
              All types
            </button>
            {types.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={type === value}
                className={chipClass(type === value)}
                onClick={() => setType(value)}
              >
                {formatTypeLabel(value)}
              </button>
            ))}
          </div>

          {feed.isLoading && shown.length === 0 ? (
            <p className="py-14 text-center text-sm text-muted-foreground">Loading notifications...</p>
          ) : groups.length === 0 ? (
            <p className="py-14 text-center text-sm text-muted-foreground">{emptyCopy(filter, type)}</p>
          ) : (
            groups.map(([label, items]) => (
              <section key={label} aria-label={label} className="mb-6">
                <h2 className="mb-2 text-xs font-medium text-muted-foreground">{label}</h2>
                <div className="flex flex-col gap-0.5">
                  {items.map((notification) => (
                    <NotificationItem
                      key={notification.id}
                      notification={notification}
                      variant="page"
                      onSelect={() => open(notification)}
                      onDismiss={() => void feed.dismiss(notification.id)}
                      onAccept={isConnectionRequest(notification) ? () => void feed.respond(notification, 'accept') : undefined}
                      onDecline={isConnectionRequest(notification) ? () => void feed.respond(notification, 'reject') : undefined}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

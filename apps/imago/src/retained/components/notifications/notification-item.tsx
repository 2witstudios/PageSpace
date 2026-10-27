'use client';

import { formatDistanceToNow } from 'date-fns';
import { X } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { isConnectionRequest } from '@pagespace/lib/notifications/guards';
import { Button } from '@/retained/components/ui/button';
import { cn } from '@/retained/lib/utils';
import type { StoredNotification } from '@/retained/lib/notifications/notification-groups';
import { getNotificationIcon } from './notification-icons';

export type NotificationItemVariant = 'dropdown' | 'page';

export type NotificationItemProps = {
  readonly notification: StoredNotification;
  /** The bell's popover is denser and shows no drive; the page names the drive. */
  readonly variant: NotificationItemVariant;
  /** Opens the row. Without it the row is static text. */
  readonly onSelect?: () => void;
  /** Present on the page only: its × removes the row. */
  readonly onDismiss?: () => void;
  readonly onAccept?: () => void;
  readonly onDecline?: () => void;
};

/**
 * One notification row, ported from apps/web's NotificationItem onto classic's retained
 * primitives. The row's text is its own button, so the Accept, Decline and × controls never
 * nest inside an interactive element.
 */
export function NotificationItem({ notification, variant, onSelect, onDismiss, onAccept, onDecline }: NotificationItemProps) {
  const Icon = getNotificationIcon(notification.type);
  const isUnread = !notification.isRead;
  const timestamp = formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true });
  const by = notification.triggeredByUser?.name ?? null;
  const driveName = variant === 'page' ? (notification.drive?.name ?? null) : null;
  const connection = isConnectionRequest(notification);
  const actioned = connection && Boolean(notification.metadata?.actioned);
  const showActions = connection && !actioned && onAccept !== undefined && onDecline !== undefined;
  const actionedLabel = notification.metadata?.actionedStatus === 'accepted' ? 'Accepted' : 'Declined';

  const meta: ReactNode = (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      <time dateTime={new Date(notification.createdAt).toISOString()}>{timestamp}</time>
      {by ? (
        <>
          <span aria-hidden>·</span>
          <span>by {by}</span>
        </>
      ) : null}
      {driveName ? (
        <>
          <span aria-hidden>·</span>
          <span className="text-foreground">{driveName}</span>
        </>
      ) : null}
    </div>
  );

  const copy: ReactNode = (
    <>
      <p className={cn('truncate text-sm leading-5', isUnread ? 'font-semibold text-foreground' : 'font-medium text-foreground')}>
        {notification.title}
      </p>
      <p className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">{notification.message}</p>
      {meta}
    </>
  );

  const stop = (event: MouseEvent, handler?: () => void) => {
    event.stopPropagation();
    handler?.();
  };

  return (
    <article
      data-notification-type={notification.type}
      data-unread={isUnread}
      data-variant={variant}
      className={cn(
        'group relative flex items-start gap-3 rounded-md px-3 py-2.5 transition-colors',
        isUnread && 'bg-accent/40',
        onSelect && 'hover:bg-accent',
      )}
    >
      <span
        aria-label={isUnread ? 'Unread' : undefined}
        aria-hidden={isUnread ? undefined : true}
        className={cn('mt-2 size-2 shrink-0 rounded-full bg-primary', isUnread ? 'opacity-100' : 'opacity-0')}
      />
      <div
        aria-hidden
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground',
          isUnread && 'bg-primary/10 text-primary',
        )}
      >
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        {onSelect ? (
          <button type="button" onClick={onSelect} className="block w-full min-w-0 cursor-pointer text-left">
            {copy}
          </button>
        ) : (
          copy
        )}
        {showActions ? (
          <div className="mt-3 flex gap-2" onClick={(event) => event.stopPropagation()}>
            <Button size="sm" className="h-7" onClick={(event) => stop(event, onAccept)}>
              Accept
            </Button>
            <Button size="sm" variant="outline" className="h-7" onClick={(event) => stop(event, onDecline)}>
              Decline
            </Button>
          </div>
        ) : null}
        {actioned ? <p className="mt-2 text-xs font-medium text-muted-foreground">{actionedLabel}</p> : null}
      </div>
      {onDismiss ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Dismiss notification"
          title="Dismiss"
          className="size-8 shrink-0 text-muted-foreground"
          onClick={(event) => stop(event, onDismiss)}
        >
          <X className="size-4" aria-hidden />
        </Button>
      ) : null}
    </article>
  );
}

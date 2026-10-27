'use client';

import { formatDistanceToNow } from 'date-fns';
import { X } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { LegacyNotification } from '@pagespace/lib/notifications/types';
import { isConnectionRequest } from '@pagespace/lib/notifications/guards';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getNotificationIcon } from './notificationIcons';

export type NotificationItemVariant = 'dropdown' | 'page';

export interface NotificationItemProps {
  notification: LegacyNotification & { title: string; message: string };
  variant?: NotificationItemVariant;
  onSelect?: () => void;
  onDismiss?: () => void;
  onAccept?: () => void;
  onDecline?: () => void;
}

const iconWrapClasses = {
  dropdown: 'size-9',
  page: 'size-10',
} as const;

const containerClasses = {
  dropdown: 'px-3 py-2.5',
  page: 'px-4 py-3.5',
} as const;

export function NotificationItem({
  notification,
  variant = 'dropdown',
  onSelect,
  onDismiss,
  onAccept,
  onDecline,
}: NotificationItemProps) {
  const Icon = getNotificationIcon(notification.type);
  const isUnread = !notification.isRead;
  const timestamp = formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true });
  const triggeredByName = notification.triggeredByUser?.name ?? null;
  const driveName = variant === 'page' ? notification.drive?.name ?? null : null;
  const isInteractive = Boolean(onSelect);
  const showConnectionActions =
    isConnectionRequest(notification) && !notification.metadata?.actioned && onAccept && onDecline;
  const showActionedStatus =
    isConnectionRequest(notification) && Boolean(notification.metadata?.actioned);

  const handleActionClick = (event: MouseEvent<HTMLButtonElement>, handler?: () => void) => {
    event.stopPropagation();
    handler?.();
  };

  return (
    <article
      data-testid="notification-item"
      data-notification-type={notification.type}
      data-unread={isUnread}
      data-variant={variant}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (!isInteractive) return;
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect?.();
        }
      }}
      className={cn(
        'group relative grid grid-cols-[0.5rem_auto_1fr_auto] items-start gap-x-3 gap-y-1 rounded-md border border-transparent bg-card text-card-foreground transition-colors',
        containerClasses[variant],
        isInteractive && 'cursor-pointer hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isUnread && 'bg-accent/40',
      )}
    >
      <span
        aria-hidden
        data-testid="notification-unread-dot"
        className={cn(
          'mt-2 size-2 rounded-full bg-primary transition-opacity',
          isUnread ? 'opacity-100' : 'opacity-0',
        )}
      />

      <div
        className={cn(
          'flex items-center justify-center rounded-full bg-muted text-muted-foreground',
          iconWrapClasses[variant],
          isUnread && 'bg-primary/10 text-primary',
          isInteractive && 'group-hover:text-accent-foreground',
        )}
      >
        <Icon className="size-4" aria-hidden />
      </div>

      <div className="min-w-0">
        <p
          className={cn(
            'truncate text-sm leading-5',
            isUnread ? 'font-semibold text-foreground' : 'font-medium text-foreground',
          )}
        >
          {notification.title}
        </p>
        <p className={cn('mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground', isInteractive && 'group-hover:text-accent-foreground')}>
          {notification.message}
        </p>
        <div className={cn('mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground', isInteractive && 'group-hover:text-accent-foreground')}>
          <time dateTime={new Date(notification.createdAt).toISOString()}>{timestamp}</time>
          {triggeredByName ? (
            <>
              <span aria-hidden>·</span>
              <span>by {triggeredByName}</span>
            </>
          ) : null}
          {driveName ? (
            <>
              <span aria-hidden>·</span>
              <span className="text-foreground">{driveName}</span>
            </>
          ) : null}
        </div>
        {showConnectionActions ? (
          <div
            className="mt-3 flex gap-2"
            onClick={(event) => event.stopPropagation()}
          >
            <Button
              size="sm"
              variant="default"
              className="h-7"
              onClick={(event) => handleActionClick(event, onAccept)}
            >
              Accept
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={(event) => handleActionClick(event, onDecline)}
            >
              Decline
            </Button>
          </div>
        ) : null}
        {showActionedStatus ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {notification.metadata?.actionedStatus === 'accepted'
              ? 'You accepted this request'
              : 'You declined this request'}
          </p>
        ) : null}
      </div>

      {onDismiss ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Dismiss notification"
          className="size-8 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
          onClick={(event) => handleActionClick(event, onDismiss)}
        >
          <X className="size-4" aria-hidden />
        </Button>
      ) : (
        <span aria-hidden />
      )}
    </article>
  );
}

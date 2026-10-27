'use client';

import { formatDistanceToNow } from 'date-fns';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { StoredNotification } from '@/lib/notifications/resolve-destination';
import { getNotificationIcon } from './notificationIcons';

export interface NotificationToastProps {
  notification: StoredNotification;
  onSelect: () => void;
  onDismiss: () => void;
}

export function NotificationToast({ notification, onSelect, onDismiss }: NotificationToastProps) {
  const Icon = getNotificationIcon(notification.type);
  const createdAtDate = new Date(notification.createdAt);
  const hasValidDate = !Number.isNaN(createdAtDate.getTime());
  const timestamp = hasValidDate ? formatDistanceToNow(createdAtDate, { addSuffix: true }) : null;
  const triggeredByName = notification.triggeredByUser?.name ?? null;

  return (
    <article
      data-testid="notification-toast"
      data-notification-type={notification.type}
      className={cn(
        'group relative flex w-[380px] max-w-[calc(100vw-2rem)] items-start gap-3',
        'rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg',
        'transition-colors hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {/* Full-card activation target, painted below the dismiss button so it
          doesn't capture the corner clicks — avoids nesting a <button> inside
          a role="button" element while keeping the whole card clickable. */}
      <button
        type="button"
        data-testid="notification-toast-select"
        aria-label={`${notification.title}. ${notification.message}`}
        onClick={onSelect}
        className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-4" aria-hidden />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold leading-5 text-foreground">
          {notification.title}
        </p>
        <p className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
          {notification.message}
        </p>
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          {hasValidDate ? (
            <time dateTime={createdAtDate.toISOString()}>{timestamp}</time>
          ) : null}
          {triggeredByName ? (
            <>
              <span aria-hidden>·</span>
              <span>by {triggeredByName}</span>
            </>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        aria-label="Dismiss notification"
        className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-70 hover:bg-accent hover:text-accent-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onDismiss}
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </article>
  );
}

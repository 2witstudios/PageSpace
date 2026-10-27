'use client';

/**
 * ThreadUnreadBadge
 *
 * Per-row indicator that surfaces the count of distinct thread roots in a
 * channel or DM that have unread replies the caller hasn't opened. Reads
 * directly from `useThreadInboxStore` so it stays in sync with realtime
 * `inbox:thread_updated` events without re-rendering the whole inbox list.
 *
 * Renders nothing when the count is 0 — keeps the row visually quiet until
 * there is actually something to surface.
 */

import { MessageSquare } from 'lucide-react';
import { useThreadInboxStore, type ThreadInboxSource } from '@/stores/useThreadInboxStore';
import { cn } from '@/lib/utils';

interface ThreadUnreadBadgeProps {
  source: ThreadInboxSource;
  contextId: string;
  className?: string;
}

export function ThreadUnreadBadge({ source, contextId, className }: ThreadUnreadBadgeProps) {
  // Inline selector (rather than calling contextUnreadCount) so Zustand can
  // shallow-compare the returned number and skip re-render when other
  // contexts mutate.
  const count = useThreadInboxStore((state) => {
    const ctx = state.contexts[`${source}:${contextId}`];
    if (!ctx) return 0;
    let n = 0;
    for (const k of Object.keys(ctx.byRoot)) {
      if (ctx.byRoot[k] > 0) n += 1;
    }
    return n;
  });

  if (count === 0) return null;

  return (
    <span
      data-testid="thread-unread-badge"
      aria-label={`${count} thread${count === 1 ? '' : 's'} with new replies`}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground',
        className,
      )}
    >
      <MessageSquare className="h-2.5 w-2.5" />
      {count}
    </span>
  );
}

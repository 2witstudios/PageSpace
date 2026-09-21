'use client';

import { ListOrdered, X } from 'lucide-react';
import type { UIMessage } from 'ai';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MAX_QUEUED_SENDS } from '@/stores/conversationMessages/applyQueuedSends';

export interface QueueTrayProps {
  /** Queued messages in dispatch order (FIFO) — the same list the drain shifts from. */
  messages: UIMessage[];
  /** Remove one queued message (its tray row's × button). */
  onRemove: (messageId: string) => void;
  /** Remove every queued message (the tray's clear-all affordance). */
  onClear: () => void;
  /** The queue is at `MAX_QUEUED_SENDS` — say so instead of swallowing further sends. */
  isQueueFull?: boolean;
  className?: string;
}

/** The composer text a queued entry carries (queued = text-only v1). */
export const queuedMessageText = (message: UIMessage): string =>
  message.parts
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join(' ');

/**
 * QueueTray - the visible send queue, rendered above the composer (issue #2676).
 *
 * Queuing must not feel like a swallowed send: the user pressed Enter during a
 * stream and is entitled to see WHERE the text went, IN WHAT ORDER it will
 * fire, and how to change their mind. Each entry shows its position and text
 * with a remove button; the header carries the clear-all affordance; a full
 * queue says so explicitly rather than leaving further sends silently inert.
 *
 * Tray-only for v1: queued entries are NOT rendered in the transcript — they
 * are not yet sent, and mixing them into the message list would make them
 * look like a send history they are not.
 */
export function QueueTray({ messages, onRemove, onClear, isQueueFull = false, className }: QueueTrayProps) {
  if (messages.length === 0 && !isQueueFull) return null;

  return (
    <div
      data-testid="queue-tray"
      role="list"
      aria-label="Queued messages"
      className={cn('rounded-md border border-border/60 bg-muted/40 text-xs min-w-0', className)}
    >
      <div className="flex items-center justify-between gap-2 px-2 py-1">
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <ListOrdered className="h-3 w-3 shrink-0" />
          <span className="truncate">
            Queued messages{messages.length > 0 ? ` (${messages.length})` : ''}
          </span>
        </span>
        {messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 shrink-0 px-1.5 text-xs text-muted-foreground"
            onClick={onClear}
            data-testid="queue-tray-clear"
            aria-label="Clear all queued messages"
          >
            Clear all
          </Button>
        )}
      </div>

      {messages.map((message, index) => (
        <div
          key={message.id}
          role="listitem"
          data-testid="queue-tray-item"
          className="flex items-center gap-2 border-t border-border/40 px-2 py-1"
        >
          <span className="shrink-0 tabular-nums text-muted-foreground">{index + 1}.</span>
          <span className="min-w-0 flex-1 truncate text-foreground/80">
            {queuedMessageText(message) || '(message)'}
          </span>
          <button
            type="button"
            data-testid={`queue-tray-remove-${message.id}`}
            aria-label="Remove queued message"
            title="Remove queued message"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onRemove(message.id)}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}

      {isQueueFull && (
        <div
          data-testid="queue-full"
          className="border-t border-border/40 px-2 py-1 text-amber-600 dark:text-amber-400"
        >
          Queue is full ({MAX_QUEUED_SENDS}) — remove a queued message to add another.
        </div>
      )}
    </div>
  );
}

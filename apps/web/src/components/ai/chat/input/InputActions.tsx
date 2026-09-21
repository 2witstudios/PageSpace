'use client';

import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { ArrowRight, Loader2, StopCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface InputActionsProps {
  /** Whether AI is currently streaming */
  isStreaming: boolean;
  /**
   * A Stop has been requested and has not resolved yet (`useStopStream.isStopping`).
   *
   * Renders as STOPPING, not stopped: the button stays the destructive Stop button and the
   * reply keeps streaming behind it. The stream's teardown is the socket's call, never this
   * flag's — see useStopStream's docblock for why claiming otherwise is dishonest.
   */
  isStopping?: boolean;
  /** Send message handler */
  onSend: () => void;
  /** Stop streaming handler */
  onStop: () => void;
  /** Whether send is disabled */
  disabled?: boolean;
  /**
   * Queue-send affordance (issue #2676): while streaming, the send verb becomes QUEUE —
   * the message is held client-side and dispatched after the stream's terminal event.
   * Presence wires the affordance; absent, streaming shows Stop only, as before.
   */
  onQueueSend?: () => void;
  /** Whether the queue-send affordance is enabled (text present, not full, not locked). */
  canQueue?: boolean;
  /** Number of messages currently queued — the badge on the queue-send button. */
  queuedCount?: number;
  /** The queue is at its cap — the affordance says so rather than going silently inert. */
  isQueueFull?: boolean;
  /** Additional class names */
  className?: string;
}

/**
 * InputActions - Send and Stop buttons for chat input
 *
 * Shows:
 * - Send button when not streaming (with disabled state)
 * - Stop button when streaming — plus the queue-send affordance when the
 *   send queue is wired, so Enter during a stream visibly QUEUES instead of
 *   being swallowed (issue #2676)
 *
 * Includes subtle press animation for feedback.
 */
export function InputActions({
  isStreaming,
  isStopping = false,
  onSend,
  onStop,
  disabled = false,
  onQueueSend,
  canQueue = false,
  queuedCount = 0,
  isQueueFull = false,
  className,
}: InputActionsProps) {
  const shouldReduceMotion = useReducedMotion();

  const queueSendButton =
    isStreaming && onQueueSend ? (
      <button
        type="button"
        data-testid="chat-queue-send"
        onClick={onQueueSend}
        disabled={!canQueue}
        className={cn(
          'group relative flex items-center justify-center h-9 w-9 shrink-0 rounded-full disabled:opacity-50',
          'bg-primary text-primary-foreground dark:bg-muted dark:text-muted-foreground',
        )}
        title={
          isQueueFull
            ? `Queue is full (${queuedCount}) — remove a queued message first`
            : queuedCount > 0
              ? `Queue message (${queuedCount} queued)`
              : 'Queue message — sends after the current reply finishes'
        }
        aria-label={
          isQueueFull
            ? `Queue full — ${queuedCount} messages queued`
            : queuedCount > 0
              ? `Queue message — ${queuedCount} queued`
              : 'Queue message'
        }
      >
        <ArrowRight className="h-4 w-4 transition-all duration-200 group-hover:-rotate-90 group-hover:text-foreground" />
        {queuedCount > 0 && (
          <span
            data-testid="chat-queue-count"
            className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground dark:bg-foreground dark:text-background"
          >
            {queuedCount}
          </span>
        )}
      </button>
    ) : null;

  const buttonContent = isStreaming ? (
    <>
      <Button
        data-testid="chat-stop"
        // Inert while the first Stop is in flight: a second one names the same stream and changes
        // nothing, and an unlatched button reads as "that click did nothing". The guard is here
        // rather than on `disabled` deliberately — see below.
        onClick={isStopping ? undefined : onStop}
        // `aria-disabled`, NOT `disabled`, and the difference is the entire point of this state.
        // A natively disabled button is removed from the focus path, so a keyboard user who
        // pressed Stop loses focus to the body and never hears the relabel — the feedback this
        // exists to give is precisely what `disabled` would swallow (CodeRabbit). Focusable and
        // announced, with the click guarded above, is the same protection without the silence.
        aria-disabled={isStopping || undefined}
        data-stopping={isStopping ? 'true' : undefined}
        // `aria-busy` is the standard signal for "this control is working on the thing you asked
        // for", and pairs with the relabel: what it is doing, and that it is still doing it.
        aria-busy={isStopping}
        variant="destructive"
        size="icon"
        className="h-9 w-9 shrink-0 aria-disabled:cursor-not-allowed"
        title={isStopping ? 'Stopping…' : 'Stop generating'}
        aria-label={isStopping ? 'Stopping' : 'Stop generating'}
      >
        {isStopping ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <StopCircle className="h-4 w-4" />
        )}
      </Button>
      {queueSendButton}
    </>
  ) : (
    <button
      data-testid="chat-send"
      onClick={onSend}
      disabled={disabled}
      className={cn(
        "group flex items-center justify-center h-9 w-9 shrink-0 rounded-full disabled:opacity-50",
        // Primary blue in light mode, muted in dark mode (consistent across variants)
        'bg-primary text-primary-foreground dark:bg-muted dark:text-muted-foreground'
      )}
      title="Send message"
      aria-label="Send message"
    >
      <ArrowRight className="h-4 w-4 transition-all duration-200 group-hover:-rotate-90 group-hover:text-foreground" />
    </button>
  );

  // Skip animation wrapper if reduced motion is preferred
  if (shouldReduceMotion) {
    return <div className={cn('flex items-center gap-1.5 shrink-0 self-end', className)}>{buttonContent}</div>;
  }

  return (
    <motion.div
      className={cn('flex items-center gap-1.5 shrink-0 self-end', className)}
      whileTap={{ scale: 0.95 }}
      transition={{ duration: 0.1 }}
    >
      {buttonContent}
    </motion.div>
  );
}

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
  /** Additional class names */
  className?: string;
}

/**
 * InputActions - Send and Stop buttons for chat input
 *
 * Shows:
 * - Send button when not streaming (with disabled state)
 * - Stop button when streaming
 *
 * Includes subtle press animation for feedback.
 */
export function InputActions({
  isStreaming,
  isStopping = false,
  onSend,
  onStop,
  disabled = false,
  className,
}: InputActionsProps) {
  const shouldReduceMotion = useReducedMotion();

  const buttonContent = isStreaming ? (
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
    return <div className={cn('shrink-0 self-end', className)}>{buttonContent}</div>;
  }

  return (
    <motion.div
      className={cn('shrink-0 self-end', className)}
      whileTap={{ scale: 0.95 }}
      transition={{ duration: 0.1 }}
    >
      {buttonContent}
    </motion.div>
  );
}

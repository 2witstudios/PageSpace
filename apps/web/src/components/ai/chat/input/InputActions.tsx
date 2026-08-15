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
      onClick={onStop}
      // Disabled while the first Stop is in flight: a second one names the same stream and
      // changes nothing, and an unlatched button reads as "that click did nothing".
      disabled={isStopping}
      data-stopping={isStopping ? 'true' : undefined}
      // The whole point of this state is feedback, so it has to be announceable — a disabled
      // button with a reworded label is not reliably read out. `aria-busy` is the standard
      // signal for "this control is working on the thing you asked for".
      aria-busy={isStopping}
      variant="destructive"
      size="icon"
      className="h-9 w-9 shrink-0 disabled:opacity-100"
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

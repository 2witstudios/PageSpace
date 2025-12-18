'use client';

import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { ArrowRight, StopCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface InputActionsProps {
  /** Whether AI is currently streaming */
  isStreaming: boolean;
  /** Send message handler */
  onSend: () => void;
  /** Stop streaming handler */
  onStop: () => void;
  /** Whether send is disabled */
  disabled?: boolean;
  /** Style variant: 'main' for InputCard context, 'sidebar' for sidebar contrast */
  variant?: 'main' | 'sidebar';
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
  onSend,
  onStop,
  disabled = false,
  variant: _variant = 'main',
  className,
}: InputActionsProps) {
  const shouldReduceMotion = useReducedMotion();

  const buttonContent = isStreaming ? (
    <Button
      onClick={onStop}
      variant="destructive"
      size="icon"
      className="h-9 w-9 shrink-0"
      title="Stop generating"
      aria-label="Stop generating"
    >
      <StopCircle className="h-4 w-4" />
    </Button>
  ) : (
    <button
      onClick={onSend}
      disabled={disabled}
      className={cn(
        "group flex items-center justify-center h-9 w-9 shrink-0 rounded-full disabled:opacity-50",
        // Primary blue in light mode, muted in dark mode
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
    return <div className={cn('shrink-0', className)}>{buttonContent}</div>;
  }

  return (
    <motion.div
      className={cn('shrink-0', className)}
      whileTap={{ scale: 0.95 }}
      transition={{ duration: 0.1 }}
    >
      {buttonContent}
    </motion.div>
  );
}

export default InputActions;

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
    >
      <StopCircle className="h-4 w-4" />
    </Button>
  ) : (
    <Button
      onClick={onSend}
      disabled={disabled}
      variant="ghost"
      size="icon"
      className="h-9 w-9 shrink-0 rounded-full bg-muted hover:bg-muted/80"
      title="Send message"
    >
      <ArrowRight className="h-4 w-4" />
    </Button>
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

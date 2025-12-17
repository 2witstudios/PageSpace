'use client';

import React from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

export interface InputCardProps {
  /** Content to render inside the card */
  children: React.ReactNode;
  /** Additional class names */
  className?: string;
  /** Error message to display above the input */
  error?: string | null;
  /** Callback when error is dismissed */
  onClearError?: () => void;
}

/**
 * InputCard - A glass-morphism styled card for the floating input.
 *
 * Uses the PageSpace liquid-glass design system with elevated shadows
 * to create a floating, premium feel.
 */
export function InputCard({
  children,
  className,
  error,
  onClearError,
}: InputCardProps) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <div className="relative">
      {/* Error banner */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="mb-3 p-3 rounded-xl bg-destructive/10 border border-destructive/20 flex items-center justify-between"
          >
            <p className="text-sm text-destructive flex-1">{error}</p>
            {onClearError && (
              <button
                onClick={onClearError}
                className="text-sm text-destructive/70 hover:text-destructive underline underline-offset-2 ml-3 shrink-0"
              >
                Dismiss
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main card */}
      <div
        className={cn(
          // Solid background with rounded corners
          'bg-background rounded-2xl',
          'border border-[var(--separator)]',
          'shadow-[var(--shadow-elevated)]',
          'overflow-hidden',
          // Transition for hover/focus states
          'transition-shadow duration-200',
          // Hover elevation boost
          'hover:shadow-[0_4px_12px_rgb(0_0_0/0.08),0_20px_56px_rgb(0_0_0/0.10)]',
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}

export default InputCard;

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
                type="button"
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
          'bg-background rounded-2xl',
          'border border-[var(--separator)]',
          // Inset blue glow (default)
          'shadow-[inset_0_0_20px_oklch(0.62_0.16_235_/_0.15)]',
          'overflow-hidden',
          // Holographic sweep effect
          'holographic-card',
          // Hover transitions
          'transition-all duration-300',
          'hover:scale-[1.02]',
          'hover:shadow-[inset_0_0_20px_oklch(0.62_0.16_235_/_0.15),0_0_30px_oklch(0.62_0.16_235_/_0.3)]',
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}

export default InputCard;

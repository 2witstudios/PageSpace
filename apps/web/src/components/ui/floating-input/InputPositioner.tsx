'use client';

import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard';

export type InputPosition = 'centered' | 'docked';

export interface InputPositionerProps {
  /** Current position state */
  position: InputPosition;
  /** Content to render inside the container */
  children: React.ReactNode;
  /** Additional class names */
  className?: string;
  /** Max width when centered (default: 600px) */
  centeredMaxWidth?: string;
  /** Max width for inner content when docked (default: 896px / 56rem) */
  dockedInnerMaxWidth?: string;
}

const springTransition = {
  type: 'spring' as const,
  stiffness: 280,
  damping: 26,
  mass: 1,
};

/**
 * InputPositioner - A motion-based container that positions its children
 * either centered in the viewport or docked to the bottom.
 *
 * Used to create the "ChatGPT-style" input experience where the input starts
 * centered and moves to the bottom when conversation begins.
 *
 * On mobile with keyboard open, this always docks to bottom to prevent
 * positioning issues during the centered-to-docked transition.
 */
export function InputPositioner({
  position,
  children,
  className,
  centeredMaxWidth = '600px',
  dockedInnerMaxWidth = '56rem',
}: InputPositionerProps) {
  const shouldReduceMotion = useReducedMotion();
  const { isOpen: isKeyboardOpen } = useMobileKeyboard();

  // When keyboard is open, always use docked position to prevent animation issues
  // This ensures the input stays anchored to the bottom during keyboard interactions
  const effectivePosition = isKeyboardOpen ? 'docked' : position;
  const isCentered = effectivePosition === 'centered';

  const transition = shouldReduceMotion
    ? { duration: 0 }
    : springTransition;

  // Use a consistent positioning approach:
  // - Always position from bottom: 0
  // - Use transform to move to center when needed
  // This avoids Framer Motion issues with animating between 'auto' and numeric values
  return (
    <motion.div
      className={cn(
        'absolute z-10 left-0 right-0',
        // Horizontal padding varies by state
        isCentered ? 'px-6' : 'px-4',
        className
      )}
      style={{
        // Always anchor to bottom - this is key for mobile keyboard support
        bottom: 0,
        // Safe bottom offset when docked
        paddingBottom: !isCentered ? 'calc(1rem + var(--safe-bottom-offset, 0px))' : '1rem',
      }}
      initial={false}
      animate={{
        // For centered: move up by ~40% of container height
        // For docked: stay at bottom (y: 0)
        y: isCentered ? 'calc(-50vh + 100px)' : 0,
      }}
      transition={transition}
    >
      {/* Inner wrapper handles max-width constraints */}
      <div
        className="mx-auto w-full"
        style={{
          maxWidth: isCentered ? centeredMaxWidth : dockedInnerMaxWidth,
        }}
      >
        {children}
      </div>
      {/* Background fill behind safe area - extends UI behind iPad keyboard toolbar */}
      {!isCentered && (
        <div
          className="absolute bottom-0 left-0 right-0 bg-background"
          style={{ height: 'var(--safe-bottom-offset, 0px)' }}
          aria-hidden="true"
        />
      )}
    </motion.div>
  );
}

export default InputPositioner;

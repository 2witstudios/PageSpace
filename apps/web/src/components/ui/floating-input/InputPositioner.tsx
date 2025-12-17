'use client';

import React from 'react';
import { motion, useReducedMotion, type Variants } from 'motion/react';
import { cn } from '@/lib/utils';

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

const positionVariants: Variants = {
  centered: {
    top: '50%',
    bottom: 'auto',
    left: '50%',
    right: 'auto',
    x: '-50%',
    y: '-50%',
  },
  docked: {
    top: 'auto',
    bottom: 0,
    left: 0,
    right: 0,
    x: 0,
    y: 0,
  },
};

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
 */
export function InputPositioner({
  position,
  children,
  className,
  centeredMaxWidth = '600px',
  dockedInnerMaxWidth = '56rem',
}: InputPositionerProps) {
  const shouldReduceMotion = useReducedMotion();
  const isCentered = position === 'centered';

  const transition = shouldReduceMotion
    ? { duration: 0 }
    : springTransition;

  return (
    <motion.div
      className={cn(
        'absolute z-10',
        // Centered state: constrained width with horizontal padding
        isCentered && 'w-full px-6',
        // Docked state: full width with padding
        !isCentered && 'w-full px-4 pb-4',
        className
      )}
      style={{
        maxWidth: isCentered ? centeredMaxWidth : undefined,
      }}
      initial={false}
      animate={position}
      variants={positionVariants}
      transition={transition}
    >
      {/* Inner wrapper for docked max-width constraint */}
      <div
        className={cn(
          'w-full',
          !isCentered && 'mx-auto'
        )}
        style={{
          maxWidth: !isCentered ? dockedInnerMaxWidth : undefined,
        }}
      >
        {children}
      </div>
    </motion.div>
  );
}

export default InputPositioner;

'use client';

import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import { InputPositioner, type InputPosition } from './InputPositioner';
import { InputCard } from './InputCard';

/**
 * Vertical offset that seats the welcome overlay's content directly above the
 * centered input card. The dashboard's welcome block (headline + suggestions)
 * is tall, so it rides higher; a pane's bare title sits closer to the card.
 */
export const WELCOME_OFFSET_DASHBOARD = '-translate-y-48';
export const WELCOME_OFFSET_PANE = '-translate-y-24';

export interface FloatingInputLayerProps {
  /** Current position state — see `useInputPosition`. */
  position: InputPosition;
  /** While true the welcome overlay is suppressed (loading takes the stage). */
  isLoading?: boolean;
  /**
   * Content rendered in the centered welcome overlay (pointer-events: none,
   * so links/buttons inside it must opt back into clicks).
   */
  welcomeContent?: React.ReactNode;
  /** Overlay offset class — defaults to the dashboard's `-translate-y-48`. */
  welcomeOffsetClassName?: string;
  /** Slot rendered above the input card (the chat error banner). */
  errorSlot?: React.ReactNode;
  /** Max width when centered (default: 600px). */
  centeredMaxWidth?: string;
  /** Max width for inner content when docked (default: 896px / 56rem). */
  dockedInnerMaxWidth?: string;
  /** The composer content, rendered inside the glass `InputCard`. */
  children: React.ReactNode;
}

/**
 * FloatingInputLayer - the shared "floating composer" chrome: the centered
 * welcome overlay (new/empty conversation) plus the glass `InputCard` that
 * animates between center and bottom dock.
 *
 * Pure presentation — position comes from `useInputPosition`. Render inside a
 * `relative` chat region that is a SIZE container (`[container-type:size]`):
 * the centered position is container-relative (`cqh`), so the same layer
 * centers correctly in the full dashboard view and inside a resizable pane.
 */
export function FloatingInputLayer({
  position,
  isLoading = false,
  welcomeContent,
  welcomeOffsetClassName = WELCOME_OFFSET_DASHBOARD,
  errorSlot,
  centeredMaxWidth,
  dockedInnerMaxWidth,
  children,
}: FloatingInputLayerProps) {
  const shouldReduceMotion = useReducedMotion();
  const isCentered = position === 'centered';

  return (
    <>
      {/* Welcome content - only visible when centered */}
      <AnimatePresence>
        {isCentered && !isLoading && welcomeContent !== undefined && (
          <motion.div
            key="welcome"
            initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 flex items-center justify-center pointer-events-none z-20"
          >
            <div className={cn('w-full max-w-[600px] px-6', welcomeOffsetClassName)}>
              {welcomeContent}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating input */}
      <InputPositioner
        position={position}
        centeredMaxWidth={centeredMaxWidth}
        dockedInnerMaxWidth={dockedInnerMaxWidth}
      >
        <InputCard errorSlot={errorSlot}>{children}</InputCard>
      </InputPositioner>
    </>
  );
}

export default FloatingInputLayer;

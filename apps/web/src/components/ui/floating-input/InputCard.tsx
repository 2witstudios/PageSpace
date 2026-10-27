'use client';

import React from 'react';
import { cn } from '@/lib/utils';

export interface InputCardProps {
  /** Content to render inside the card */
  children: React.ReactNode;
  /** Additional class names */
  className?: string;
  /** Optional slot rendered above the card (e.g. an error banner). */
  errorSlot?: React.ReactNode;
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
  errorSlot,
}: InputCardProps) {
  return (
    <div className="relative">
      {/* Slot above the card — used for the chat error banner. */}
      {errorSlot}

      {/* Main card */}
      <div
        className={cn(
          'bg-background rounded-2xl',
          'border border-border/60',
          // Clean base shadow
          'shadow-sm',
          'overflow-hidden',
          // Holographic sweep effect
          'holographic-card',
          // Hover: refined outer glow
          'transition-shadow duration-300',
          'hover:shadow-[0_0_20px_oklch(0.62_0.16_235_/_0.12)]',
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}

export default InputCard;

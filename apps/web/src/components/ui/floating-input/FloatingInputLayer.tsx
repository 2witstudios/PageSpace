'use client';

import React from 'react';
import { InputPositioner, type InputPosition } from './InputPositioner';
import { InputCard } from './InputCard';

export interface FloatingInputLayerProps {
  /** Current position state — see `useInputPosition`. */
  position: InputPosition;
  /** While true the welcome header is suppressed (loading takes the stage). */
  isLoading?: boolean;
  /**
   * Content rendered above the card when centered (pointer-events: none, so
   * links/buttons inside it must opt back into clicks). Anchored to the
   * card's top edge — one geometry, see `InputPositioner.centeredHeader`.
   */
  welcomeContent?: React.ReactNode;
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
 * welcome header plus the glass `InputCard` that animates between center and
 * bottom dock.
 *
 * Pure presentation — position comes from `useInputPosition`. Mount ONLY
 * inside a `FloatingInputRegion`: the centered position is container-relative
 * (`cqh`), and the region is what makes that resolve against the pane rather
 * than the viewport.
 */
export function FloatingInputLayer({
  position,
  isLoading = false,
  welcomeContent,
  errorSlot,
  centeredMaxWidth,
  dockedInnerMaxWidth,
  children,
}: FloatingInputLayerProps) {
  return (
    <InputPositioner
      position={position}
      centeredHeader={!isLoading ? welcomeContent : undefined}
      centeredMaxWidth={centeredMaxWidth}
      dockedInnerMaxWidth={dockedInnerMaxWidth}
    >
      <InputCard errorSlot={errorSlot}>{children}</InputCard>
    </InputPositioner>
  );
}

export default FloatingInputLayer;

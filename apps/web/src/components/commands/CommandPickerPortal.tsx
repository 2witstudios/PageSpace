'use client';

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CommandPickerPanel, type CommandPickerPanelProps } from './CommandPicker';
import { getViewportHeight, type Position } from '@/services/positioningService';

export interface CommandPickerPortalProps
  extends Omit<CommandPickerPanelProps, 'className'> {
  isOpen: boolean;
  position: Position | null;
  /** The message input the picker is anchored to (clicks there don't close it). */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /**
   * Close without dismissal memory (click outside, selection elsewhere).
   * Memoize with useCallback — it is an effect dependency here. Escape is NOT
   * handled in the portal: focus always sits in the anchored textarea (spec
   * §9), so the textarea's keydown grammar owns Escape dismissal. A document
   * capture listener (the mention portal's approach, needed there because of
   * its autofocused inner input) would shadow that path and swallow Escape
   * from other surfaces.
   */
  onClose: () => void;
}

/**
 * Portal/positioning shell for the command picker — mirrors
 * `MentionPickerPortal`'s portal and clamps (spec §1.3), minus the
 * autofocused inner search input: focus never leaves the textarea, so there
 * is no focus-restoration dance and no document-level Escape listener (spec
 * §9). Adds close-on-click-outside.
 */
export function CommandPickerPortal({
  isOpen,
  position,
  anchorRef,
  onClose,
  ...panelProps
}: CommandPickerPortalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on click/tap outside the picker (spec §1.3). Clicks inside the
  // anchored textarea only move the caret and keep the picker open; focus
  // follows whatever the user actually clicked (spec §9).
  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (containerRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen, anchorRef, onClose]);

  if (!isOpen || !position) return null;
  if (typeof document === 'undefined') return null;

  // Sizing mirrors MentionPickerPortal: width clamped to 256–320px, left kept
  // ≥8px from either edge, maxHeight capped to the space between the anchor
  // and the viewport edge minus 8px. getViewportHeight() uses the visual
  // viewport so the list never sits under a mobile keyboard (spec §8).
  const viewportH = getViewportHeight();
  const viewportW = window.visualViewport?.width ?? window.innerWidth;
  const maxHeight =
    position.bottom !== undefined
      ? `${viewportH - position.bottom - 8}px`
      : `${viewportH - (position.top ?? 0) - 8}px`;

  // Width clamps to 256–320px with 8px gutters (spec §1.3/§8); on viewports
  // narrower than 272px the gutters win over the 256px floor so the picker
  // never overflows horizontally.
  const maxAllowedWidth = Math.min(320, viewportW - 16);
  const actualWidth = Math.min(Math.max(position.width ?? 256, 256), maxAllowedWidth);
  const clampedLeft = Math.max(8, Math.min(position.left, viewportW - actualWidth - 8));

  const style: React.CSSProperties = {
    position: 'fixed',
    zIndex: 50,
    maxHeight,
    width: actualWidth,
    ...(position.bottom !== undefined
      ? { bottom: position.bottom, left: clampedLeft }
      : { top: position.top, left: clampedLeft }),
  };

  return createPortal(
    <div
      ref={containerRef}
      style={style}
      className="bg-popover border border-border rounded-md shadow-md overflow-hidden"
    >
      <CommandPickerPanel {...panelProps} />
    </div>,
    document.body
  );
}

export default CommandPickerPortal;

'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { isCapacitorApp, getPlatform } from './useCapacitor';

export interface UseMobileKeyboardReturn {
  /** Whether the keyboard is currently open */
  isOpen: boolean;
  /** Current keyboard height in pixels */
  height: number;
  /** Dismiss the keyboard (iOS only, no-op elsewhere) */
  dismiss: () => void;
  /** Scroll an element into view above the keyboard */
  scrollInputIntoView: (element: HTMLElement) => void;
}

/**
 * Hook to manage mobile keyboard interactions.
 *
 * Provides:
 * - Keyboard open/close state tracking
 * - Keyboard height for layout adjustments
 * - Dismiss function to programmatically close keyboard
 * - Helper to scroll inputs into view above keyboard
 *
 * Safe to call on all platforms - returns sensible defaults on desktop/web.
 *
 * @example
 * ```tsx
 * const { isOpen, height, dismiss } = useMobileKeyboard();
 *
 * // Dismiss keyboard after sending a message
 * const handleSend = () => {
 *   sendMessage();
 *   dismiss();
 * };
 * ```
 */
export function useMobileKeyboard(): UseMobileKeyboardReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [height, setHeight] = useState(0);
  const observerRef = useRef<MutationObserver | null>(null);

  // Track keyboard state from CSS class changes
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Initial state check
    const checkState = () => {
      const hasClass = document.body.classList.contains('keyboard-open');
      setIsOpen(hasClass);

      const cssHeight = getComputedStyle(document.body).getPropertyValue('--keyboard-height');
      const heightValue = parseInt(cssHeight, 10) || 0;
      setHeight(heightValue);
    };

    checkState();

    // Watch for class changes on body
    observerRef.current = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          checkState();
        }
        if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
          // Also check style changes for --keyboard-height
          const cssHeight = getComputedStyle(document.body).getPropertyValue('--keyboard-height');
          const heightValue = parseInt(cssHeight, 10) || 0;
          setHeight(heightValue);
        }
      }
    });

    observerRef.current.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    return () => {
      observerRef.current?.disconnect();
    };
  }, []);

  // Dismiss keyboard - only works on iOS Capacitor
  const dismiss = useCallback(async () => {
    if (typeof window === 'undefined') return;

    // Only attempt dismiss on iOS Capacitor
    if (!isCapacitorApp() || getPlatform() !== 'ios') {
      return;
    }

    // Blur active element as a reliable cross-platform way to dismiss keyboard
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, []);

  // Scroll an input element into view above the keyboard
  const scrollInputIntoView = useCallback((element: HTMLElement) => {
    if (!isOpen || height === 0) return;

    // Use scrollIntoView with a bottom margin for the keyboard
    element.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }, [isOpen, height]);

  return {
    isOpen,
    height,
    dismiss,
    scrollInputIntoView,
  };
}

/**
 * Non-hook function to dismiss keyboard.
 * Use when you need to dismiss outside of React components.
 */
export function dismissKeyboard(): void {
  if (typeof window === 'undefined') return;

  if (!isCapacitorApp() || getPlatform() !== 'ios') {
    return;
  }

  // Blur active element as a reliable cross-platform way to dismiss keyboard
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

/**
 * Get current keyboard height synchronously.
 * Returns 0 if not on iOS or keyboard is closed.
 */
export function getKeyboardHeight(): number {
  if (typeof window === 'undefined') return 0;

  const cssHeight = getComputedStyle(document.body).getPropertyValue('--keyboard-height');
  return parseInt(cssHeight, 10) || 0;
}

/**
 * Check if keyboard is currently open.
 */
export function isKeyboardOpen(): boolean {
  if (typeof window === 'undefined') return false;
  return document.body.classList.contains('keyboard-open');
}

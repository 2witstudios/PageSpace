'use client';

import { useCapacitor } from './useCapacitor';
import { useMobileKeyboard } from './useMobileKeyboard';

/**
 * Determines whether Enter key should send a message or insert a newline.
 *
 * Behavior by platform:
 * - Desktop/Web: Enter sends, Shift+Enter for newline (returns true)
 * - Mobile phone (native iOS/Android): Enter inserts newline (returns false)
 * - iPad with on-screen keyboard: Enter inserts newline (returns false)
 * - iPad with external keyboard: Enter sends (returns true)
 *
 * iPad external keyboard detection uses the soft keyboard height:
 * the on-screen keyboard is typically 300+ px, while an external keyboard
 * shows no keyboard or just a small predictive-text toolbar (~55px).
 */
export function useEnterToSend(): boolean {
  const { isNative, isIPad } = useCapacitor();
  const { isOpen, height } = useMobileKeyboard();

  // Desktop/Web: Enter sends
  if (!isNative) return true;

  // iPad: depends on whether an external keyboard is attached
  if (isIPad) {
    // On-screen keyboard is typically 300+ px; the floating toolbar
    // shown with an external keyboard is ~55px. Use 120px as threshold.
    const EXTERNAL_KEYBOARD_THRESHOLD = 120;

    if (isOpen && height > EXTERNAL_KEYBOARD_THRESHOLD) {
      return false; // On-screen keyboard active → Enter = newline
    }

    // External keyboard (no keyboard shown, or just the small toolbar)
    return true;
  }

  // Mobile phone (iOS non-iPad, Android): Enter = newline
  return false;
}

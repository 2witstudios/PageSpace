'use client';

import { useCapacitor } from './useCapacitor';
import { useMobileKeyboard } from './useMobileKeyboard';

/**
 * Detect mobile phone browsers via user agent.
 * Covers iPhone, iPod, and Android phones (Android with "Mobile").
 */
function isMobilePhoneBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPod/i.test(ua)) return true;
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return true;
  return false;
}

/**
 * Detect tablet browsers via user agent.
 * Covers iPad (including modern iPads that report as Mac with touch)
 * and Android tablets (Android without "Mobile").
 */
function isTabletBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPad/i.test(ua)) return true;
  // Modern iPad Safari reports as Macintosh but has multi-touch
  if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true;
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return true;
  return false;
}

// On-screen keyboard is typically 300+ px; the floating toolbar
// shown with an external keyboard is ~55px.
const EXTERNAL_KEYBOARD_THRESHOLD = 120;

/**
 * Determines whether Enter key should send a message or insert a newline.
 *
 * Behavior by platform:
 * - Desktop browser: Enter sends, Shift+Enter for newline (returns true)
 * - Mobile phone (native or browser): Enter inserts newline (returns false)
 * - Tablet browser (iPad Safari, etc.): Enter inserts newline (returns false)
 *   (no reliable external keyboard detection in browsers)
 * - Native iPad with on-screen keyboard: Enter inserts newline (returns false)
 * - Native iPad with external keyboard: Enter sends (returns true)
 *
 * iPad external keyboard detection (Capacitor only) uses soft keyboard height:
 * on-screen keyboards are typically 300+ px, while an external keyboard
 * shows no keyboard or just a small predictive-text toolbar (~55px).
 */
export function useEnterToSend(): boolean {
  const { isNative, isIPad, isReady } = useCapacitor();
  const { isOpen, height } = useMobileKeyboard();

  // --- Native Capacitor app (only once useCapacitor has initialized) ---
  if (isReady && isNative) {
    if (isIPad) {
      if (isOpen && height > EXTERNAL_KEYBOARD_THRESHOLD) {
        return false; // On-screen keyboard active → Enter = newline
      }

      // External keyboard (no keyboard shown, or just the small toolbar)
      return true;
    }

    // Native phone: Enter = newline
    return false;
  }

  // --- Web browser (or native before useCapacitor is ready, falling
  //     through to the UA heuristics which work on both) ---

  // Phone browser (iOS Safari, Android Chrome, etc.): Enter = newline
  if (isMobilePhoneBrowser()) return false;

  // Tablet browser (iPad Safari, Android tablet): Enter = newline
  // We can't reliably detect external keyboards in the browser,
  // so default to newline — the send button is always available.
  if (isTabletBrowser()) return false;

  // Desktop browser: Enter sends
  return true;
}

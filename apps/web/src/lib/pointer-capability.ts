/**
 * Canonical touch/coarse-pointer detection.
 *
 * Why not `@media (hover: none)` / `(pointer: coarse)` alone?
 * The iOS app sets `ios.preferredContentMode: 'recommended'`, which gives the
 * iPad desktop-class browsing: it reports `hover: hover` and `pointer: fine`.
 * A CSS-only gate is therefore dead on the exact device that needs it — the
 * `[@media(hover:none)]` rule in MessageHoverToolbar had been silently inert on
 * that iPad for exactly this reason.
 *
 * This module does not *replace* those media queries — it backstops them. They
 * still cover iPhone and Android with zero JS; this covers the one device they
 * cannot see. Both gates ship together so that if this script never runs,
 * everything the media query already handled keeps working.
 *
 * `navigator.maxTouchPoints` is the only reliable tell: iPadOS reports 5 even in
 * desktop-class mode, while real macOS reports 0. The repo already trusts this
 * escape hatch in `useEnterToSend.ts`.
 *
 * Deliberately NOT `(any-pointer: coarse)` — that would flip touchscreen Windows
 * laptops and change desktop rendering.
 */

import { isCapacitorApp } from './capacitor-bridge';

export function detectCoarsePointer(): boolean {
  if (typeof window === 'undefined') return false;

  // 1. Capacitor native shell — true regardless of content mode.
  if (isCapacitorApp()) return true;

  // 2. Standard coarse pointer — iPhone, Android, iPad in mobile content mode.
  if (window.matchMedia?.('(pointer: coarse)').matches) return true;

  // 3. Desktop-class iPad: reports `pointer: fine` but still has multi-touch.
  //    Real macOS has maxTouchPoints === 0, so it never matches.
  return (navigator.maxTouchPoints ?? 0) > 1 && /iPad|Macintosh|iPhone/.test(navigator.userAgent);
}

/**
 * The pre-paint inline script stamped into <body> by the root layout. It has to
 * be a hand-minified copy of `detectCoarsePointer` — it runs before any bundle
 * loads — which makes it the one real maintenance hazard here. It is kept in this
 * file, beside the function it mirrors, and a parity test in
 * `__tests__/pointer-capability.test.ts` asserts the two agree on every device in
 * the matrix. Change one without the other and that test fails.
 */
export const POINTER_CAPABILITY_SCRIPT = `(function(){try{var C=window.Capacitor;var t=(C&&C.isNativePlatform&&C.isNativePlatform())||(window.matchMedia&&window.matchMedia('(pointer: coarse)').matches)||((navigator.maxTouchPoints||0)>1&&/iPad|Macintosh|iPhone/.test(navigator.userAgent));if(t){document.documentElement.setAttribute('data-pointer','coarse');}}catch(e){}})();`;

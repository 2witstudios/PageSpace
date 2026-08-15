'use client';

import React, { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { isDashboardPageLink } from '@/lib/canvas/file-view-links';

interface CanvasFrameProps {
  /** Page whose rendered document the frame navigates to. */
  pageId: string;
  /**
   * Changes whenever the saved content does, to force the frame to re-navigate.
   * Callers pass a save revision/counter — see CanvasPageView, which force-saves
   * on entering the View tab so what loads here is always current.
   */
  previewKey?: string | number;
  title?: string;
  /**
   * Called when the user presses Escape inside the iframe. The sandboxed
   * iframe is a separate browsing context, so a parent-level `keydown`
   * listener (e.g. a Radix Dialog wrapping this frame) never sees the key
   * press once focus moves inside — this bridges it via `postMessage`
   * (`escapeBridge` on `renderCanvasDocument`). Omit when this CanvasFrame
   * isn't inside anything Escape should close (e.g. the plain View tab).
   */
  onEscape?: () => void;
}

/**
 * Sandbox tokens for the in-app canvas iframe.
 *
 * ⚠️ SECURITY-CRITICAL: NEVER add `allow-same-origin`. The frame now loads a
 * SAME-ORIGIN url (the preview route), which makes this MORE important, not less
 * — the absence of this token is the only thing keeping the document in an
 * opaque origin. `allow-same-origin` + `allow-scripts` would let author JS run AS
 * the logged-in app (full session compromise), reading cookies and calling the
 * API with the viewer's session. Likewise no `allow-top-navigation*`, so the
 * frame can never navigate the app's own tab. Guarded by CanvasFrame.test.ts.
 *
 * `allow-forms` is present so a canvas <form> behaves here the way it does once
 * published; without it the author's form silently does nothing while they build
 * it. It grants no new reach: `form-action` is the actual control, and it is
 * already `'none'` with no app origin configured, the app origin alone in
 * baseline mode, and — in site mode — no wider than the `connect-src https:`
 * that mode already grants.
 *
 * Must stay identical to `PREVIEW_SANDBOX_TOKENS` (the response-header twin that
 * covers direct navigation); a drift guard test asserts it.
 */
export const CANVAS_IFRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';

/**
 * True if the top-level document has a currently-active (transient) user
 * activation — i.e. a real click/keypress happened recently, not a script
 * calling an API on its own. Used to gate `pagespace-navigate` postMessage
 * handling: the User Activation API's "activation notification" algorithm
 * (https://html.spec.whatwg.org/multipage/interaction.html#activation-notification)
 * walks up through every ancestor navigable — including this cross-origin,
 * sandboxed iframe's ancestors — on a genuine click, so a real click inside
 * the canvas iframe DOES register here in the parent. It's the same browser
 * mechanism that already gates the iframe's `allow-popups` (a script-only
 * `window.open()` with no real click is blocked as a popup); this reuses it
 * to gate the navigation bridge the same way.
 *
 * Browsers without `navigator.userActivation` (very old) fall back to the
 * pre-gate (permissive) behavior — bounded residual risk, since the message
 * is separately validated to only ever be an internal dashboard PAGE link
 * (`isDashboardPageLink`), never an arbitrary external URL.
 */
function hasRecentUserActivation(): boolean {
  if (typeof navigator === 'undefined' || !('userActivation' in navigator)) return true;
  return Boolean(navigator.userActivation?.isActive);
}

/**
 * In-app renderer for canvas pages.
 *
 * The author document is NAVIGATED TO, not inlined. This used to use `srcDoc`,
 * but a `srcDoc` frame inherits the EMBEDDER's Content-Security-Policy — so the
 * dashboard's nonce-based policy and narrow `connect-src` applied to the author's
 * document, and a site-mode page's `fetch()` would work once published while
 * dying here. Pointing `src` at the preview route makes it a real navigation,
 * which carries its own policy with nothing inherited, so the preview and the
 * published artifact run under the same rules.
 *
 * Isolation is unchanged and is by ORIGIN, not by sanitizer:
 *
 *  - no `allow-same-origin` ⇒ the frame is an opaque origin despite the
 *    same-origin URL, walled off from the logged-in app session (no cookies,
 *    storage, or DOM access to the parent);
 *  - `allow-scripts` ⇒ author JavaScript runs, matching the published page;
 *  - `allow-popups` + `allow-popups-to-escape-sandbox` ⇒ external links open a
 *    normal, un-sandboxed new tab. `allow-top-navigation` is intentionally
 *    omitted so the frame can never navigate the app's own tab.
 */
export function CanvasFrame({ pageId, previewKey, title, onEscape }: CanvasFrameProps) {
  const router = useRouter();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { resolvedTheme } = useTheme();

  // `previewKey` busts the frame's own history/cache entry so a save is
  // reflected. The route already sends `Cache-Control: no-store, private`, so
  // this only guards against the browser reusing the current document.
  const src = useMemo(() => {
    const base = `/api/canvas/${encodeURIComponent(pageId)}/preview`;
    return previewKey === undefined ? base : `${base}?v=${encodeURIComponent(String(previewKey))}`;
  }, [pageId, previewKey]);

  // Send the current theme to the canvas iframe whenever it changes or the
  // iframe navigates. postMessage works across opaque origins (sandbox without
  // allow-same-origin), so the iframe's theme bridge can toggle a `dark` class to
  // match the app. If the iframe hasn't loaded its bridge script yet, the message
  // is harmlessly dropped — the iframe will send a 'pagespace-theme-request' when
  // ready (see handler below).
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow || !resolvedTheme) return;
    iframe.contentWindow.postMessage(
      { type: 'pagespace-theme', isDark: resolvedTheme === 'dark' },
      '*',
    );
  }, [resolvedTheme, src]);

  // Respond to the iframe's initial theme request (fires on load before the
  // resolvedTheme effect above catches it), forward Escape from the injected
  // escape-bridge script (escapeBridge), and handle in-app navigation
  // requests from the injected click-interceptor script (navigationBridge).
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return;

      if (e.data?.type === 'pagespace-theme-request') {
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'pagespace-theme', isDark: resolvedTheme === 'dark' },
          '*',
        );
        return;
      }

      if (e.data?.type === 'pagespace-escape') {
        onEscape?.();
        return;
      }

      // Independently re-validate: the injected click-interceptor's own
      // regex check (render-document.ts) is a UX nicety, not a trust
      // boundary — author JS in the sandboxed-but-scripted iframe can post
      // this message type directly, so we must not route on an unvalidated
      // href. Also require a genuine, recent user gesture (see
      // hasRecentUserActivation doc below) — without it, author JS calling
      // `postMessage({type:'pagespace-navigate', href:'...'}, '*')` on load
      // (no real click at all) would force-navigate the app's own tab,
      // reopening exactly the hole `CANVAS_IFRAME_SANDBOX` deliberately
      // closes by omitting `allow-top-navigation*`.
      if (
        e.data?.type === 'pagespace-navigate' &&
        typeof e.data.href === 'string' &&
        isDashboardPageLink(e.data.href) &&
        hasRecentUserActivation()
      ) {
        router.push(e.data.href);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [resolvedTheme, router, onEscape]);

  return (
    <iframe
      ref={iframeRef}
      src={src}
      sandbox={CANVAS_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className="w-full h-full border-0"
      title={title || 'Canvas'}
    />
  );
}

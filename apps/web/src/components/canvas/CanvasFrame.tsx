'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { renderCanvasDocument } from '@pagespace/lib/canvas/render-document';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import {
  extractDashboardFileViewRefs,
  rewriteDashboardFileViewLinks,
  isDashboardPageLink,
} from '@/lib/canvas/file-view-links';
import { useNonce } from '@/contexts/NonceContext';

interface CanvasFrameProps {
  html: string;
  title?: string;
  /** Mirrors the persisted `published_pages.themeBridgeEnabled` setting (see
   *  the canvas Settings tab's Appearance category) so the editor's live
   *  preview matches what publishing will produce. Defaults to `true`. */
  themeBridgeEnabled?: boolean;
}

/**
 * Sandbox tokens for the in-app canvas iframe.
 *
 * ⚠️ SECURITY-CRITICAL: NEVER add `allow-same-origin`. CanvasFrame renders author
 * HTML/JS via `srcDoc`, which inherits the parent (app) origin — the only thing
 * keeping it an opaque, isolated origin is the ABSENCE of `allow-same-origin`.
 * `allow-same-origin` + `allow-scripts` would let author JS run AS the logged-in
 * app (full session compromise). Likewise no `allow-top-navigation*`, so the
 * frame can never navigate the app's own tab. Guarded by CanvasFrame.test.ts.
 */
export const CANVAS_IFRAME_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

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
 * Replaces the old Shadow-DOM approach (which could not isolate scripts and so
 * had to strip them). The author document is rendered into a SANDBOXED iframe:
 *
 *  - no `allow-same-origin` ⇒ the frame is an opaque origin, walled off from the
 *    logged-in app session (no cookies, storage, or DOM access to the parent);
 *  - `allow-scripts` ⇒ author JavaScript runs (isolation is by origin, not by
 *    sanitizer — matching the published page);
 *  - `allow-popups` + `allow-popups-to-escape-sandbox` ⇒ external links open a
 *    normal, un-sandboxed new tab. `allow-top-navigation` is intentionally
 *    omitted so the frame can never navigate the app's own tab.
 *
 * The document string is the same one produced for published pages, so the
 * in-app view and the published artifact render identically.
 */
export function CanvasFrame({ html, title, themeBridgeEnabled = true }: CanvasFrameProps) {
  const nonce = useNonce();
  const router = useRouter();
  const [previewHtml, setPreviewHtml] = useState(html);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const refs = extractDashboardFileViewRefs(html);
    if (refs.length === 0) {
      setPreviewHtml(html);
      return;
    }

    let cancelled = false;
    setPreviewHtml(html);

    fetchWithAuth('/api/canvas/file-view-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refs }),
    })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{
          links: Array<{ driveId: string; pageId: string; url: string }>;
        }>;
      })
      .then((body) => {
        if (cancelled || !body) return;
        const urlsByRef = new Map(
          body.links.map((link) => [`${link.driveId}:${link.pageId}`, link.url]),
        );
        setPreviewHtml(rewriteDashboardFileViewLinks(
          html,
          ({ driveId, pageId }) => urlsByRef.get(`${driveId}:${pageId}`),
        ));
      })
      .catch(() => {
        if (!cancelled) setPreviewHtml(html);
      });

    return () => {
      cancelled = true;
    };
  }, [html]);

  // baseTarget '_blank': inside the sandboxed frame an ordinary <a href> (no
  // target) would navigate the frame itself — and many sites refuse framing —
  // so default links to a new tab (works with the iframe's allow-popups).
  // injectThemeBridge injects a script that listens for theme messages so the
  // canvas iframe's dark/light state matches the app's current theme — unless
  // the author disabled it (canvas Settings > Appearance) for a design that
  // shouldn't be fought by an injected `dark` class.
  // navigationBridge: true injects a script that intercepts clicks on internal
  // dashboard page links and hands them to the message handler below, so they
  // route in-app instead of falling through to baseTarget's new-tab behavior.
  const srcDoc = useMemo(
    () => renderCanvasDocument({ html: previewHtml, title, baseTarget: '_blank', injectThemeBridge: themeBridgeEnabled, navigationBridge: true, nonce }),
    [previewHtml, title, nonce, themeBridgeEnabled],
  );

  // Send the current theme to the canvas iframe whenever it changes or the
  // iframe content reloads (srcDoc change). postMessage works across opaque
  // origins (sandbox without allow-same-origin), so the iframe's theme bridge
  // can toggle a `dark` class to match the app. If the iframe hasn't loaded its
  // bridge script yet, the message is harmlessly dropped — the iframe will send
  // a 'pagespace-theme-request' when ready (see handler below).
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow || !resolvedTheme) return;
    iframe.contentWindow.postMessage(
      { type: 'pagespace-theme', isDark: resolvedTheme === 'dark' },
      '*',
    );
  }, [resolvedTheme, srcDoc]);

  // Respond to the iframe's initial theme request (fires on load before the
  // resolvedTheme effect above catches it) and handle in-app navigation
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
  }, [resolvedTheme, router]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox={CANVAS_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className="w-full h-full border-0"
      title={title || 'Canvas'}
    />
  );
}

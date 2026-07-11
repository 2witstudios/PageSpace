'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { renderCanvasDocument } from '@pagespace/lib/canvas/render-document';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import {
  extractDashboardFileViewRefs,
  rewriteDashboardFileViewLinks,
} from '@/lib/canvas/file-view-links';

interface CanvasFrameProps {
  html: string;
  title?: string;
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
export function CanvasFrame({ html, title }: CanvasFrameProps) {
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
  // injectThemeBridge: true injects a script that listens for theme messages
  // so the canvas iframe's dark/light state matches the app's current theme.
  const srcDoc = useMemo(
    () => renderCanvasDocument({ html: previewHtml, title, baseTarget: '_blank', injectThemeBridge: true }),
    [previewHtml, title],
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

  // Respond to the iframe's initial theme request, which fires on load before
  // the resolvedTheme effect above catches it.
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.data?.type !== 'pagespace-theme-request') return;
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'pagespace-theme', isDark: resolvedTheme === 'dark' },
        '*',
      );
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [resolvedTheme]);

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

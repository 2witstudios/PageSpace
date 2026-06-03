'use client';

import React, { useMemo } from 'react';
import { renderCanvasDocument } from '@pagespace/lib/canvas/render-document';

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
  // baseTarget '_blank': inside the sandboxed frame an ordinary <a href> (no
  // target) would navigate the frame itself — and many sites refuse framing —
  // so default links to a new tab (works with the iframe's allow-popups).
  const srcDoc = useMemo(
    () => renderCanvasDocument({ html, title, baseTarget: '_blank' }),
    [html, title],
  );

  return (
    <iframe
      srcDoc={srcDoc}
      sandbox={CANVAS_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className="w-full h-full border-0"
      title={title || 'Canvas'}
    />
  );
}

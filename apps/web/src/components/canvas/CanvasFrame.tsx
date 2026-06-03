'use client';

import React, { useMemo } from 'react';
import { renderCanvasDocument } from '@pagespace/lib/canvas/render-document';

interface CanvasFrameProps {
  html: string;
  title?: string;
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
export function CanvasFrame({ html, title }: CanvasFrameProps) {
  const srcDoc = useMemo(() => renderCanvasDocument({ html, title }), [html, title]);

  return (
    <iframe
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="w-full h-full border-0"
      title={title || 'Canvas'}
    />
  );
}

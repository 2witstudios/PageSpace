import 'server-only';

import { renderCanvasDocument } from '@pagespace/lib/canvas/render-document';

/**
 * Server-side renderer for PUBLISHED canvas pages.
 *
 * Thin wrapper over the shared isomorphic `renderCanvasDocument` so the published
 * artifact and the in-app canvas iframe render identically. Author HTML/JS is
 * PRESERVED (isolation is by origin, not by sanitizer); only the author CSS is
 * sanitized. The authoritative edge policy (frame-ancestors, etc.) is applied as
 * real response headers at the edge — see the deploy repo Caddy config.
 */
export interface RenderPublishedPageInput {
  html: string;
  title?: string;
}

/**
 * Render a complete, standalone HTML document for a published canvas page.
 */
export function renderPublishedPage(input: RenderPublishedPageInput): string {
  return renderCanvasDocument(input);
}

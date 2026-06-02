import 'server-only';

import { JSDOM } from 'jsdom';
import { sanitizeCSS } from '@pagespace/lib/canvas/sanitize-css';

/**
 * Server-side renderer for PUBLISHED canvas pages.
 *
 * Policy contrast with the in-app preview (ShadowCanvas):
 * - The in-app preview strips <script> via client DOMPurify before injecting
 *   into a shadow root, because it runs in the same origin as the app.
 * - A PUBLISHED page is served from an isolated origin and rendered inside a
 *   sandboxed iframe at the edge. The published policy therefore PRESERVES
 *   author <script> tags (and the rest of the author HTML) so authors can ship
 *   self-contained interactive pages. Only the author CSS is sanitized, via the
 *   shared `sanitizeCSS`, to strip data-exfiltration / JS-execution vectors.
 *
 * This is a pure string transform: jsdom is used only to parse the input HTML.
 * It performs no network access, reads no env, and embeds no PageSpace token,
 * cookie, session, or API URL.
 */
export interface RenderPublishedPageInput {
  html: string;
  title?: string;
}

/**
 * Escape a string for safe interpolation into HTML text / the <title> element.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Baseline Content-Security-Policy applied via <meta>.
 *
 * NOTE: This is a BASELINE only. The authoritative policy — including the CSP
 * `sandbox` directive (e.g. `sandbox allow-scripts`) and any frame-ancestors /
 * report-uri controls — MUST be applied as a real response header at the edge
 * (task 06). The `sandbox` directive cannot be expressed via a <meta> tag, so
 * it deliberately does not appear here.
 */
const BASELINE_CSP =
  "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * Render a complete, standalone HTML document for a published canvas page.
 */
export function renderPublishedPage(input: RenderPublishedPageInput): string {
  const { html, title } = input;

  // Parse the author HTML so we can split <style> blocks (CSS-sanitized) from
  // the rest of the document body (preserved verbatim, scripts included).
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Collect and sanitize every author <style> block, then remove the originals
  // from the body so they are not emitted twice.
  const styleEls = Array.from(doc.querySelectorAll('style'));
  const sanitizedCss = styleEls
    .map((el) => sanitizeCSS(el.textContent ?? ''))
    .join('\n');
  for (const el of styleEls) {
    el.remove();
  }

  // The remaining body markup — author HTML including any <script> tags.
  const bodyHtml = doc.body ? doc.body.innerHTML : html;

  const safeTitle = escapeHtml(title && title.trim() ? title : 'Untitled');

  return (
    '<!doctype html><html><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${safeTitle}</title>` +
    `<meta http-equiv="Content-Security-Policy" content="${BASELINE_CSP}">` +
    `<style>${sanitizedCss}</style>` +
    '</head><body>' +
    bodyHtml +
    '</body></html>'
  );
}

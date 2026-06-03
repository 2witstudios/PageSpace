import { sanitizeCSS } from './sanitize-css';

/**
 * Isomorphic renderer for canvas pages — assembles a complete, standalone HTML
 * document from author HTML. Shared by BOTH:
 *  - the server-side publish path (`render-published.ts`), and
 *  - the in-app canvas view, which feeds the result into a sandboxed iframe via
 *    `srcDoc` so author scripts run isolated from the app session.
 *
 * The isolation model is "by origin, not by sanitizer": author `<script>` tags
 * (and the rest of the author HTML) are PRESERVED. Only the author CSS is
 * sanitized, via the shared `sanitizeCSS`, to strip data-exfiltration /
 * JS-execution vectors. The published page is served from its own origin; the
 * in-app view is wrapped in a `sandbox`ed (no `allow-same-origin`) iframe.
 *
 * Pure string transform: no DOM/jsdom dependency, no network, no env reads, no
 * token/cookie/session/API-URL embedding — safe to run in the browser.
 */
export interface RenderCanvasDocumentInput {
  html: string;
  title?: string;
}

/**
 * Baseline Content-Security-Policy applied via <meta>.
 *
 * For the PUBLISHED page this is a baseline only; the authoritative origin-only
 * directives (e.g. `frame-ancestors`) are applied as real response headers at
 * the edge. For the IN-APP iframe this <meta> is the page's whole CSP and the
 * iframe `sandbox` attribute supplies the opaque origin. The `sandbox` directive
 * cannot be expressed via a <meta> tag, so it deliberately does not appear here.
 */
export const BASELINE_CSP =
  "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * Escape a string for safe interpolation into HTML text / the <title> element.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Split author HTML into its `<style>` blocks (sanitized + joined) and the
 * remaining markup (style tags removed). Regex-based so it runs identically in
 * Node and the browser — no DOM parser required.
 */
function extractAndSanitizeStyles(html: string): { css: string; body: string } {
  const styleBlock = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  const cssParts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = styleBlock.exec(html)) !== null) {
    cssParts.push(sanitizeCSS(match[1] ?? ''));
  }
  const body = html.replace(styleBlock, '');
  return { css: cssParts.join('\n'), body };
}

/**
 * Render a complete, standalone HTML document for a canvas page.
 */
export function renderCanvasDocument(input: RenderCanvasDocumentInput): string {
  const { html, title } = input;

  const { css, body } = extractAndSanitizeStyles(html ?? '');
  const safeTitle = escapeHtml(title && title.trim() ? title : 'Untitled');

  return (
    '<!doctype html><html><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${safeTitle}</title>` +
    `<meta http-equiv="Content-Security-Policy" content="${BASELINE_CSP}">` +
    `<style>${css}</style>` +
    '</head><body>' +
    body +
    '</body></html>'
  );
}

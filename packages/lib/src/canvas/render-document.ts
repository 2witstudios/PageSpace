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
  /**
   * Default `target` for the document's links, injected as `<base target>`.
   *
   * The in-app view passes `'_blank'`: it renders inside a sandboxed iframe, so
   * an ordinary `<a href>` (no `target`) would otherwise navigate the small
   * frame itself — and many destinations refuse framing (X-Frame-Options/CSP),
   * leaving the link visibly broken. `_blank` opens a new tab (works with the
   * iframe's `allow-popups`). The published page is a normal top-level document,
   * so it omits this and links navigate the page as usual. `base-uri 'none'`
   * only restricts a `<base href>`, not `<base target>`, so this is allowed.
   */
  baseTarget?: '_blank' | '_self' | '_parent' | '_top';
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
 * remaining markup (style elements removed). Regex-based so it runs identically
 * in Node and the browser — no DOM parser required.
 *
 * The alternation consumes whole `<script>...</script>` blocks FIRST and returns
 * them untouched, so a `<style>...</style>` that appears inside author script
 * source (e.g. a web-component template literal) is never mistaken for a real
 * stylesheet — the script is preserved verbatim.
 */
function extractAndSanitizeStyles(html: string): { css: string; body: string } {
  const scriptOrStyle = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  const cssParts: string[] = [];
  const body = html.replace(scriptOrStyle, (match, styleContent: string | undefined) => {
    // styleContent is the capture group; defined only when a real <style>
    // element matched (not a <script> block).
    if (styleContent !== undefined) {
      cssParts.push(sanitizeCSS(styleContent));
      return '';
    }
    return match; // <script> block — leave verbatim
  });
  return { css: cssParts.join('\n'), body };
}

/**
 * Render a complete, standalone HTML document for a canvas page.
 */
export function renderCanvasDocument(input: RenderCanvasDocumentInput): string {
  const { html, title, baseTarget } = input;

  const { css, body } = extractAndSanitizeStyles(html ?? '');
  const safeTitle = escapeHtml(title && title.trim() ? title : 'Untitled');
  const baseTag = baseTarget ? `<base target="${baseTarget}">` : '';

  return (
    '<!doctype html><html><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    baseTag +
    `<title>${safeTitle}</title>` +
    `<meta http-equiv="Content-Security-Policy" content="${BASELINE_CSP}">` +
    `<style>${css}</style>` +
    '</head><body>' +
    body +
    '</body></html>'
  );
}

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
  allowedAssetHosts?: string[];
  /**
   * Base URL for favicon assets (e.g. `https://pagespace.ai`). When provided,
   * standard favicon `<link>` tags are injected into `<head>`. Omit for in-app
   * iframe rendering where favicons are irrelevant.
   *
   * Takes lower priority than `faviconHref` — if both are set, `faviconHref` wins.
   */
  faviconBaseUrl?: string;
  /**
   * Explicit favicon href from a `<link rel="icon" href="…">` the author placed
   * in their canvas. When set, emitted as a single `<link rel="icon">` tag
   * instead of the three-tag set generated from `faviconBaseUrl`.
   */
  faviconHref?: string;
  /**
   * Canonical public URL of this published page (e.g. `https://acme.pagespace.site/my-page`).
   * When provided, Open Graph `<meta>` tags are injected into `<head>` so link
   * unfurls on Slack, Discord, iMessage etc. render correctly. Omit for in-app
   * iframe rendering.
   */
  pageUrl?: string;
  /**
   * Absolute URL of the OG social preview image (min 1200×630). Only emitted
   * when `pageUrl` is also set. Omit to suppress `og:image` tags entirely
   * (caller decides whether to use a default or skip).
   */
  ogImageUrl?: string;
  /**
   * Short description for `og:description`. Only emitted when `pageUrl` is also
   * set. Falls back to no description tag when omitted.
   */
  ogDescription?: string;
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
 * Baseline document reset, emitted BEFORE the author CSS.
 *
 * The author body is rendered into a real `<body>`, which carries the user-agent
 * default `body { margin: 8px }`. For full-bleed content (e.g. a `min-height:100vh`
 * background) that 8px gap shows the page background around the content and reads
 * as an unwanted border/frame.
 *
 * DELIBERATELY scoped to html/body only — it just clears the UA margin/padding.
 * A universal `box-sizing: border-box` or a default `font-family` would silently
 * alter arbitrary author HTML/CSS that relies on the browser defaults (content-box
 * sizing, the UA serif font), reflowing or restyling already-published canvases on
 * republish. Authors who want a wider reset can add their own. Author rules
 * targeting html/body still win because the author CSS is concatenated after.
 */
export const BASELINE_RESET = 'html,body{margin:0;padding:0;}';

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
function extractAndSanitizeStyles(html: string, allowedHttpsHosts?: string[]): { css: string; body: string } {
  const scriptOrStyle = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  const cssParts: string[] = [];
  const body = html.replace(scriptOrStyle, (match, styleContent: string | undefined) => {
    // styleContent is the capture group; defined only when a real <style>
    // element matched (not a <script> block).
    if (styleContent !== undefined) {
      cssParts.push(sanitizeCSS(styleContent, allowedHttpsHosts?.length ? { allowedHttpsHosts } : undefined));
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
  const { html, title, baseTarget, allowedAssetHosts, faviconBaseUrl, faviconHref, pageUrl, ogImageUrl, ogDescription } = input;

  const { css, body } = extractAndSanitizeStyles(html ?? '', allowedAssetHosts);
  const safeTitle = escapeHtml(title && title.trim() ? title : 'Untitled');
  const baseTag = baseTarget ? `<base target="${baseTarget}">` : '';

  const faviconTags = faviconHref
    ? `<link rel="icon" href="${escapeHtml(faviconHref)}">`
    : faviconBaseUrl
      ? buildFaviconTags(faviconBaseUrl)
      : '';

  const ogTags = pageUrl
    ? buildOgTags({ title: safeTitle, pageUrl, ogImageUrl, ogDescription })
    : '';

  return (
    '<!doctype html><html><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    baseTag +
    `<title>${safeTitle}</title>` +
    faviconTags +
    ogTags +
    `<meta http-equiv="Content-Security-Policy" content="${BASELINE_CSP}">` +
    `<style>${BASELINE_RESET}${css}</style>` +
    '</head><body>' +
    body +
    '</body></html>'
  );
}

function buildFaviconTags(baseUrl: string): string {
  const safeBase = escapeHtml(baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl);
  return (
    `<link rel="icon" type="image/x-icon" href="${safeBase}/favicon.ico">` +
    `<link rel="icon" type="image/png" sizes="32x32" href="${safeBase}/favicon-32x32.png">` +
    `<link rel="apple-touch-icon" sizes="180x180" href="${safeBase}/apple-touch-icon.png">`
  );
}

function buildOgTags(params: { title: string; pageUrl: string; ogImageUrl?: string; ogDescription?: string }): string {
  const { title, pageUrl, ogImageUrl, ogDescription } = params;
  const safeUrl = escapeHtml(pageUrl);
  const descriptionTag = ogDescription
    ? `<meta property="og:description" content="${escapeHtml(ogDescription)}">`
    : '';
  const imageTags = ogImageUrl
    ? `<meta property="og:image" content="${escapeHtml(ogImageUrl)}">` +
      `<meta property="og:image:width" content="1200">` +
      `<meta property="og:image:height" content="630">`
    : '';
  return (
    `<meta property="og:title" content="${title}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:url" content="${safeUrl}">` +
    `<meta property="og:site_name" content="PageSpace">` +
    descriptionTag +
    imageTags
  );
}

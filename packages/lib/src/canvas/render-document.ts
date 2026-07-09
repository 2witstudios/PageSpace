import { sanitizeCSS } from './sanitize-css';
import { buildBaselineCsp } from './csp';
import { escapeHtml } from '../utils/html';

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
   * CSP nonce to stamp onto preserved author `<script>` tags.
   *
   * Per the HTML/CSP spec, a `srcDoc` iframe unconditionally inherits its
   * parent (embedder) document's CSP in ADDITION to this document's own
   * `<meta>` CSP (`BASELINE_CSP` above), regardless of the iframe's `sandbox`
   * attribute. When the embedder applies a nonce-based `script-src` (e.g. the
   * dashboard's app-wide CSP), author scripts need a matching nonce or the
   * inherited policy blocks them — even though `BASELINE_CSP`'s own
   * `script-src 'unsafe-inline'` would allow them. Omit for the publish
   * pipeline, which is never framed via `srcDoc` and so never inherits an
   * outer CSP.
   */
  nonce?: string;
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
  /**
   * Document language, emitted as `<html lang>`. Defaults to `"en"`. Applies to
   * both in-app and published rendering (it is a basic accessibility/SEO signal,
   * not gated on `pageUrl`).
   */
  lang?: string;
  /**
   * SEO `<meta name="description">` content. Only emitted for the PUBLISHED page
   * (i.e. when `pageUrl` is set). When omitted, a fallback is derived from the
   * page's first text content via `deriveDescription`. Distinct from
   * `ogDescription` (the author-supplied social blurb).
   */
  description?: string;
  /**
   * `<meta name="robots">` content. Only emitted when `pageUrl` is set. Defaults
   * to `"index, follow"`; pass `"noindex"` (or `"noindex, nofollow"`) to keep a
   * page out of search indexes.
   */
  robots?: string;
  /**
   * When set, scopes `form-action`/`connect-src` in the emitted CSP to this
   * single origin — e.g. the app's own origin, so a provisioned Canvas <form>
   * (see `../forms/form-html.ts`) can submit to the public forms API. Omit to
   * keep the unchanged `BASELINE_CSP` (`form-action 'none'`, no `connect-src`).
   */
  formActionOrigin?: string;
}

/**
 * Baseline Content-Security-Policy applied via <meta>.
 *
 * For the PUBLISHED page this is a baseline only; the authoritative origin-only
 * directives (e.g. `frame-ancestors`) are applied as real response headers at
 * the edge. For the IN-APP iframe this <meta> is the page's whole CSP and the
 * iframe `sandbox` attribute supplies the opaque origin. The `sandbox` directive
 * cannot be expressed via a <meta> tag, so it deliberately does not appear here.
 *
 * Google Fonts is explicitly allowlisted because author/AI-authored canvases
 * commonly pull web fonts from it: `style-src` permits the stylesheet `<link>`
 * (`fonts.googleapis.com`) and a dedicated `font-src` permits the font files
 * (`fonts.gstatic.com`) — without the latter, `default-src 'none'` would block
 * the `.woff2` files. Only these two hosts are allowed; any other external
 * style/font host is still blocked.
 */
export const BASELINE_CSP =
  "default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'";

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

// Re-exported for existing consumers — the implementation lives in a
// dependency-free shared module so non-canvas modules (e.g. forms) don't
// couple to canvas internals to escape a string.
export { escapeHtml };

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
/**
 * If `html` is already a complete standalone document (its own `<html>`
 * wrapper — e.g. author code that wrote a full page, or content pasted from
 * elsewhere) unwrap it to just the `<body>` element's inner markup. Without
 * this, the caller's own generated `<head>`/`<body>` shell (built below) gets
 * assembled AROUND an existing one, doubling every structural tag (doctype,
 * html, head, body) and failing HTML validation. Bare fragments — the common
 * case — pass through unchanged, detected by the absence of an `<html>` tag.
 *
 * Regex-based so it runs identically in Node and the browser, matching the
 * rest of this module. The discarded `<head>` (title/meta/etc.) is not lost
 * to the pipeline overall — SEO/social meta from within it is extracted at a
 * higher level (see `extractAndStripOgMeta` in the publish pipeline) before
 * this function ever runs; this pure renderer only cares about structure.
 * Any `<style>` blocks in that discarded `<head>` ARE preserved, though —
 * they're the normal place authors put page CSS, and dropping them would
 * silently blank out the page's styling. They're prepended to the returned
 * markup so they flow into `extractAndSanitizeStyles` below exactly like a
 * body-level `<style>` tag: sanitized and hoisted into the generated `<head>`.
 */
function unwrapFullDocument(html: string): string {
  if (!/<html(?=[\s/>])/i.test(html)) return html;

  const headMatch = html.match(/<head(?=[\s/>])[^>]*>([\s\S]*?)<\/head(?=[\s/>])[^>]*>/i);
  const headStyles = headMatch ? (headMatch[1].match(/<style(?=[\s/>])[^>]*>[\s\S]*?<\/style(?=[\s/>])[^>]*>/gi) ?? []).join('\n') : '';

  const bodyMatch = html.match(/<body(?=[\s/>])[^>]*>([\s\S]*)<\/body(?=[\s/>])[^>]*>/i);
  if (bodyMatch) return headStyles + bodyMatch[1];

  // No explicit <body> tag (malformed/partial document) — best-effort: strip
  // the doctype/html/head wrapper and keep whatever's left.
  const stripped = html
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?html(?=[\s/>])[^>]*>/gi, '')
    .replace(/<head(?=[\s/>])[^>]*>[\s\S]*?<\/head(?=[\s/>])[^>]*>/gi, '');
  return headStyles + stripped;
}

/**
 * Stamp `nonce="…"` onto a preserved `<script ...>` block's opening tag, so it
 * satisfies an embedder's inherited nonce-based CSP (see `nonce` on
 * `RenderCanvasDocumentInput`). Only the opening tag is touched — content and
 * closing tag pass through unchanged.
 *
 * If the author already declared their OWN `nonce` attribute (e.g. HTML
 * pasted from a different nonce-protected site), its value is REPLACED with
 * the current per-request nonce rather than left alone: a foreign/stale nonce
 * can never match the inherited outer CSP's nonce-source (browsers do exact
 * string matching), so leaving it in place would still get the script
 * blocked — defeating the whole point of this function. Replacing (not
 * duplicating) also keeps the tag valid HTML with exactly one `nonce`
 * attribute.
 *
 * Detection walks the tag ONE ATTRIBUTE AT A TIME (name, then its whole
 * quoted-or-bare value as a single token) rather than searching for the raw
 * substring `nonce=` anywhere in the tag. A raw substring search would also
 * match `nonce=` sitting inside a DIFFERENT attribute's own quoted value
 * (e.g. `<script data-log="utm_source=x nonce=stale123">`) and corrupt that
 * unrelated attribute when "replacing" it. Attribute-at-a-time walking never
 * looks inside an already-consumed value, so `data-nonce=`/`aria-nonce=` are
 * never mistaken for the real attribute either, and a bare/valueless `nonce`
 * (no `=`) is still recognized and replaced rather than duplicated.
 */
function stampScriptNonce(scriptBlock: string, nonce: string): string {
  const openTagMatch = scriptBlock.match(/^<script(?=[\s/>])[^>]*>/i);
  if (!openTagMatch) return scriptBlock;
  const openTag = openTagMatch[0];
  const safeNonce = escapeHtml(nonce);
  const attr = /(\s+)([a-zA-Z_:][-\w:.]*)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?/g;
  let sawNonce = false;
  const stampedOpenTag = openTag.replace(attr, (full, whitespace: string, name: string) => {
    if (name.toLowerCase() !== 'nonce') return full;
    sawNonce = true;
    return `${whitespace}nonce="${safeNonce}"`;
  });
  return (sawNonce ? stampedOpenTag : stampedOpenTag.replace(/^<script/i, `<script nonce="${safeNonce}"`))
    + scriptBlock.slice(openTag.length);
}

function extractAndSanitizeStyles(html: string, allowedHttpsHosts?: string[], nonce?: string): { css: string; body: string } {
  // Tag names require a genuine delimiter — whitespace, `/`, or `>` — immediately
  // after the name (the `(?=[\s/>])` lookahead), mirroring the HTML tokenizer.
  // Only after that delimiter is arbitrary junk/attributes tolerated up to `>`,
  // so `</style\n foo>` / `</script bar>` can't smuggle content past the match,
  // while hyphenated names like `<script-template>` / `</script-template>` are
  // NOT mistaken for a real script/style tag (a `\b` alone would match before
  // `-`/`:` and could truncate an author script mid-block, corrupting it).
  const scriptOrStyle = /<script(?=[\s/>])[^>]*>[\s\S]*?<\/script(?=[\s/>])[^>]*>|<style(?=[\s/>])[^>]*>([\s\S]*?)<\/style(?=[\s/>])[^>]*>/gi;
  const cssParts: string[] = [];
  const body = html.replace(scriptOrStyle, (match, styleContent: string | undefined) => {
    // styleContent is the capture group; defined only when a real <style>
    // element matched (not a <script> block).
    if (styleContent !== undefined) {
      cssParts.push(sanitizeCSS(styleContent, allowedHttpsHosts?.length ? { allowedHttpsHosts } : undefined));
      return '';
    }
    return nonce ? stampScriptNonce(match, nonce) : match; // <script> block — leave verbatim (unless nonce is stamped)
  });
  return { css: cssParts.join('\n'), body };
}

/**
 * Render a complete, standalone HTML document for a canvas page.
 */
export function renderCanvasDocument(input: RenderCanvasDocumentInput): string {
  const { html, title, baseTarget, allowedAssetHosts, faviconBaseUrl, faviconHref, pageUrl, ogImageUrl, ogDescription, lang, description, robots, formActionOrigin, nonce } = input;
  const csp = buildBaselineCsp(formActionOrigin);

  const { css, body } = extractAndSanitizeStyles(unwrapFullDocument(html ?? ''), allowedAssetHosts, nonce);
  const rawTitle = title && title.trim() ? title : 'Untitled';
  const safeTitle = escapeHtml(rawTitle);
  const safeLang = escapeHtml(lang && lang.trim() ? lang : 'en');
  const baseTag = baseTarget ? `<base target="${baseTarget}">` : '';

  const faviconTags = faviconHref
    ? `<link rel="icon" href="${escapeHtml(faviconHref)}">`
    : faviconBaseUrl
      ? buildFaviconTags(faviconBaseUrl)
      : '';

  // SEO + social tags describe a PUBLIC landing page, so they are emitted only
  // for the published artifact (signalled by `pageUrl`). The in-app iframe
  // rendering — which never receives `pageUrl` — is left byte-for-byte unchanged.
  let seoTags = '';
  let ogTags = '';
  if (pageUrl) {
    const metaDescription = (description ?? deriveDescription(body)).trim();
    // og:description falls back to the meta description so link unfurls always
    // carry a description, even when the author supplied no explicit og blurb.
    const socialDescription = ogDescription ?? metaDescription;
    ogTags = buildOgTags({ title: safeTitle, pageUrl, ogImageUrl, ogDescription: socialDescription });
    seoTags =
      buildSeoTags({ pageUrl, description: metaDescription, robots: robots ?? 'index, follow' }) +
      buildTwitterTags({ title: safeTitle, description: socialDescription, imageUrl: ogImageUrl }) +
      buildJsonLd({ title: rawTitle, pageUrl, description: metaDescription });
  }

  return (
    `<!doctype html><html lang="${safeLang}"><head>` +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    baseTag +
    `<title>${safeTitle}</title>` +
    faviconTags +
    seoTags +
    ogTags +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
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

/**
 * Core SEO `<head>` tags for a published page: meta description, robots
 * directive, and the canonical link. `description` and `pageUrl` are raw and
 * HTML-escaped here; an empty description simply omits the tag.
 */
function buildSeoTags(params: { pageUrl: string; description: string; robots: string }): string {
  const { pageUrl, description, robots } = params;
  const descriptionTag = description ? `<meta name="description" content="${escapeHtml(description)}">` : '';
  return (
    descriptionTag +
    `<meta name="robots" content="${escapeHtml(robots)}">` +
    `<link rel="canonical" href="${escapeHtml(pageUrl)}">`
  );
}

/**
 * Twitter Card tags. Reuses the OG title/description/image values: `title` is
 * already HTML-escaped; `description` and `imageUrl` are raw and escaped here.
 */
function buildTwitterTags(params: { title: string; description?: string; imageUrl?: string }): string {
  const { title, description, imageUrl } = params;
  const descriptionTag = description ? `<meta name="twitter:description" content="${escapeHtml(description)}">` : '';
  const imageTag = imageUrl ? `<meta name="twitter:image" content="${escapeHtml(imageUrl)}">` : '';
  return (
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${title}">` +
    descriptionTag +
    imageTag
  );
}

/**
 * Escape a JSON string for safe embedding inside an HTML `<script>` element.
 * Neutralises `<`, `>` and `&` (so an author title containing `</script>` cannot
 * break out of the block) using JSON-legal `\uXXXX` escapes — the result still
 * parses as the same JSON value.
 */
function jsonLdEscape(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/**
 * JSON-LD structured data: a `WebSite` node (the publish origin) plus a `WebPage`
 * node for this page. `title`/`description` are RAW (JSON.stringify handles
 * escaping); the result is then `jsonLdEscape`d for the script context.
 */
function buildJsonLd(params: { title: string; pageUrl: string; description: string }): string {
  const { title, pageUrl, description } = params;
  const origin = pageUrl.match(/^https?:\/\/[^/]+/)?.[0] ?? pageUrl;
  const webPage: Record<string, string> = { '@type': 'WebPage', name: title, url: pageUrl };
  if (description) webPage.description = description;
  const data = {
    '@context': 'https://schema.org',
    '@graph': [{ '@type': 'WebSite', name: 'PageSpace', url: origin }, webPage],
  };
  return `<script type="application/ld+json">${jsonLdEscape(JSON.stringify(data))}</script>`;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Derive a plain-text summary from author HTML (or text) for use as a fallback
 * meta description. Pure: drops `<script>`/`<style>` blocks, strips remaining
 * tags, decodes the common HTML entities (so the value can be safely
 * re-escaped without double-encoding), collapses whitespace, and truncates to
 * ~`maxLength` chars at a word boundary with an ellipsis.
 */
export function deriveDescription(htmlOrText: string, maxLength = 155): string {
  const stripped = (htmlOrText ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  const decoded = stripped.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key in NAMED_ENTITIES) return NAMED_ENTITIES[key];
    let code: number | undefined;
    if (key.startsWith('#x')) code = parseInt(key.slice(2), 16);
    else if (key.startsWith('#')) code = parseInt(key.slice(1), 10);
    if (code === undefined || !Number.isFinite(code)) return match;
    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  });

  const text = decoded.replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;

  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  const base = (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trimEnd();
  return `${base}…`;
}

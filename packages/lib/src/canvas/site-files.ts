/**
 * Pure builders for the site-level files every PUBLISHED drive needs.
 *
 * A PageSpace drive published at `<subdomain>.pagespace.site` is a real website,
 * and a real website serves `/robots.txt`, `/sitemap.xml`, and a `404.html`.
 * Because the edge (Caddy) rewrites every request path to `<path>/index.html`,
 * these must exist as REAL objects in storage — they cannot be generated on the
 * fly by an app server that is never in the serving path.
 *
 * These functions are PURE string transforms: input is plain data, output is the
 * exact bytes written to storage. No DOM, no network, no env reads, no clock —
 * the publish lifecycle (the thin shell) gathers the data (routes, publish time,
 * site name) and persists whatever these return. Keeping them pure makes the
 * non-trivial part — valid XML, deterministic ordering, escaping — fully unit
 * testable without a DB or a bucket.
 */

/** Robots.txt input. */
export interface BuildRobotsTxtInput {
  /** Absolute URL of the site's sitemap, e.g. `https://acme.pagespace.site/sitemap.xml`. */
  sitemapUrl: string;
}

/**
 * Build a `robots.txt` that allows all crawling and points crawlers at the
 * sitemap. Published canvas sites are public marketing/landing pages — there is
 * nothing to hide from crawlers, and an explicit `Sitemap:` line is the standard
 * way to advertise the URL inventory.
 */
export function buildRobotsTxt({ sitemapUrl }: BuildRobotsTxtInput): string {
  return ['User-agent: *', 'Allow: /', '', `Sitemap: ${sitemapUrl}`, ''].join('\n');
}

/** A single sitemap entry. */
export interface SitemapRoute {
  /** Absolute URL of the page, e.g. `https://acme.pagespace.site/about`. */
  loc: string;
  /**
   * Last-modified timestamp as a W3C-datetime string (e.g. an ISO-8601 value
   * from `Date#toISOString()`). Omitted from the entry when absent.
   */
  lastmod?: string;
}

/**
 * XML-escape a text value for inclusion in an element body. Escapes the five
 * predefined XML entities so URLs containing `&`, `<`, `>`, `'`, or `"` (e.g. a
 * query string) cannot break the document or inject markup.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build a sitemaps.org-compliant `sitemap.xml` from the site's routes.
 *
 * One `<url>` per route. Ordering is deterministic (sorted by `loc`) so the same
 * inventory always yields byte-identical output — re-publishing an unchanged site
 * never churns the artifact. `loc` values are XML-escaped; a `lastmod` is emitted
 * only when supplied. An empty route list still produces a valid (empty)
 * `<urlset>`, which is exactly what should be served once the last page of a
 * drive is unpublished.
 */
export function buildSitemapXml(routes: SitemapRoute[]): string {
  const sorted = [...routes].sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));

  const urls = sorted.map((route) => {
    const parts = [`    <loc>${escapeXml(route.loc)}</loc>`];
    if (route.lastmod) {
      parts.push(`    <lastmod>${escapeXml(route.lastmod)}</lastmod>`);
    }
    return `  <url>\n${parts.join('\n')}\n  </url>`;
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

/** Resolved favicon reference for a rendered document. */
export interface FaviconTags {
  faviconHref?: string;
  faviconBaseUrl?: string;
}

/**
 * Resolve the effective favicon for a published page or site file.
 *
 * Precedence: the author's own `<link rel="icon">` tag inside the canvas
 * content wins (unchanged pre-existing behavior) → else the drive's
 * `publishFaviconUrl` setting → else the default PageSpace favicon tags built
 * from `defaultFaviconBaseUrl`. Used by both a normal page publish and the
 * custom-404-page render so the whole site shares one favicon.
 */
export function resolveFaviconTags(
  pageFaviconHref: string | undefined,
  driveFaviconUrl: string | null | undefined,
  defaultFaviconBaseUrl: string,
): FaviconTags {
  if (pageFaviconHref) return { faviconHref: pageFaviconHref };
  if (driveFaviconUrl) return { faviconHref: driveFaviconUrl };
  return { faviconBaseUrl: defaultFaviconBaseUrl };
}

/** 404 document input. */
export interface BuildNotFoundHtmlInput {
  /** Human-readable site name shown on the page. Falls back to a generic label. */
  siteName?: string;
}

/**
 * Build a minimal, self-contained branded `404.html`. Inline styles only — the
 * edge serves this as a standalone document on a storage miss, with no asset
 * pipeline behind it, so it must render with zero external dependencies.
 */
export function buildNotFoundHtml({ siteName }: BuildNotFoundHtmlInput = {}): string {
  const name = siteName?.trim() || 'This site';
  const safeName = escapeXml(name);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0b0b0f;
    color: #e8e8ea;
    padding: 24px;
  }
  main { text-align: center; max-width: 32rem; }
  .code { font-size: 4rem; font-weight: 700; letter-spacing: -0.03em; margin: 0; line-height: 1; }
  h1 { font-size: 1.5rem; font-weight: 600; margin: 0.75rem 0 0.5rem; }
  p { margin: 0 0 1.5rem; opacity: 0.7; line-height: 1.5; }
  a {
    display: inline-block;
    padding: 0.625rem 1.25rem;
    border-radius: 0.5rem;
    background: #e8e8ea;
    color: #0b0b0f;
    text-decoration: none;
    font-weight: 500;
  }
  .brand { margin-top: 2.5rem; font-size: 0.8125rem; opacity: 0.45; }
  .brand a { background: none; color: inherit; padding: 0; text-decoration: underline; font-weight: inherit; }
</style>
</head>
<body>
<main>
  <p class="code">404</p>
  <h1>Page not found</h1>
  <p>${safeName} doesn&apos;t have a page at this address. It may have been moved or unpublished.</p>
  <a href="/">Go to the homepage</a>
  <p class="brand">Published with <a href="https://pagespace.ai">PageSpace</a></p>
</main>
</body>
</html>
`;
}

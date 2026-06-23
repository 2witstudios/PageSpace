export interface DashboardFileViewRef {
  driveId: string;
  pageId: string;
}

const DASHBOARD_FILE_VIEW_RE =
  /(?:https?:\/\/[^/'">\s]*)?\/dashboard\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/view(?:\?[^"')\s>]*)?(?=$|[#"')\s>])/g;

const refKey = ({ driveId, pageId }: DashboardFileViewRef): string => `${driveId}:${pageId}`;

export function extractDashboardFileViewRefs(html: string): DashboardFileViewRef[] {
  const refsByKey = new Map<string, DashboardFileViewRef>();
  for (const match of html.matchAll(DASHBOARD_FILE_VIEW_RE)) {
    const ref = { driveId: match[1], pageId: match[2] };
    refsByKey.set(refKey(ref), ref);
  }
  return Array.from(refsByKey.values());
}

export function rewriteDashboardFileViewLinks(
  html: string,
  resolveUrl: (ref: DashboardFileViewRef) => string | null | undefined,
): string {
  return html.replace(DASHBOARD_FILE_VIEW_RE, (match, driveId: string, pageId: string) => {
    return resolveUrl({ driveId, pageId }) ?? match;
  });
}

// ---------------------------------------------------------------------------
// Inter-page links (page → page navigation on the published site)
// ---------------------------------------------------------------------------
//
// A published drive is a multi-page site: the home page at `/` and every other
// published canvas page at `/<slug>`, all on `<subdomain>.pagespace.site`. In
// the app, a canvas links to another page with an in-app dashboard URL, in one
// of two forms:
//
//   /dashboard/{driveId}/{pageId}        (plain navigation link)
//   /dashboard/{driveId}/{pageId}/view   (the file-view form, also used as a link)
//
// On the published artifact those URLs are dead — they point back into the app.
// The functions below extract such links and rewrite them to the target page's
// public published URL so navigation between published pages actually works.

/** The apex host every published drive site is served under. */
export const PUBLISH_HOST = 'pagespace.site';

export interface InterPageLink {
  driveId: string;
  pageId: string;
}

// Matches both the plain (`/dashboard/{d}/{p}`) and file-view
// (`/dashboard/{d}/{p}/view`) link forms, with an optional absolute origin
// prefix and optional query string. The trailing boundary lookahead ensures a
// longer path segment (`/edit`, `/viewer`, `/p/child`, …) never matches as an
// inter-page link.
const INTER_PAGE_LINK_RE =
  /(?:https?:\/\/[^/'">\s]*)?\/dashboard\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)(?:\/view)?(?:\?[^"')\s>]*)?(?=$|[#"')\s>])/g;

const interPageKey = ({ driveId, pageId }: InterPageLink): string => `${driveId}:${pageId}`;

/**
 * Extract every unique inter-page link (`/dashboard/{driveId}/{pageId}` and the
 * `/view` variant) from canvas HTML.
 *
 * Pure function: no I/O, no env reads.
 */
export function extractInterPageLinks(html: string): InterPageLink[] {
  const byKey = new Map<string, InterPageLink>();
  for (const match of html.matchAll(INTER_PAGE_LINK_RE)) {
    const link = { driveId: match[1], pageId: match[2] };
    byKey.set(interPageKey(link), link);
  }
  return Array.from(byKey.values());
}

/**
 * Rewrite canvas inter-page links to their published-site URLs.
 *
 * `pathByPageId` maps a published page id to its published path. Only pages in
 * the SAME drive belong in the map (the caller scopes the lookup by drive), so a
 * link whose page id is absent is either unpublished or lives in another drive.
 *
 * Resolution rules:
 *  - page id present, path is `''`  → the drive home page, served at the site
 *    root → rewritten to `/`.
 *  - page id present, non-empty path → rewritten to
 *    `https://<subdomain>.pagespace.site/<path>`.
 *  - page id ABSENT (unpublished / out-of-drive) → FALLBACK: the original href
 *    is left unchanged so a dead inter-page link never fails the publish build.
 *
 * Pure function: no I/O, no env reads.
 */
export function rewriteInterPageLinks(
  html: string,
  pathByPageId: Map<string, string>,
  subdomain: string,
): string {
  return html.replace(INTER_PAGE_LINK_RE, (match, _driveId: string, pageId: string) => {
    const path = pathByPageId.get(pageId);
    if (path === undefined) return match;
    return path === '' ? '/' : `https://${subdomain}.${PUBLISH_HOST}/${path}`;
  });
}


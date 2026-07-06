import 'server-only';

import { loggers } from '@pagespace/lib/logging/logger-config';
import { isUniqueViolation } from '@pagespace/lib/services/subdomain-allocation';
import { allocatePublishSubdomain } from '@pagespace/lib/services/drive-service';
import { slugify } from '@pagespace/lib/utils/utils';
import { validatePublishSubdomain, normalizeSubdomain } from '@pagespace/lib/validators/subdomain';
import { db } from '@pagespace/db/db';
import { eq, and, ne } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { isHomeDrive } from '@pagespace/lib/services/drive-guards';
import { resolvePublishedMeta } from '@pagespace/lib/canvas/resolve-published-meta';
import { renderPublishedPage } from './render-published';
import {
  buildPublishedKey,
  putPublishedArtifact,
  putPublishedSiteFile,
  publishedArtifactExists,
  deletePublishedArtifact,
  copyPublishedArtifact,
  isPublishConfigured,
  getPublishAssetBaseUrl,
} from './published-storage';
import { rewriteCanvasAssets, rewriteInterPageLinksForDrive, extractAndStripOgMeta } from './asset-pipeline';
import { buildRobotsTxt, buildSitemapXml, buildNotFoundHtml } from '@pagespace/lib/canvas/site-files';
import { resolvePrimaryPublishedHost } from '@pagespace/lib/canvas/primary-host';
import { mirrorPublishedPageToHosts, mirror404ToHosts, getActiveDomainRecords } from './custom-domain-mirror';

export const PUBLISH_HOST = 'pagespace.site';
const FAVICON_BASE_URL = 'https://pagespace.ai';

/**
 * Error carrying an HTTP status so route handlers can map publish failures
 * (invalid/taken subdomain, path collision, non-canvas page, …) back to the
 * actionable 4xx response they had before this logic was extracted, instead of
 * collapsing every expected failure into a 500.
 */
export class PublishError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.name = 'PublishError';
    this.statusCode = statusCode;
  }
}

/**
 * Canonicalize a caller-supplied publish path so the value stored in
 * `published_pages.path` is exactly the value that `buildPublishedKey` derives
 * the storage key from. Each segment is slugified (lowercased, special chars
 * dropped) and empty/dot segments are removed, making the result a fixed point
 * of the storage-layer `sanitizePath`. Without this, inputs like `Foo`/`foo` or
 * `a/../b`/`b` reserve distinct `(driveId, path)` rows while targeting the same
 * artifact key, letting a later publish overwrite an earlier page's public site.
 */
function normalizePublishPath(raw: string): string {
  return raw
    .split('/')
    .map((segment) => slugify(segment))
    .filter(Boolean)
    .join('/');
}

export interface PublishCanvasPageInput {
  /** Page ID to publish. Must be a CANVAS page. */
  pageId: string;
  /** Drive that owns the page. Resolved by caller. */
  driveId: string;
  /** User performing the publish (for published_pages.publishedBy + subdomain allocation). */
  userId: string;
  /** Explicit path override. When omitted, derived from page title → pageId fallback. */
  path?: string;
 /**
   * Explicit subdomain override. When omitted, the drive's existing publishSubdomain is used
   * (or a new one is allocated from the drive slug).
   */
  subdomain?: string;
  /**
   * Author SEO override: page `<title>` / `og:title`. Empty string clears a
   * previously-persisted override; `undefined` leaves the persisted value intact.
   */
  title?: string;
  /**
   * Author SEO override: meta + social description. Empty string clears; an
   * `undefined` leaves the persisted value intact.
   */
  description?: string;
  /**
   * Author SEO override: social preview image URL. Empty string clears; an
   * `undefined` leaves the persisted value intact.
   */
  ogImageUrl?: string;
  /**
   * When true, the published page emits `<meta name="robots" content="noindex">`
   * and is excluded from the sitemap. Persisted on `published_pages.noindex`.
   * `undefined` leaves the persisted value intact (defaults to indexable).
   */
  noindex?: boolean;
}

export interface PublishCanvasPageResult {
  /** Primary public URL — the subdomain root for the home page, else the slug URL. */
  url: string;
  subdomain: string;
  /** The published_pages.path (slug). The home page is also served at the root. */
  path: string;
  /** True when this page is the drive's home page (also mirrored to the root). */
  isHomePage: boolean;
}

/**
 * Core canvas publishing logic shared by the per-page publish route and the drive
 * home-page auto-publish. Handles subdomain resolution, asset rewriting, OG meta,
 * S3 artifact upload, and published_pages DB upsert.
 *
 * Auth and permission checks are the caller's responsibility.
 */
export async function publishCanvasPage(input: PublishCanvasPageInput): Promise<PublishCanvasPageResult> {
  const { pageId, driveId, userId } = input;

  // ------------------------------------------------------------------
  // 1. Load page (must be canvas)
  // ------------------------------------------------------------------
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { id: true, type: true, title: true, content: true, driveId: true },
  });

  if (!page) {
    throw new PublishError('Page not found', 404);
  }

  if (page.type !== 'CANVAS') {
    throw new PublishError('Only canvas pages can be published', 400);
  }

  // The page must actually live in the drive whose subdomain we are about to
  // resolve and reserve under. Otherwise a mismatched caller could publish one
  // drive's page under another drive's subdomain, and the path-collision
  // constraint would apply to the wrong drive.
  if (page.driveId !== driveId) {
    throw new PublishError('Page not found', 404);
  }

  // ------------------------------------------------------------------
  // 2. Load drive (resolve subdomain)
  // ------------------------------------------------------------------
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
    columns: { id: true, slug: true, publishSubdomain: true, kind: true, homePageId: true, publishDefaultOgImageUrl: true },
  });

  if (!drive) {
    throw new PublishError('Drive not found', 404);
  }

  if (isHomeDrive(drive)) {
    throw new PublishError('Cannot publish from a Home drive', 403);
  }

  // Resolve the drive's publish subdomain. The subdomain is a property of the
  // DRIVE, never of an individual publish request: once allocated it is always
  // reused. A caller-supplied `subdomain` is only a *candidate* for the drive's
  // first allocation. `allocatePublishSubdomain` normalizes the candidate and
  // auto-resolves reserved / already-taken / malformed values to a unique slug
  // (pagespace -> pagespace-2, acme -> acme-3, …) rather than erroring — the same
  // race-safe allocator used by drive creation. It is idempotent (returns the
  // existing subdomain when one is set), so a caller can never overwrite another
  // drive's subdomain or publish under a reserved one.
  let subdomain = drive.publishSubdomain;
  if (!subdomain) {
    subdomain = await allocatePublishSubdomain(drive.id, input.subdomain ?? drive.slug);
  }

  // ------------------------------------------------------------------
  // 3. Resolve path
  // ------------------------------------------------------------------
  // Every page publishes at a non-empty slug path. The subdomain root ('') is
  // never a directly-publishable path — it is reserved for the drive's home page
  // and written as a mirror below, so an arbitrary page can't claim the root.
  // Explicit paths are canonicalized so the DB row and storage key agree (a
  // value that canonicalizes to empty falls back to the page id).
  const isHomePage = drive.homePageId === pageId;
  const path =
    input.path === undefined
      ? slugify(page.title ?? '') || pageId
      : normalizePublishPath(input.path) || pageId;

  // ------------------------------------------------------------------
  // 4. Rewrite assets + extract OG meta
  // ------------------------------------------------------------------
  const { html: assetHtml } = await rewriteCanvasAssets({ html: page.content ?? '', userId, db });
  // Rewrite page→page links to their public published URLs so navigation between
  // published pages works on the subdomain site (drive-scoped; unpublished /
  // out-of-drive targets are left unchanged).
  const { html: rewrittenHtml } = await rewriteInterPageLinksForDrive({
    html: assetHtml,
    driveId,
    subdomain,
    homePageId: drive.homePageId,
    currentPageId: pageId,
    currentPath: path,
    db,
  });
  const { meta, html: bodyHtml } = extractAndStripOgMeta(rewrittenHtml);
  const assetBaseUrl = getPublishAssetBaseUrl();

  // ------------------------------------------------------------------
  // 4b. Resolve effective SEO overrides
  // ------------------------------------------------------------------
  // Load any persisted per-page overrides (and the prior artifact key for
  // cleanup). A publish call only carries override fields that the caller chose
  // to change: an `undefined` field preserves the persisted value, an empty
  // string clears it, a non-empty string sets it. This keeps republish paths
  // that pass no overrides (e.g. home-page auto-republish) from wiping the
  // author's settings.
  const existing = await db.query.publishedPages.findFirst({
    where: eq(publishedPages.pageId, pageId),
    columns: {
      artifactKey: true,
      publishTitle: true,
      publishDescription: true,
      publishOgImageUrl: true,
      noindex: true,
    },
  });

  const mergeOverride = (next: string | undefined, persisted: string | null): string | null =>
    next === undefined ? persisted : next.trim() || null;

  const effectiveTitle = mergeOverride(input.title, existing?.publishTitle ?? null);
  const effectiveDescription = mergeOverride(input.description, existing?.publishDescription ?? null);
  const effectiveOgImageUrl = mergeOverride(input.ogImageUrl, existing?.publishOgImageUrl ?? null);
  const effectiveNoindex = input.noindex === undefined ? existing?.noindex ?? false : input.noindex;

  // Resolve the drive's primary published host. When an active custom domain
  // exists it is the primary; otherwise we fall back to the subdomain. All
  // copies (subdomain + every custom host mirror) embed the same canonical URL
  // pointing at the primary host, so search-engine ranking signals converge on
  // the customer's own domain.
  const activeDomains = await getActiveDomainRecords(driveId);
  const primaryHost = resolvePrimaryPublishedHost({ subdomain, publishHost: PUBLISH_HOST, activeDomains });

  const rootUrl = `https://${primaryHost}/`;
  const publishedUrl = `https://${primaryHost}/${path}`;
  // The canonical/OG/JSON-LD URL is the page's PRIMARY public URL. For the home
  // page that is the site root (the same artifact is also mirrored there),
  // not the secondary slug path — using the slug would make the root page
  // canonicalize itself away to `/<slug>`. Other pages are canonical at their
  // slug. The SEO description prefers the author's og:description, falling back
  // to text derived from the page content; robots defaults to indexable.
  const canonicalUrl = isHomePage ? rootUrl : publishedUrl;
  // Resolve the effective metadata through the pure precedence resolver:
  // per-page override → canvas <meta> → drive default (image) / derived (text).
  const resolvedMeta = resolvePublishedMeta({
    override: { title: effectiveTitle, description: effectiveDescription, ogImageUrl: effectiveOgImageUrl },
    noindex: effectiveNoindex,
    pageTitle: page.title,
    canvasMeta: { ogImageUrl: meta.ogImageUrl, ogDescription: meta.ogDescription },
    driveDefaultOgImageUrl: drive.publishDefaultOgImageUrl,
    body: bodyHtml,
  });
  const formActionOrigin = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!formActionOrigin) {
    loggers.api.warn(
      'Neither WEB_APP_URL nor NEXT_PUBLIC_APP_URL is set — published Canvas forms will be blocked (form-action \'none\')',
      { pageId: page.id, driveId: drive.id }
    );
  }

  const html = renderPublishedPage({
    html: bodyHtml,
    title: resolvedMeta.title,
    assetBaseUrl,
    faviconHref: meta.faviconHref,
    faviconBaseUrl: meta.faviconHref ? undefined : FAVICON_BASE_URL,
    pageUrl: canonicalUrl,
    ogImageUrl: resolvedMeta.ogImageUrl,
    ogDescription: resolvedMeta.description,
    description: resolvedMeta.description,
    robots: resolvedMeta.robots,
    formActionOrigin,
  });
  const key = buildPublishedKey(subdomain, path);

  // ------------------------------------------------------------------
  // 6. Upsert published_pages row
  // ------------------------------------------------------------------
  // Reserve the (driveId, path) row + artifact key BEFORE the upload so a path
  // collision is detected before any storage write. The SEO overrides are NOT
  // written here: they are committed in step 9 only after the artifact upload
  // succeeds, so a failed upload never leaves the DB advertising metadata the
  // live artifact doesn't yet carry. (On first insert the override columns take
  // their defaults — null / noindex=false — until step 9 sets the real values.)
  try {
    await db
      .insert(publishedPages)
      .values({
        driveId: page.driveId,
        pageId,
        path,
        artifactKey: key,
        publishedBy: userId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: publishedPages.pageId,
        set: {
          path,
          artifactKey: key,
          publishedBy: userId,
        },
      });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new PublishError('Another page is already published at that path; choose a different path', 409);
    }
    throw err;
  }

  // ------------------------------------------------------------------
  // 7. Upload artifact (slug path)
  // ------------------------------------------------------------------
  await putPublishedArtifact({ subdomain, path, html });

  // ------------------------------------------------------------------
  // 8. Mirror the home page to the subdomain root
  // ------------------------------------------------------------------
  // The drive's home page is its "index": serve it at `<sub>.pagespace.site/`
  // in addition to its slug path. The root artifact key is stable
  // (`published/<sub>/index.html`), so a later home-page publish overwrites it
  // in place; it is removed when the home page is unpublished.
  if (isHomePage) {
    await putPublishedArtifact({ subdomain, path: '', html });
  }

  // ------------------------------------------------------------------
  // 9. Commit SEO overrides + advance updatedAt + cleanup stale artifact
  // ------------------------------------------------------------------
  // The artifact carrying this metadata is now live, so persist the resolved
  // SEO overrides together with the updatedAt advance. Doing it here (post-upload)
  // keeps the DB consistent with what is actually served: a failed upload above
  // returns before this line, leaving the row's previous overrides intact.
  await db
    .update(publishedPages)
    .set({
      publishTitle: effectiveTitle,
      publishDescription: effectiveDescription,
      publishOgImageUrl: effectiveOgImageUrl,
      noindex: effectiveNoindex,
      updatedAt: new Date(),
    })
    .where(eq(publishedPages.pageId, pageId));

  if (existing?.artifactKey && existing.artifactKey !== key) {
    try {
      await deletePublishedArtifact(existing.artifactKey);
    } catch (cleanupError) {
      loggers.api.warn('Failed to delete stale published artifact', {
        artifactKey: existing.artifactKey,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }

  // ------------------------------------------------------------------
  // 10. Regenerate the drive's site-level files (robots / sitemap / 404)
  // ------------------------------------------------------------------
  // The published page is already live and the DB is committed, so a failure to
  // refresh the crawl files must not roll back the publish — log and move on.
  // The next publish/unpublish regenerates them.
  await regeneratePublishedSiteFiles(driveId);

  // ------------------------------------------------------------------
  // 11. Mirror artifacts to active custom-domain host prefixes (best-effort)
  // ------------------------------------------------------------------
  // For every active custom domain on this drive, copy the newly-written
  // subdomain artifacts (slug + root when home page) to the matching host
  // prefix so Caddy can serve them there immediately.
  await mirrorPublishedPageToHosts({ driveId, subdomain, path, isHomePage });

  // Return the PRIMARY host URL (custom domain when one is active/selected,
  // otherwise the pagespace.site subdomain) so the publish control displays and
  // copies the branded link visitors should land on. This is the same canonical
  // host baked into the rendered HTML above — `rootUrl`/`publishedUrl`.
  const responseUrl = isHomePage ? rootUrl : publishedUrl;
  return { url: responseUrl, subdomain, path, isHomePage };
}

/**
 * Re-render every published page in a drive so the canonical / og:url / JSON-LD
 * URLs baked into each artifact reflect the drive's CURRENT primary host.
 *
 * Call this after the primary custom domain changes: `regeneratePublishedSiteFiles`
 * alone only refreshes the sitemap/robots, leaving each page artifact still
 * advertising the previous primary until it is individually republished. Each
 * page is re-published at its EXISTING `published_pages.path` — never re-derived
 * from the (possibly since-changed) title, which would relocate the page.
 *
 * Per-page failures are logged, not thrown — a partial refresh beats none, and
 * the next publish of a failed page picks up the current primary. No-op when
 * publishing is unconfigured. Returns the number of pages successfully
 * re-rendered (useful for callers/tests).
 */
export async function republishDriveCanonical(driveId: string, userId: string): Promise<number> {
  if (!isPublishConfigured()) return 0;

  const published = await db.query.publishedPages.findMany({
    where: eq(publishedPages.driveId, driveId),
    columns: { pageId: true, path: true },
  });

  let refreshed = 0;
  for (const row of published) {
    try {
      await publishCanvasPage({ pageId: row.pageId, driveId, userId, path: row.path });
      refreshed += 1;
    } catch (err) {
      loggers.api.warn('Failed to re-render published page for canonical refresh', {
        driveId,
        pageId: row.pageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return refreshed;
}

/**
 * (Re)generate the site-level files for a published drive — `robots.txt`,
 * `sitemap.xml`, and `404.html` — and write them to storage at the subdomain
 * root (`published/<sub>/<file>`).
 *
 * Call this after EVERY publish AND unpublish in the drive: the sitemap is built
 * from the live `published_pages` rows, so regenerating on unpublish is what keeps
 * it from advertising a route that no longer serves anything.
 *
 * Best-effort by contract: these files make a published drive a "real" website
 * but are secondary to the page artifacts themselves. A failure here is logged,
 * not thrown — the caller's publish/unpublish has already succeeded, and the next
 * lifecycle event will rebuild the files. No-op when publishing is unconfigured
 * or the drive has not yet been allocated a subdomain.
 */
/**
 * Change a drive's publish subdomain and migrate all published artifacts.
 *
 * Validates the new subdomain, checks global uniqueness, updates the DB, then
 * re-renders every published page under the new prefix and regenerates site
 * files. Old artifacts are deleted last (best-effort). The caller is responsible
 * for auth and tier-gating.
 */
export async function changePublishSubdomain(
  driveId: string,
  candidate: string,
  userId: string,
): Promise<{ oldSubdomain: string | null; newSubdomain: string }> {
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
    columns: { id: true, publishSubdomain: true, kind: true },
  });
  if (!drive) throw new PublishError('Drive not found', 404);
  if (isHomeDrive(drive)) throw new PublishError('Cannot change subdomain of a Home drive', 403);

  const oldSubdomain = drive.publishSubdomain;

  const normalized = normalizeSubdomain(candidate);
  const validation = validatePublishSubdomain(normalized);
  if (!validation.valid) {
    throw new PublishError(validation.reason, 400);
  }

  if (normalized === oldSubdomain) {
    return { oldSubdomain, newSubdomain: normalized };
  }

  const conflict = await db.query.drives.findFirst({
    where: and(eq(drives.publishSubdomain, normalized), ne(drives.id, driveId)),
    columns: { id: true },
  });
  if (conflict) {
    throw new PublishError(`Subdomain "${normalized}" is already taken`, 409);
  }

  try {
    await db.update(drives).set({ publishSubdomain: normalized }).where(eq(drives.id, driveId));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new PublishError(`Subdomain "${normalized}" is already taken`, 409);
    }
    throw err;
  }

  try {
    // Re-render all published pages under the new subdomain prefix.
    const publishedRows = await db.query.publishedPages.findMany({
      where: eq(publishedPages.driveId, driveId),
      columns: { pageId: true },
    });
    const refreshedCount = await republishDriveCanonical(driveId, userId);
    if (refreshedCount !== publishedRows.length) {
      throw new PublishError(
        `Subdomain migration incomplete: refreshed ${refreshedCount}/${publishedRows.length} published pages`,
        500,
      );
    }

    // Regenerate robots/sitemap/404 under the new prefix.
    await regeneratePublishedSiteFiles(driveId);
  } catch (err) {
    // Roll back subdomain pointer so the drive keeps serving from the previous
    // host when migration doesn't fully complete.
    try {
      await db.update(drives).set({ publishSubdomain: oldSubdomain }).where(eq(drives.id, driveId));
    } catch (rollbackErr) {
      loggers.api.error('Failed to roll back publish subdomain after migration error', {
        driveId,
        oldSubdomain,
        attemptedSubdomain: normalized,
        error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
      });
    }

    if (err instanceof PublishError) throw err;
    throw new PublishError('Failed to migrate published artifacts to new subdomain', 500);
  }

  // Do not clear the old prefix here. Once the DB pointer changes, the old
  // subdomain can be claimed by another drive; prefix-wide deletion could remove
  // artifacts that no longer belong to this drive.
  return { oldSubdomain, newSubdomain: normalized };
}

export async function regeneratePublishedSiteFiles(driveId: string): Promise<void> {
  try {
    if (!isPublishConfigured()) return;

    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
      columns: { name: true, publishSubdomain: true, homePageId: true },
    });
    const subdomain = drive?.publishSubdomain;
    if (!subdomain) return;

    // Resolve primary host: custom domain (if active) or subdomain fallback.
    // Loading domains here means sitemap/robots URLs point at the customer's
    // domain on every copy — subdomain and custom-host alike.
    const activeDomains = await getActiveDomainRecords(driveId);
    const primaryHost = resolvePrimaryPublishedHost({ subdomain, publishHost: PUBLISH_HOST, activeDomains });
    const origin = `https://${primaryHost}`;

    const allPublished = await db.query.publishedPages.findMany({
      where: eq(publishedPages.driveId, driveId),
      columns: { pageId: true, path: true, updatedAt: true, noindex: true },
    });
    // Pages flagged noindex emit robots=noindex and must not be advertised in the
    // sitemap either, so crawlers never discover them through it.
    const published = allPublished.filter((row) => !row.noindex);

    // The home page is canonicalised to the subdomain root (where it is
    // mirror-served) instead of its slug, so the inventory has no duplicate for
    // it — but ONLY when the root mirror actually exists. `syncPublishedHomeRoot`
    // writes `published/<sub>/index.html` whenever a published page is made the
    // home, but a page published at its slug and made home BEFORE the first sync
    // may still not have the mirror. Confirm the root object exists before
    // advertising `/` to avoid surfacing a dead route.
    const homeRow = drive.homePageId
      ? published.find((row) => row.pageId === drive.homePageId)
      : undefined;
    let rootMirrorExists = false;
    if (homeRow) {
      try {
        rootMirrorExists = await publishedArtifactExists(buildPublishedKey(subdomain, ''));
      } catch (err) {
        // If we can't determine whether the mirror exists, fall back to the
        // slug URL (which always serves) rather than risk advertising a dead
        // root — and don't let a probe failure abort the whole regeneration.
        loggers.api.warn('Failed to probe published home-page root mirror; using slug URL in sitemap', {
          driveId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Build one sitemap entry per published page (noindex pages already filtered
    // out of `published` above, so the sitemap never advertises them).
    const routes = published.map((row) => ({
      loc:
        rootMirrorExists && row.pageId === drive.homePageId
          ? `${origin}/`
          : `${origin}/${row.path}`,
      lastmod: row.updatedAt?.toISOString(),
    }));

    const sitemapXml = buildSitemapXml(routes);
    const robotsTxt = buildRobotsTxt({ sitemapUrl: `${origin}/sitemap.xml` });
    const notFoundHtml = buildNotFoundHtml({ siteName: drive.name ?? undefined });

    await Promise.all([
      putPublishedSiteFile({ subdomain, file: 'robots.txt', body: robotsTxt }),
      putPublishedSiteFile({ subdomain, file: 'sitemap.xml', body: sitemapXml }),
      putPublishedSiteFile({ subdomain, file: '404.html', body: notFoundHtml }),
    ]);

    // Mirror the 404.html to every active custom-domain host so unknown paths
    // render the branded not-found page there too. Best-effort (errors logged
    // internally by mirror404ToHosts).
    await mirror404ToHosts(driveId, subdomain);
  } catch (err) {
    loggers.api.warn('Failed to regenerate published site files', {
      driveId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Deliberately (re)publish a drive's canvas home page. Because the page is the
 * drive's home page, `publishCanvasPage` mirrors it to the subdomain root so
 * `<subdomain>.pagespace.site/` serves it (in addition to its slug path), and
 * allocates the drive's publish subdomain if it doesn't have one yet.
 *
 * This is a deliberate publish action — setting a page as the home page never
 * calls it. Returns null only when the drive has no home page set (the caller
 * maps that to a 400); all other failure modes surface as `PublishError`
 * (non-canvas → 400, Home drive → 403, …).
 */
export async function publishHomePageAtRoot(
  driveId: string,
  userId: string,
): Promise<PublishCanvasPageResult | null> {
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
    columns: { id: true, homePageId: true },
  });

  if (!drive?.homePageId) return null;

  return publishCanvasPage({
    pageId: drive.homePageId,
    driveId,
    userId,
  });
}

/**
 * Sync the subdomain root to reflect the drive's current home page.
 *
 * Called (fire-and-forget) after `homePageId` changes on a drive — both from
 * the PATCH /api/drives/[driveId] route and the `set_home_page` AI tool. Never
 * blocks the metadata update; all errors are logged and swallowed.
 *
 * Decision matrix (implements Option B — route bytes already in storage):
 *   - not configured / no subdomain        → no-op
 *   - homePageId cleared (null)            → delete root + regenerate site files
 *   - homePageId set, page not published   → delete root + regenerate site files
 *   - homePageId set, page IS published    → S3-copy slug artifact to root +
 *                                            regenerate site files
 *
 * Idempotent: re-marking the same home page just re-copies. The copy is
 * byte-for-byte identical to the slug artifact — no re-render, no new content
 * pushed live. An unpublished page set as home is never written to the root.
 */
export async function syncPublishedHomeRoot(driveId: string): Promise<void> {
  try {
    if (!isPublishConfigured()) return;

    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
      columns: { publishSubdomain: true, homePageId: true },
    });
    const subdomain = drive?.publishSubdomain;
    if (!subdomain) return;

    const rootKey = buildPublishedKey(subdomain, '');

    if (!drive.homePageId) {
      await deletePublishedArtifact(rootKey);
      // Regenerate so the sitemap stops advertising the now-dead `/` route.
      await regeneratePublishedSiteFiles(driveId);
      return;
    }

    const publishedRow = await db.query.publishedPages.findFirst({
      where: eq(publishedPages.pageId, drive.homePageId),
      columns: { artifactKey: true },
    });

    if (!publishedRow) {
      // Home page designated but not yet published — clear any stale root mirror
      // so `/` never serves content that is no longer the intended home page.
      await deletePublishedArtifact(rootKey);
      // Regenerate so the sitemap stops advertising the now-dead `/` route.
      await regeneratePublishedSiteFiles(driveId);
      return;
    }

    // Home page is already published at its slug — copy those live bytes to the
    // root key. This is a storage-layer copy (no re-render), so only content
    // that was deliberately published ever reaches the root.
    await copyPublishedArtifact(publishedRow.artifactKey, rootKey);
    // Regenerate site files so the sitemap advertises `/` for the home page.
    await regeneratePublishedSiteFiles(driveId);
  } catch (err) {
    loggers.api.warn('Failed to sync published home-page root mirror', {
      driveId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Remove the subdomain-root mirror for a drive (the served copy of the home page
 * at `<subdomain>.pagespace.site/`). Called when the home page is unpublished so
 * the root stops serving it. This only *un-serves* the root copy — it never
 * publishes anything. No-op when the drive has no subdomain or publishing is not
 * configured.
 *
 * Throws if the delete itself fails: the caller (unpublish) must NOT report
 * success while the home page is still publicly reachable at the root. Callers
 * run this before committing the rest of the unpublish so a failure is retryable.
 */
export async function clearPublishedHomeRoot(driveId: string): Promise<void> {
  if (!isPublishConfigured()) return;

  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
    columns: { publishSubdomain: true },
  });
  if (!drive?.publishSubdomain) return;

  try {
    await deletePublishedArtifact(buildPublishedKey(drive.publishSubdomain, ''));
  } catch (err) {
    loggers.api.warn('Failed to clear published home-page root mirror', {
      driveId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

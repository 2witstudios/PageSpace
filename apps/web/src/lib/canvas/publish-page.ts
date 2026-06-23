import 'server-only';

import { loggers } from '@pagespace/lib/logging/logger-config';
import { normalizeSubdomain, validatePublishSubdomain } from '@pagespace/lib/validators/subdomain';
import { isUniqueViolation } from '@pagespace/lib/services/subdomain-allocation';
import { slugify } from '@pagespace/lib/utils/utils';
import { db } from '@pagespace/db/db';
import { eq, and, isNull } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { isHomeDrive } from '@pagespace/lib/services/drive-guards';
import { deriveDescription } from '@pagespace/lib/canvas/render-document';
import { renderPublishedPage } from './render-published';
import {
  buildPublishedKey,
  putPublishedArtifact,
  deletePublishedArtifact,
  isPublishConfigured,
  getPublishAssetBaseUrl,
} from './published-storage';
import { rewriteCanvasAssets, extractAndStripOgMeta } from './asset-pipeline';

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
   * When true, the published page emits `<meta name="robots" content="noindex">`
   * so search engines keep it out of their indexes. Defaults to indexable. The
   * author-facing toggle + persistence is a separate task; this just honors the
   * flag when a caller passes it.
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
    columns: { id: true, slug: true, publishSubdomain: true, kind: true, homePageId: true },
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
  // first allocation — it must pass validation and win the unique constraint.
  // Using `input.subdomain` directly would let a caller publish under another
  // drive's subdomain (or a reserved/invalid one), overwriting that public site.
  let subdomain = drive.publishSubdomain;
  if (!subdomain) {
    const candidate = normalizeSubdomain(input.subdomain ?? drive.slug);
    const validation = validatePublishSubdomain(candidate);
    if (!validation.valid) {
      throw new PublishError(`Invalid subdomain: ${validation.reason}`, 400);
    }

    try {
      // Compare-and-set: only the first publisher (publishSubdomain still NULL)
      // wins the allocation. A concurrent loser's update matches no rows, so we
      // re-read and adopt the winner's subdomain instead of returning a URL for
      // a subdomain the drive no longer owns.
      await db
        .update(drives)
        .set({ publishSubdomain: candidate })
        .where(and(eq(drives.id, drive.id), isNull(drives.publishSubdomain)));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new PublishError('Subdomain taken, choose another', 409);
      }
      throw err;
    }

    const allocated = await db.query.drives.findFirst({
      where: eq(drives.id, drive.id),
      columns: { publishSubdomain: true },
    });
    subdomain = allocated?.publishSubdomain ?? candidate;
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
  const { html: rewrittenHtml } = await rewriteCanvasAssets({ html: page.content ?? '', userId, db });
  const { meta, html: bodyHtml } = extractAndStripOgMeta(rewrittenHtml);
  const assetBaseUrl = getPublishAssetBaseUrl();
  const rootUrl = `https://${subdomain}.${PUBLISH_HOST}/`;
  const publishedUrl = `https://${subdomain}.${PUBLISH_HOST}/${path}`;
  // The canonical/OG/JSON-LD URL is the page's PRIMARY public URL. For the home
  // page that is the subdomain root (the same artifact is also mirrored there),
  // not the secondary slug path — using the slug would make the root page
  // canonicalize itself away to `/<slug>`. Other pages are canonical at their
  // slug. The SEO description prefers the author's og:description, falling back
  // to text derived from the page content; robots defaults to indexable.
  const canonicalUrl = isHomePage ? rootUrl : publishedUrl;
  const html = renderPublishedPage({
    html: bodyHtml,
    title: page.title ?? undefined,
    assetBaseUrl,
    faviconHref: meta.faviconHref,
    faviconBaseUrl: meta.faviconHref ? undefined : FAVICON_BASE_URL,
    pageUrl: canonicalUrl,
    ogImageUrl: meta.ogImageUrl,
    ogDescription: meta.ogDescription,
    description: meta.ogDescription ?? deriveDescription(bodyHtml),
    robots: input.noindex ? 'noindex' : undefined,
  });
  const key = buildPublishedKey(subdomain, path);

  // ------------------------------------------------------------------
  // 5. Capture existing artifact key for cleanup
  // ------------------------------------------------------------------
  const existing = await db.query.publishedPages.findFirst({
    where: eq(publishedPages.pageId, pageId),
    columns: { artifactKey: true },
  });

  // ------------------------------------------------------------------
  // 6. Upsert published_pages row
  // ------------------------------------------------------------------
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
  // 9. Advance updatedAt + cleanup stale artifact
  // ------------------------------------------------------------------
  await db
    .update(publishedPages)
    .set({ updatedAt: new Date() })
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

  // The home page's primary public URL is the subdomain root (matching the
  // canonical tag baked above); it is also reachable at its slug. Other pages
  // live only at their slug.
  return { url: isHomePage ? rootUrl : publishedUrl, subdomain, path, isHomePage };
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

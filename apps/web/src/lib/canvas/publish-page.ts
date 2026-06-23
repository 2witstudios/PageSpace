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
}

export interface PublishCanvasPageResult {
  url: string;
  subdomain: string;
  path: string;
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
    columns: { id: true, slug: true, publishSubdomain: true, kind: true },
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
  // An explicit '' means "publish at the subdomain root" (home-page-at-root).
  // Any other explicit path is canonicalized so the DB row and storage key
  // agree; a non-empty path that canonicalizes to empty falls back to the page
  // id rather than silently landing at the root.
  let path: string;
  if (input.path === undefined) {
    path = slugify(page.title ?? '') || pageId;
  } else if (input.path === '') {
    path = '';
  } else {
    path = normalizePublishPath(input.path) || pageId;
  }

  // ------------------------------------------------------------------
  // 4. Rewrite assets + extract OG meta
  // ------------------------------------------------------------------
  const { html: rewrittenHtml } = await rewriteCanvasAssets({ html: page.content ?? '', userId, db });
  const { meta, html: bodyHtml } = extractAndStripOgMeta(rewrittenHtml);
  const assetBaseUrl = getPublishAssetBaseUrl();
  const publishedUrl = `https://${subdomain}.${PUBLISH_HOST}/${path}`;
  const html = renderPublishedPage({
    html: bodyHtml,
    title: page.title ?? undefined,
    assetBaseUrl,
    faviconHref: meta.faviconHref,
    faviconBaseUrl: meta.faviconHref ? undefined : FAVICON_BASE_URL,
    pageUrl: publishedUrl,
    ogImageUrl: meta.ogImageUrl,
    ogDescription: meta.ogDescription,
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
  // 7. Upload artifact
  // ------------------------------------------------------------------
  await putPublishedArtifact({ subdomain, path, html });

  // ------------------------------------------------------------------
  // 8. Advance updatedAt + cleanup stale artifact
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

  return { url: publishedUrl, subdomain, path };
}

/**
 * Publish a drive's home page at the root path (''), so that
 * `<subdomain>.pagespace.site/` serves it directly.
 *
 * Returns null (no-op) when:
 *  - The drive has no homePageId
 *  - The home page is not a CANVAS
 *  - The drive has no publishSubdomain
 *  - Publishing is not configured (missing S3 bucket)
 */
export async function publishHomePageAtRoot(
  driveId: string,
  userId: string,
): Promise<PublishCanvasPageResult | null> {
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
    columns: { id: true, homePageId: true, publishSubdomain: true, kind: true },
  });

  if (!drive?.homePageId) return null;
  if (!drive.publishSubdomain) return null;
  if (isHomeDrive(drive)) return null;
  if (!isPublishConfigured()) return null;

  const homePage = await db.query.pages.findFirst({
    where: eq(pages.id, drive.homePageId),
    columns: { id: true, type: true },
  });

  if (!homePage || homePage.type !== 'CANVAS') return null;

  // Replacement semantics: the subdomain root ('') belongs to whichever page is
  // the *current* home page. If a different page still occupies the root (e.g.
  // the home page just changed from A to B), release that row first so the new
  // home page is not rejected by the unique (driveId, path) constraint. The root
  // artifact key is identical for both pages, so the upcoming upload overwrites
  // it in place — no orphaned artifact is left behind.
  const existingRoot = await db.query.publishedPages.findFirst({
    where: and(eq(publishedPages.driveId, driveId), eq(publishedPages.path, '')),
    columns: { pageId: true },
  });
  if (existingRoot && existingRoot.pageId !== drive.homePageId) {
    await db.delete(publishedPages).where(eq(publishedPages.pageId, existingRoot.pageId));
  }

  return publishCanvasPage({
    pageId: drive.homePageId,
    driveId,
    userId,
    path: '',
  });
}

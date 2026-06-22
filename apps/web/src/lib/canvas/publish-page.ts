import 'server-only';

import { loggers } from '@pagespace/lib/logging/logger-config';
import { normalizeSubdomain, validatePublishSubdomain } from '@pagespace/lib/validators/subdomain';
import { isUniqueViolation } from '@pagespace/lib/services/subdomain-allocation';
import { slugify } from '@pagespace/lib/utils/utils';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
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

const PUBLISH_HOST = 'pagespace.site';

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
    throw new Error('Page not found');
  }

  if (page.type !== 'CANVAS') {
    throw new Error('Only canvas pages can be published');
  }

  // ------------------------------------------------------------------
  // 2. Load drive (resolve subdomain)
  // ------------------------------------------------------------------
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
    columns: { id: true, slug: true, publishSubdomain: true, kind: true },
  });

  if (!drive) {
    throw new Error('Drive not found');
  }

  if (isHomeDrive(drive)) {
    throw new Error('Cannot publish from a Home drive');
  }

  // Resolve subdomain: explicit > existing > allocate from slug
  let subdomain = input.subdomain ?? drive.publishSubdomain;
  if (!subdomain) {
    const candidate = normalizeSubdomain(input.subdomain ?? drive.slug);
    const validation = validatePublishSubdomain(candidate);
    if (!validation.valid) {
      throw new Error(`Invalid subdomain: ${validation.reason}`);
    }

    try {
      await db.update(drives).set({ publishSubdomain: candidate }).where(eq(drives.id, drive.id));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error('Subdomain taken, choose another');
      }
      throw err;
    }
    subdomain = candidate;
  }

  // ------------------------------------------------------------------
  // 3. Resolve path
  // ------------------------------------------------------------------
  const path = input.path ?? slugify(page.title ?? '') || pageId;

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
    faviconBaseUrl: meta.faviconHref ? undefined : undefined,
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
      throw new Error('Another page is already published at that path; choose a different path');
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

  return publishCanvasPage({
    pageId: drive.homePageId,
    driveId,
    userId,
    path: '',
  });
}

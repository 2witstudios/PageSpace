import 'server-only';

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { deletePageFromCustomHosts } from '@/lib/canvas/custom-domain-mirror';
import { clearPublishedHomeRoot, regeneratePublishedSiteFiles } from '@/lib/canvas/publish-page';

export type UnpublishPageResult =
  | { unpublished: false }
  | { unpublished: true; driveId: string; path: string };

/**
 * Take a published page off the web: its artifact, its root mirror when it is
 * the drive's home page, its copies on every custom domain, and its
 * `published_pages` row.
 *
 * The one implementation behind `DELETE /api/pages/[pageId]/publish` (the
 * author unpublishing) and the content-safety scoped takedown (an admin doing
 * it). Authorization and audit belong to the caller.
 *
 * Returns `{ unpublished: false }` when the page is not published, so a rerun
 * is a no-op. Throws when storage fails, with the row still in place, so the
 * caller never reports success while the page is still publicly reachable.
 */
export async function unpublishPage(pageId: string): Promise<UnpublishPageResult> {
  const row = await db.query.publishedPages.findFirst({
    where: eq(publishedPages.pageId, pageId),
    columns: { id: true, artifactKey: true, driveId: true, path: true },
  });

  if (!row) return { unpublished: false };

  // If this page is the drive's home page it was also mirrored to the
  // subdomain root. Clear that mirror BEFORE deleting the DB row so a failed
  // root delete surfaces as an error with the row still present — i.e. the
  // unpublish is retryable and never reports success while the page is still
  // publicly reachable at the root.
  const drv = await db.query.drives.findFirst({
    where: eq(drives.id, row.driveId),
    columns: { homePageId: true },
  });

  const isHomePage = drv?.homePageId === pageId;
  const { deletePublishedArtifact } = await import('@/lib/canvas/published-storage');
  await deletePublishedArtifact(row.artifactKey);
  if (isHomePage) {
    await clearPublishedHomeRoot(row.driveId);
  }
  // Remove the page artifact (and root mirror) from every active custom-domain
  // host prefix before deleting the DB row. Best-effort: failures are logged
  // internally and do not block the unpublish.
  await deletePageFromCustomHosts({ driveId: row.driveId, pageId, path: row.path, isHomePage });
  await db.delete(publishedPages).where(eq(publishedPages.pageId, pageId));

  // Rebuild the drive's sitemap so it no longer advertises the route we just
  // removed (and refresh robots/404 alongside it). Best-effort — the page is
  // already unpublished and the row deleted.
  await regeneratePublishedSiteFiles(row.driveId);

  return { unpublished: true, driveId: row.driveId, path: row.path };
}

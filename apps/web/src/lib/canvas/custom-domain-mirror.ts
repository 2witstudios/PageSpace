import 'server-only';

import { loggers } from '@pagespace/lib/logging/logger-config';
import { planCustomDomainMirror } from '@pagespace/lib/canvas/custom-domain-mirror';
import type { ActiveDomainRecord } from '@pagespace/lib/canvas/primary-host';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { drives } from '@pagespace/db/schema/core';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import {
  buildPublishedKey,
  copyPublishedArtifact,
  copyPublishedSiteFileArtifact,
  deletePublishedArtifact,
  clearPublishedPrefix,
  publishedArtifactExists,
  isPublishConfigured,
} from './published-storage';

/** True for the three drive-level site files that must preserve their content type on copy. */
function isSiteFileKey(key: string): boolean {
  return key.endsWith('/robots.txt') || key.endsWith('/sitemap.xml') || key.endsWith('/404.html');
}

/**
 * Return all active custom domain records for a drive. Only domains with
 * `status = 'active'` (DNS-verified + cert provisioned) are included.
 * Exported so publish-page.ts can resolve the primary host without a
 * duplicate DB query.
 */
export async function getActiveDomainRecords(driveId: string): Promise<ActiveDomainRecord[]> {
  const rows = await db
    .select({ hostname: customDomains.hostname, status: customDomains.status, createdAt: customDomains.createdAt, isPrimary: customDomains.isPrimary })
    .from(customDomains)
    .where(eq(customDomains.driveId, driveId));

  return rows.filter((r) => r.status === 'active').map((r) => ({ hostname: r.hostname, createdAt: r.createdAt, isPrimary: r.isPrimary }));
}

/** Return only the active custom hostnames for a drive (legacy internal helper). */
async function getActiveDriveHosts(driveId: string): Promise<string[]> {
  const records = await getActiveDomainRecords(driveId);
  return records.map((r) => r.hostname);
}

/**
 * Mirror a single published page artifact to every active custom-domain host
 * for the drive. When the page is the drive's home page the root mirror is
 * copied too (`published/<host>/index.html`).
 *
 * Best-effort: individual copy failures are logged but never thrown — the
 * primary publish has already succeeded and will be retried by the next
 * publish/backfill. Follows the same error-swallowing contract as
 * `regeneratePublishedSiteFiles`.
 */
export async function mirrorPublishedPageToHosts(params: {
  driveId: string;
  subdomain: string;
  path: string;
  isHomePage: boolean;
}): Promise<void> {
  const { driveId, subdomain, path, isHomePage } = params;

  try {
    if (!isPublishConfigured()) return;

    const hosts = await getActiveDriveHosts(driveId);
    if (hosts.length === 0) return;

    const { copies } = planCustomDomainMirror({
      subdomain,
      paths: [path],
      hosts,
      includeRoot: isHomePage,
    });

    await Promise.allSettled(
      copies.map(({ from, to }) =>
        copyPublishedArtifact(from, to).catch((err) => {
          loggers.api.warn('Failed to mirror page artifact to custom host', {
            from,
            to,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      ),
    );
  } catch (err) {
    loggers.api.warn('Failed to mirror published page to custom hosts', {
      driveId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Mirror all drive site files (robots.txt, sitemap.xml, 404.html) to every
 * active custom-domain host. Called after `regeneratePublishedSiteFiles` so
 * every copy of the site carries the same canonical site-level documents.
 * Best-effort.
 */
export async function mirror404ToHosts(driveId: string, subdomain: string): Promise<void> {
  try {
    if (!isPublishConfigured()) return;

    const hosts = await getActiveDriveHosts(driveId);
    if (hosts.length === 0) return;

    const { copies } = planCustomDomainMirror({
      subdomain,
      paths: [],
      hosts,
      include404: true,
      includeSiteFiles: true,
    });

    await Promise.allSettled(
      copies.map(({ from, to }) => {
        const copy = isSiteFileKey(to) ? copyPublishedSiteFileArtifact(from, to) : copyPublishedArtifact(from, to);
        return copy.catch((err) => {
          loggers.api.warn('Failed to mirror site file to custom host', {
            from,
            to,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }),
    );
  } catch (err) {
    loggers.api.warn('Failed to mirror site files to custom hosts', {
      driveId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Delete a page's artifact (and its root mirror when it is the home page) from
 * every active custom-domain host for the drive. Called during unpublish so the
 * page stops being served at custom domains.
 *
 * Best-effort: individual delete failures are logged but never thrown.
 */
export async function deletePageFromCustomHosts(params: {
  driveId: string;
  path: string;
  isHomePage: boolean;
}): Promise<void> {
  const { driveId, path, isHomePage } = params;

  try {
    if (!isPublishConfigured()) return;

    const hosts = await getActiveDriveHosts(driveId);
    if (hosts.length === 0) return;

    const deleteOps: Array<() => Promise<void>> = [];
    for (const host of hosts) {
      deleteOps.push(() => deletePublishedArtifact(buildPublishedKey(host, path)));
      if (isHomePage) {
        deleteOps.push(() => deletePublishedArtifact(buildPublishedKey(host, '')));
      }
    }

    await Promise.allSettled(
      deleteOps.map((op) =>
        op().catch((err) => {
          loggers.api.warn('Failed to delete page artifact from custom host', {
            driveId,
            path,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      ),
    );
  } catch (err) {
    loggers.api.warn('Failed to delete page from custom hosts', {
      driveId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Copy ALL currently-published artifacts for a drive to a single custom-domain
 * host prefix. Called when a domain transitions to `active` (cert provisioned +
 * DNS verified) so the host is immediately ready to serve the full published site.
 *
 * Backfills:
 *  - every page artifact (`published_pages` rows)
 *  - the root mirror when the drive's home page is published and its root exists
 *  - the drive's 404.html site file
 *
 * Per-copy best-effort: individual failures are logged and do not abort the
 * overall backfill — a partial mirror is always better than no mirror.
 */
export async function mirrorDriveToCustomHost(driveId: string, host: string): Promise<void> {
  if (!isPublishConfigured()) return;

  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
    columns: { publishSubdomain: true, homePageId: true },
  });

  const subdomain = drive?.publishSubdomain;
  if (!subdomain) return;

  const published = await db.query.publishedPages.findMany({
    where: eq(publishedPages.driveId, driveId),
    columns: { pageId: true, path: true },
  });

  const paths = published.map((r) => r.path);

  let rootExists = false;
  if (drive.homePageId && published.some((r) => r.pageId === drive.homePageId)) {
    try {
      rootExists = await publishedArtifactExists(buildPublishedKey(subdomain, ''));
    } catch {
      // Probe failure — skip root; it will be backfilled on next publish.
    }
  }

  const { copies } = planCustomDomainMirror({
    subdomain,
    paths,
    hosts: [host],
    includeRoot: rootExists,
    include404: true,
    includeSiteFiles: true,
  });

  await Promise.allSettled(
    copies.map(({ from, to }) => {
      const copy = isSiteFileKey(to) ? copyPublishedSiteFileArtifact(from, to) : copyPublishedArtifact(from, to);
      return copy.catch((err) => {
        loggers.api.warn('Failed to copy artifact during drive mirror to custom host', {
          driveId,
          host,
          from,
          to,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }),
  );
}

/**
 * Delete all artifacts under `published/<host>/` from the publish bucket.
 * Called when a custom domain is deleted or deactivated so no stale content
 * remains under that prefix.
 *
 * Throws on storage failure — the caller should handle and log appropriately.
 */
export async function clearCustomHost(host: string): Promise<void> {
  if (!isPublishConfigured()) return;
  await clearPublishedPrefix(host);
}

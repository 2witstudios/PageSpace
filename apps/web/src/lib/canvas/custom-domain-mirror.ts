import 'server-only';

import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  planCustomDomainMirror,
  resolveHostRootCopies,
  resolveBackfillRootCopy,
  type DomainOverrideRecord,
} from '@pagespace/lib/canvas/custom-domain-mirror';
import { isServingStatus } from '@pagespace/lib/canvas/cert-action';
import type { ActiveDomainRecord } from '@pagespace/lib/canvas/primary-host';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
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

/**
 * Renders a custom domain's `publishNotFoundPageId` override and writes it to
 * that host's 404.html. Passed in by the caller (`publish-page.ts`'s
 * `regeneratePublishedSiteFiles`, via `renderDomainNotFoundOverride`) rather
 * than imported directly — `publish-page.ts` already imports FROM this
 * module, so importing it back here would create a circular dependency.
 */
export type RenderDomainNotFoundOverride = (params: {
  driveId: string;
  host: string;
  pageId: string;
  subdomain: string;
  homePageId: string | null;
  publishFaviconUrl: string | null;
  publishDefaultOgImageUrl: string | null;
  ownerId: string;
}) => Promise<boolean>;

/** True for the three drive-level site files that must preserve their content type on copy. */
function isSiteFileKey(key: string): boolean {
  return key.endsWith('/robots.txt') || key.endsWith('/sitemap.xml') || key.endsWith('/404.html');
}

/**
 * Return all active custom domain records for a drive. Only domains with
 * `status = 'active'` (DNS-verified + cert provisioned) are included.
 * Excludes `platformOwned` rows (e.g. pagespace.ai) — those are an additional
 * serving alias, never the drive's canonical/SEO identity, so they must never
 * win primary-host selection (`resolvePrimaryPublishedHost`).
 * Exported so publish-page.ts can resolve the primary host without a
 * duplicate DB query.
 */
export async function getActiveDomainRecords(driveId: string): Promise<ActiveDomainRecord[]> {
  const rows = await db
    .select({
      hostname: customDomains.hostname,
      status: customDomains.status,
      createdAt: customDomains.createdAt,
      isPrimary: customDomains.isPrimary,
      platformOwned: customDomains.platformOwned,
    })
    .from(customDomains)
    .where(eq(customDomains.driveId, driveId));

  return rows
    .filter((r) => r.status === 'active' && !r.platformOwned)
    .map((r) => ({ hostname: r.hostname, createdAt: r.createdAt, isPrimary: r.isPrimary }));
}

/** A serving custom domain plus its per-domain landing/404 overrides, if any. */
interface ServingDomainRecord extends DomainOverrideRecord {
  publishNotFoundPageId: string | null;
}

/**
 * Return the custom domains for a drive that should hold mirrored content —
 * the "serving" hosts (status verified | provisioning | active), independent of
 * cert state, plus each domain's own landing/404 page overrides. This is the
 * CONTENT-mirror target: a host serves the drive's artifacts the moment DNS is
 * verified, so content no longer waits on the async Fly cert.
 *
 * Distinct from `getActiveDomainRecords`, which stays ACTIVE-only because the
 * canonical/primary host must never point at a not-yet-live host.
 */
async function getServingDriveDomains(driveId: string): Promise<ServingDomainRecord[]> {
  const rows = await db
    .select({
      hostname: customDomains.hostname,
      status: customDomains.status,
      publishLandingPageId: customDomains.publishLandingPageId,
      publishNotFoundPageId: customDomains.publishNotFoundPageId,
    })
    .from(customDomains)
    .where(eq(customDomains.driveId, driveId));

  return rows
    .filter((r) => isServingStatus(r.status))
    .map((r) => ({
      hostname: r.hostname,
      publishLandingPageId: r.publishLandingPageId,
      publishNotFoundPageId: r.publishNotFoundPageId,
    }));
}

/**
 * Mirror a single published page artifact to every serving custom-domain host
 * for the drive (verified | provisioning | active). Each host's root mirror
 * (`published/<host>/index.html`) is updated only when this publish is that
 * host's effective landing page — the drive's home page for hosts with no
 * override, or the host's own `publishLandingPageId` for hosts that have one
 * (see `resolveHostRootCopies`). A host overridden to a DIFFERENT page never
 * has its root touched by this publish.
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
  pageId: string;
  homePageId: string | null;
}): Promise<void> {
  const { driveId, subdomain, path, pageId, homePageId } = params;

  try {
    if (!isPublishConfigured()) return;

    const domains = await getServingDriveDomains(driveId);
    if (domains.length === 0) return;

    const { copies: pathCopies } = planCustomDomainMirror({
      subdomain,
      paths: [path],
      hosts: domains.map((d) => d.hostname),
    });
    const rootCopies = resolveHostRootCopies({ subdomain, pageId, path, homePageId, hosts: domains });

    await Promise.allSettled(
      [...pathCopies, ...rootCopies].map(({ from, to }) =>
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
 * serving custom-domain host (verified | provisioning | active). Called after
 * `regeneratePublishedSiteFiles` so every copy of the site carries the same
 * canonical site-level documents. Best-effort.
 *
 * A host with its own `publishNotFoundPageId` override gets its 404.html
 * rendered fresh from that page (via `renderOverride404`, injected by the
 * caller to avoid a circular import with publish-page.ts) instead of the
 * drive-wide 404.html copy. Rendered FIRST, before the copy plan is built:
 * `renderOverride404` returns `false` when its target page can't render
 * (trashed/missing — a soft-delete never clears the FK), and a host whose
 * override fails to render still needs the drive-wide 404.html fallback, not
 * a stale/absent one. robots.txt/sitemap.xml are mirrored verbatim for every
 * host regardless of override, since only the 404 page is overridable in
 * this phase.
 */
export async function mirror404ToHosts(
  driveId: string,
  subdomain: string,
  driveCtx: {
    homePageId: string | null;
    publishFaviconUrl: string | null;
    publishDefaultOgImageUrl: string | null;
    ownerId: string;
  },
  renderOverride404: RenderDomainNotFoundOverride,
): Promise<void> {
  try {
    if (!isPublishConfigured()) return;

    const domains = await getServingDriveDomains(driveId);
    if (domains.length === 0) return;

    const overrideDomains = domains.filter((d) => d.publishNotFoundPageId);
    const plainHostnames = domains.filter((d) => !d.publishNotFoundPageId).map((d) => d.hostname);

    const overrideResults = await Promise.all(
      overrideDomains.map(async (d) => {
        try {
          const rendered = await renderOverride404({
            driveId,
            host: d.hostname,
            pageId: d.publishNotFoundPageId as string,
            subdomain,
            homePageId: driveCtx.homePageId,
            publishFaviconUrl: driveCtx.publishFaviconUrl,
            publishDefaultOgImageUrl: driveCtx.publishDefaultOgImageUrl,
            ownerId: driveCtx.ownerId,
          });
          return { hostname: d.hostname, rendered };
        } catch (err) {
          loggers.api.warn('Failed to render domain 404 override', {
            driveId,
            host: d.hostname,
            error: err instanceof Error ? err.message : String(err),
          });
          return { hostname: d.hostname, rendered: false };
        }
      }),
    );

    // Every host that doesn't have a WORKING override falls back to the
    // drive-wide 404.html — plain hosts, plus any override host whose render
    // just failed.
    const fallback404Hosts = [
      ...plainHostnames,
      ...overrideResults.filter((r) => !r.rendered).map((r) => r.hostname),
    ];
    const allHostnames = domains.map((d) => d.hostname);

    const { copies: fallback404Copies } = planCustomDomainMirror({
      subdomain,
      paths: [],
      hosts: fallback404Hosts,
      include404: true,
    });
    // robots.txt/sitemap.xml are mirrored verbatim to every serving host.
    const { copies: siteFileCopies } = planCustomDomainMirror({
      subdomain,
      paths: [],
      hosts: allHostnames,
      includeSiteFiles: true,
    });

    await Promise.allSettled(
      [...fallback404Copies, ...siteFileCopies].map(({ from, to }) => {
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
 * Delete a page's artifact from every serving custom-domain host for the
 * drive (verified | provisioning | active). Also clears a host's root mirror
 * when the deleted page was serving as ITS root — either because it is the
 * drive's home page (for hosts with no override) or because it was that
 * host's own `publishLandingPageId` override — so no host is left serving a
 * stale root for a page that no longer exists. Called during unpublish.
 *
 * Best-effort: individual delete failures are logged but never thrown.
 */
export async function deletePageFromCustomHosts(params: {
  driveId: string;
  pageId: string;
  path: string;
  isHomePage: boolean;
}): Promise<void> {
  const { driveId, pageId, path, isHomePage } = params;

  try {
    if (!isPublishConfigured()) return;

    const domains = await getServingDriveDomains(driveId);
    if (domains.length === 0) return;

    const deleteOps: Array<() => Promise<void>> = [];
    for (const { hostname: host, publishLandingPageId } of domains) {
      deleteOps.push(() => deletePublishedArtifact(buildPublishedKey(host, path)));
      const isThisHostsRoot = publishLandingPageId ? publishLandingPageId === pageId : isHomePage;
      if (isThisHostsRoot) {
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
 * host prefix. Called when a domain transitions to `verified` (DNS confirmed) so
 * the host prefix is populated the moment DNS is confirmed — serving no longer
 * waits on the async Fly cert. Also re-run on `→ active` so site files adopt the
 * now-active canonical host.
 *
 * Backfills:
 *  - every page artifact (`published_pages` rows)
 *  - the root mirror: the host's own `publishLandingPageId` override page when
 *    set (via `resolveBackfillRootCopy`), else the drive's home page when
 *    published and its root mirror exists
 *  - the host's 404.html: rendered fresh from `publishNotFoundPageId` when set
 *    (via `renderOverride404`, optional — falls back to the drive-wide
 *    404.html copy when omitted or the override isn't configured)
 *  - robots.txt / sitemap.xml (never overridden per-host)
 *
 * Per-copy best-effort: individual failures are logged and do not abort the
 * overall backfill — a partial mirror is always better than no mirror.
 */
export async function mirrorDriveToCustomHost(
  driveId: string,
  host: string,
  renderOverride404?: RenderDomainNotFoundOverride,
): Promise<void> {
  if (!isPublishConfigured()) return;

  // Independent of each other — parallelized to save a round-trip.
  const [drive, domainRow] = await Promise.all([
    db.query.drives.findFirst({
      where: eq(drives.id, driveId),
      columns: {
        publishSubdomain: true,
        homePageId: true,
        ownerId: true,
        publishFaviconUrl: true,
        publishDefaultOgImageUrl: true,
      },
    }),
    db.query.customDomains.findFirst({
      where: and(eq(customDomains.driveId, driveId), eq(customDomains.hostname, host)),
      columns: { publishLandingPageId: true, publishNotFoundPageId: true },
    }),
  ]);

  const subdomain = drive?.publishSubdomain;
  if (!subdomain) return;

  const publishLandingPageId = domainRow?.publishLandingPageId ?? null;
  const publishNotFoundPageId = domainRow?.publishNotFoundPageId ?? null;

  const published = await db.query.publishedPages.findMany({
    where: eq(publishedPages.driveId, driveId),
    columns: { pageId: true, path: true },
  });

  const paths = published.map((r) => r.path);

  let homeRootExists = false;
  if (!publishLandingPageId && drive.homePageId && published.some((r) => r.pageId === drive.homePageId)) {
    try {
      homeRootExists = await publishedArtifactExists(buildPublishedKey(subdomain, ''));
    } catch {
      // Probe failure — skip root; it will be backfilled on next publish.
    }
  }

  const rootCopy = resolveBackfillRootCopy({
    subdomain,
    host,
    publishLandingPageId,
    homePageId: drive.homePageId,
    homeRootExists,
    published,
  });

  // Render the override FIRST (if configured) so its success/failure decides
  // whether the drive-wide 404.html copy below is needed — a failed render
  // (trashed/missing override page) must still get the drive-wide fallback,
  // not be left with no 404.html at all.
  let overrideRendered = false;
  if (publishNotFoundPageId && renderOverride404) {
    try {
      overrideRendered = await renderOverride404({
        driveId,
        host,
        pageId: publishNotFoundPageId,
        subdomain,
        homePageId: drive.homePageId,
        publishFaviconUrl: drive.publishFaviconUrl,
        publishDefaultOgImageUrl: drive.publishDefaultOgImageUrl,
        ownerId: drive.ownerId,
      });
    } catch (err) {
      loggers.api.warn('Failed to render domain 404 override during backfill', {
        driveId,
        host,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const { copies } = planCustomDomainMirror({
    subdomain,
    paths,
    hosts: [host],
    // Root is handled separately above (resolveBackfillRootCopy) since it may
    // source from an override page's path rather than the subdomain root.
    includeRoot: false,
    include404: !overrideRendered,
    includeSiteFiles: true,
  });
  const allCopies = rootCopy ? [...copies, rootCopy] : copies;

  await Promise.allSettled(
    allCopies.map(({ from, to }) => {
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

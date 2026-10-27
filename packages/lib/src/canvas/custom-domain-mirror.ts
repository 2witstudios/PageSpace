/**
 * Pure planner for custom-domain artifact mirroring.
 *
 * The Caddy edge serves `published/<hostname>/<path>/index.html` for a custom
 * host, exactly like it serves `published/<subdomain>/...` for *.pagespace.site.
 * Keeping a drive's published artifacts in sync under each active custom-domain
 * host prefix is therefore a set of S3 copy operations: one copy per (path, host)
 * pair, plus the root mirror and 404.html when requested.
 *
 * This module is intentionally PURE (no I/O, no env reads) so the combinatorial
 * logic is fully unit-testable without a bucket or a database. The thin shell
 * that fetches DB state and executes the copies lives in apps/web.
 */

export interface CopyOp {
  /** Source object key in the publish bucket. */
  from: string;
  /** Destination object key in the publish bucket. */
  to: string;
}

export interface PlanCustomDomainMirrorInput {
  /** The drive's pagespace.site subdomain (copy source prefix). */
  subdomain: string;
  /**
   * Already-normalized page paths from `published_pages.path` — these are the
   * values stored after `normalizePublishPath`, not raw user input. Pass every
   * path the drive currently has published.
   */
  paths: string[];
  /**
   * Active custom hostnames that should serve the site. Only `active`-status
   * domains reach here; pending/verified/failed domains are excluded by the
   * shell layer before calling this planner.
   */
  hosts: string[];
  /**
   * When true, plan a copy for the root mirror (`published/<prefix>/index.html`)
   * in addition to each page path. Set when the drive has a home page whose root
   * mirror exists at the subdomain level.
   */
  includeRoot?: boolean;
  /**
   * When true, plan a copy for the drive's `404.html` site file so unknown
   * paths under each custom host render the branded not-found page.
   */
  include404?: boolean;
  /**
   * When true, plan copies for `robots.txt` and `sitemap.xml` so every
   * custom-domain host serves the same canonical site-file inventory. When
   * the primary published host is a custom domain, the URLs in these files
   * already point at the custom domain, so the files are identical across
   * all copies and can be mirrored byte-for-byte without re-generation.
   */
  includeSiteFiles?: boolean;
}

/**
 * Build the S3 key for a published page artifact given a prefix and a
 * pre-normalized path.
 *
 * Mirrors the logic of `buildPublishedKey` in published-storage.ts without
 * importing it — that file is `server-only` and lives in apps/web, so importing
 * it from packages/lib would invert the package dependency. Exported so the
 * per-host root-override resolvers below (and their callers in apps/web) can
 * build the same keys without duplicating the path convention.
 */
export function pageKey(prefix: string, path: string): string {
  return path
    ? `published/${prefix}/${path}/index.html`
    : `published/${prefix}/index.html`;
}

/**
 * Compute the S3 copy operations required to mirror all published artifacts
 * from the drive's subdomain prefix to each of the given active custom-host
 * prefixes.
 *
 * Returns an empty copy set when `hosts` is empty (no-op).
 */
export function planCustomDomainMirror(input: PlanCustomDomainMirrorInput): { copies: CopyOp[] } {
  const { subdomain, paths, hosts, includeRoot = false, include404 = false, includeSiteFiles = false } = input;

  if (hosts.length === 0) {
    return { copies: [] };
  }

  const copies: CopyOp[] = [];

  for (const host of hosts) {
    for (const path of paths) {
      copies.push({ from: pageKey(subdomain, path), to: pageKey(host, path) });
    }

    if (includeRoot) {
      copies.push({ from: pageKey(subdomain, ''), to: pageKey(host, '') });
    }

    if (include404) {
      copies.push({
        from: `published/${subdomain}/404.html`,
        to: `published/${host}/404.html`,
      });
    }

    if (includeSiteFiles) {
      copies.push({
        from: `published/${subdomain}/robots.txt`,
        to: `published/${host}/robots.txt`,
      });
      copies.push({
        from: `published/${subdomain}/sitemap.xml`,
        to: `published/${host}/sitemap.xml`,
      });
    }
  }

  return { copies };
}

/**
 * A custom domain that may override which published page backs its root and
 * 404, instead of inheriting the drive-wide home page / not-found page. Null
 * fields mean "no override — use the drive default", matching
 * `custom_domains.publishLandingPageId` / `publishNotFoundPageId`.
 */
export interface DomainOverrideRecord {
  hostname: string;
  publishLandingPageId: string | null;
}

/**
 * Resolve, for a single (pageId, path) publish event, which serving hosts
 * should have their root artifact (`published/<host>/index.html`) updated to
 * this page's bytes — and decide the copy for each.
 *
 * A host with no `publishLandingPageId` override falls back to the drive-wide
 * home page: it gets the copy only when this publish IS the drive's home
 * page. A host with an override gets the copy only when this publish IS its
 * own override page — critically, publishing the drive's home page must NOT
 * touch an overridden host's root, since that host intentionally diverges
 * from the drive default.
 *
 * Sources directly from the page's own slug artifact
 * (`pageKey(subdomain, path)`) rather than the subdomain's root object — the
 * two are guaranteed byte-identical for the home-page case (`syncPublishedHomeRoot`
 * copies the home page's slug artifact to the subdomain root), so this is
 * equivalent for the default case while also being the only correct source
 * for an override (which has no subdomain-root counterpart of its own).
 */
export function resolveHostRootCopies(input: {
  subdomain: string;
  pageId: string;
  path: string;
  homePageId: string | null;
  hosts: DomainOverrideRecord[];
}): CopyOp[] {
  const { subdomain, pageId, path, homePageId, hosts } = input;
  const from = pageKey(subdomain, path);

  return hosts
    .filter((h) => (h.publishLandingPageId ? h.publishLandingPageId === pageId : pageId === homePageId))
    .map((h) => ({ from, to: pageKey(h.hostname, '') }));
}

/**
 * Resolve the root-artifact copy for a single host during a full drive→host
 * backfill (`mirrorDriveToCustomHost`), given the drive's current published
 * pages. Returns null when there is nothing to copy yet (override page or
 * home page not published).
 *
 * Mirrors `resolveHostRootCopies`'s override-wins precedence, but works from
 * a full `published_pages` snapshot instead of a single in-flight publish
 * event, since a backfill has no "page just published" context.
 */
export function resolveBackfillRootCopy(input: {
  subdomain: string;
  host: string;
  publishLandingPageId: string | null;
  homePageId: string | null;
  homeRootExists: boolean;
  published: Array<{ pageId: string; path: string }>;
}): CopyOp | null {
  const { subdomain, host, publishLandingPageId, homePageId, homeRootExists, published } = input;

  if (publishLandingPageId) {
    const row = published.find((r) => r.pageId === publishLandingPageId);
    return row ? { from: pageKey(subdomain, row.path), to: pageKey(host, '') } : null;
  }

  if (homePageId && homeRootExists) {
    return { from: pageKey(subdomain, ''), to: pageKey(host, '') };
  }

  return null;
}

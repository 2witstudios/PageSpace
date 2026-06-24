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
 * it from packages/lib would invert the package dependency.
 */
function pageKey(prefix: string, path: string): string {
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

/**
 * Pure resolver for a drive's "primary published host".
 *
 * Every custom-domain mirror is byte-for-byte identical to the subdomain copy
 * (no re-render). To consolidate SEO we pick ONE host as canonical — the same
 * value baked into `<link rel=canonical>`, `og:url`, `sitemap.xml <loc>`, and
 * `robots.txt Sitemap:` across ALL copies. When multiple copies point at the
 * same primary host, search engines consolidate ranking signals on that one URL.
 *
 * Primary-host selection rule (deterministic):
 *   - If the drive has an active custom domain explicitly flagged `isPrimary`,
 *     that domain is the PRIMARY (the user's chosen host). Ties between multiple
 *     flagged domains are broken by earliest `createdAt` then hostname.
 *   - Otherwise, if the drive has ≥1 active custom domain, the PRIMARY is the
 *     active domain with the earliest `createdAt` (earliest-registered, not
 *     earliest-activated, because the schema has no separate activation
 *     timestamp). Ties (same timestamp) are broken by hostname lexicographic
 *     order so the result is always predictable.
 *   - Otherwise fall back to `<subdomain>.<publishHost>` (the pagespace.site
 *     subdomain, which is always authoritative when no custom domain is active).
 *
 * Keeping this function pure (no I/O, no env reads) means the non-trivial part
 * — sorting + fallback — is fully unit-testable without a DB or network call.
 * The thin shell that fetches the active domains from the DB calls this.
 */

/**
 * Minimal shape of an active custom domain needed for primary-host resolution.
 * `createdAt` is the row creation timestamp (earliest-registered), used as a
 * stable deterministic tie-breaker. There is no separate activation timestamp
 * in the schema.
 */
export interface ActiveDomainRecord {
  hostname: string;
  createdAt: Date;
  /** True when the user explicitly selected this domain as the drive's primary. */
  isPrimary?: boolean;
}

/**
 * Resolve the primary published host for a drive.
 *
 * @param subdomain    - Drive's allocated pagespace.site subdomain.
 * @param publishHost  - The root publish hostname (e.g. `pagespace.site`).
 * @param activeDomains - Active custom domains for the drive (any order).
 * @returns The hostname that should be used for canonical/og:url/sitemap URLs.
 */
export function resolvePrimaryPublishedHost({
  subdomain,
  publishHost,
  activeDomains,
}: {
  subdomain: string;
  publishHost: string;
  activeDomains: ActiveDomainRecord[];
}): string {
  if (activeDomains.length === 0) {
    return `${subdomain}.${publishHost}`;
  }

  const byCreatedThenHostname = (a: ActiveDomainRecord, b: ActiveDomainRecord) => {
    const dt = a.createdAt.getTime() - b.createdAt.getTime();
    if (dt !== 0) return dt;
    return a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0;
  };

  // An explicitly-selected primary wins over the earliest-created default.
  const flagged = activeDomains.filter((d) => d.isPrimary);
  const pool = flagged.length > 0 ? flagged : activeDomains;

  const sorted = [...pool].sort(byCreatedThenHostname);
  return sorted[0].hostname;
}

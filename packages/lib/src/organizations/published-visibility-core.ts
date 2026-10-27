/**
 * Published-site visibility — the pure half (Spec POL-4, POL-1 "suspend, never delete").
 *
 * A published site is a set of static objects under `published/<prefix>/` in a public bucket, served by an edge
 * that never reads the database (PageSpace-Deploy publishing/Caddyfile.pagespace-site.snippet). A marker on a
 * `published_pages` row therefore cannot stop anyone reading it: the only place "paused" can take effect is the
 * bucket. So a paused site is MOVED, not deleted, to `suspended/<prefix>/` (same bucket, which is not public:
 * the bucket policy grants public read to `published/*` only), and restored by moving it back. The objects, their
 * bytes and their content types survive; the public URL answers 404 in between.
 *
 * Visibility is a pure function of the org's LIVE policies (prefixVisible), never of a stored marker, so a stale
 * or missing marker cannot leave a site up or hold one down.
 */
import type { OrgPolicies } from './policies-core';

export const PUBLISHED_PREFIX = 'published/';
export const PARKED_PREFIX = 'suspended/';

/** What kind of host a prefix under `published/` belongs to. */
export type PrefixKind = 'site' | 'domain' | 'platform_domain';

/** `published/x/y` -> `suspended/x/y`; null for a key that is not under the public prefix. */
export function parkedKeyOf(publicKey: string): string | null {
  return publicKey.startsWith(PUBLISHED_PREFIX) ? PARKED_PREFIX + publicKey.slice(PUBLISHED_PREFIX.length) : null;
}

/** `suspended/x/y` -> `published/x/y`; null for a key that is not under the parked prefix. */
export function publicKeyOf(parkedKey: string): string | null {
  return parkedKey.startsWith(PARKED_PREFIX) ? PUBLISHED_PREFIX + parkedKey.slice(PARKED_PREFIX.length) : null;
}

/**
 * Should the objects under this prefix be publicly readable? A drive's own `<sub>.pagespace.site` follows
 * publishing; an org's custom domain needs publishing AND custom domains; a platform-owned alias of org content
 * follows publishing only (the custom-domains switch is about the org's own domains). No policies = a personal
 * drive, which no org policy restricts.
 */
export function prefixVisible(policies: OrgPolicies | null, kind: PrefixKind): boolean {
  if (policies === null) return true;
  switch (kind) {
    case 'site':
    case 'platform_domain':
      return policies.publishWeb;
    case 'domain':
      return policies.publishWeb && policies.customDomains;
  }
}

/** The object store the move needs: list by prefix, server-side copy, delete, and existence. */
export interface PublishedObjectStore {
  listKeys(prefix: string): Promise<string[]>;
  /** The immediate sub-prefixes under `root` (`suspended/` -> `['acme', 'docs.example.com']`), names only. */
  listPrefixes(root: string): Promise<string[]>;
  exists(key: string): Promise<boolean>;
  copy(fromKey: string, toKey: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * Move every object under `fromPrefix` to `toPrefix`, one at a time: copy, then delete the source. The order is
 * the safety property: a failure between the two leaves BOTH copies, never neither, and a re-run finishes the
 * job, so a crash never loses a page and never leaves half a site in an unknown state.
 *
 * `overwrite` (default true) replaces an existing destination object. Restoring passes false: a public object
 * that already exists is NEWER than the parked copy (something wrote it while the site was down), so it is kept
 * and the parked copy is dropped rather than resurrecting old content over it.
 */
export async function movePrefix(
  store: PublishedObjectStore,
  fromPrefix: string,
  toPrefix: string,
  options: { overwrite?: boolean } = {},
): Promise<{ moved: number; kept: number }> {
  const overwrite = options.overwrite ?? true;
  let moved = 0;
  let kept = 0;
  for (const fromKey of await store.listKeys(fromPrefix)) {
    const toKey = toPrefix + fromKey.slice(fromPrefix.length);
    if (!overwrite && (await store.exists(toKey))) {
      await store.remove(fromKey);
      kept += 1;
      continue;
    }
    await store.copy(fromKey, toKey);
    await store.remove(fromKey);
    moved += 1;
  }
  return { moved, kept };
}

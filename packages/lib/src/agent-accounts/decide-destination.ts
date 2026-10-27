/**
 * `decideDestination` — may the executor send a credentialed request to this
 * URL (L2·G2; ADR 0004 §3.2 origin pinning; threat model C1, A7)?
 *
 * An `initial` hop is allowed only when its canonical origin (the one origin
 * rule, `canonicalOriginOf`) is EXACTLY one of the account's pinned origins:
 * scheme, host and port — `:8443` is another origin, a subdomain is another
 * origin, a parent domain is another origin.
 *
 * A `redirect` hop is never allowed. Every request the executor sends carries
 * the account's credential, so following a redirect is a credentialed
 * redirect: to another origin it would hand the key to a host nobody pinned,
 * and on the same origin it would send it to a path no approval covered. The
 * target is still checked, so the audit and the caller learn which it was,
 * and the 3xx is released to the caller instead of followed. Pure; decided
 * before any network I/O.
 */
import type { CanonicalOrigin } from './canonical-request';
import { canonicalOriginOf, type OriginRefusal } from './normalize-origin';

export type DestinationHop = 'initial' | 'redirect';

export type DestinationVerdict =
  | { readonly allow: true; readonly origin: CanonicalOrigin }
  | { readonly allow: false; readonly reason: OriginRefusal | 'origin_not_allowed' | 'credentialed_redirect' };

export function decideDestination({
  url,
  base,
  allowedOrigins,
  hop,
}: {
  readonly url: string;
  /** The URL the redirect answered; resolves a relative `Location`. */
  readonly base?: string;
  readonly allowedOrigins: readonly CanonicalOrigin[];
  readonly hop: DestinationHop;
}): DestinationVerdict {
  let parsed: URL;
  try {
    parsed = base === undefined ? new URL(url) : new URL(url, base);
  } catch {
    return { allow: false, reason: 'malformed' };
  }
  const origin = canonicalOriginOf(parsed);
  if (!origin.ok) return { allow: false, reason: origin.reason };
  if (!allowedOrigins.includes(origin.origin)) return { allow: false, reason: 'origin_not_allowed' };
  if (hop !== 'initial') return { allow: false, reason: 'credentialed_redirect' };
  return { allow: true, origin: origin.origin };
}

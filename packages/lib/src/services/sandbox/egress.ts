/**
 * Sandbox egress network policy construction (pure).
 *
 * Maps a policy's `egressAllowlist` to a `@vercel/sandbox` `NetworkPolicy`.
 * Egress is default-DENY: an empty allowlist yields `'deny-all'`, so v1 (whose
 * every profile ships an empty allowlist) has no outbound network at all.
 *
 * When the allowlist is deliberately widened for an external package registry
 * (npm / PyPI), the resulting policy still NEVER reaches internal targets:
 *
 *  - the allowlist is a domain allow-list (record form), so any host not listed
 *    is denied — PageSpace's own APIs, the DB, and the object store are never
 *    listed and therefore unreachable; and
 *  - `subnets.deny` explicitly blocks the cloud metadata endpoint and every
 *    RFC1918 / CGNAT / link-local range. Subnet denies take precedence over
 *    domain allows, so even a listed host that resolves to a private/metadata
 *    IP (a DNS-rebinding / SSRF attempt) is dropped.
 *
 * The function builds the allow map from a frozen, deduped copy of the input,
 * so a caller cannot mutate the shared policy array through the returned object.
 */

import type { NetworkPolicy } from '@vercel/sandbox';

// Metadata endpoint + the private/shared address space that must never be
// reachable from an untrusted sandbox, regardless of any domain allow.
const INTERNAL_DENY_CIDRS: readonly string[] = Object.freeze([
  '169.254.0.0/16', // link-local, incl. the 169.254.169.254 metadata endpoint
  '10.0.0.0/8', // RFC1918 private
  '172.16.0.0/12', // RFC1918 private
  '192.168.0.0/16', // RFC1918 private
  '100.64.0.0/10', // RFC6598 carrier-grade NAT (internal infra)
  '127.0.0.0/8', // loopback
  'fd00::/8', // IPv6 unique-local
  'fe80::/10', // IPv6 link-local
]);

export function buildSandboxNetworkPolicy({
  egressAllowlist = [],
}: {
  egressAllowlist?: readonly string[];
} = {}): NetworkPolicy {
  const hosts = [...new Set(egressAllowlist)].filter((h) => h.length > 0);
  if (hosts.length === 0) {
    return 'deny-all';
  }
  return {
    allow: Object.fromEntries(hosts.map((host) => [host, []])),
    subnets: { deny: [...INTERNAL_DENY_CIDRS] },
  };
}

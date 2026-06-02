/**
 * Sprite egress network policy construction (pure).
 *
 * Maps a policy's `egressAllowlist` to a Fly Sprites L3 `NetworkPolicy` — an
 * ordered, domain-matched allow/deny rule list applied to the Sprite via the
 * authenticated policy API. Egress is default-DENY: the policy ALWAYS ends in a
 * terminating `{ domain: '*', action: 'deny' }` catch-all, so anything not
 * explicitly allowed (including every internal Fly target) is dropped. v1 ships
 * an empty allowlist on every profile, so the policy is pure deny-all — no
 * outbound network at all.
 *
 * Fly-shaped SSRF defence (NOT the AWS `169.254.169.254` shape): when the
 * allowlist is deliberately widened for an external registry, the policy first
 * lists EXPLICIT denies for the internal Fly surface — the 6PN `*.internal`
 * DNS namespace (apps, Postgres, the `_api.internal` metadata endpoint),
 * Flycast, and the Tigris object store — placed BEFORE any allow, so even a
 * later misconfiguration that allowed `*` could not reach them. The IP-level
 * 6PN (`fdaa::/8`) isolation is a deployment concern (a Sprite is meant to sit
 * on a separate `fdf::` prefix with no 6PN route and no `*.internal`
 * resolution; verify empirically before exposure) — it cannot be expressed as a
 * domain rule and is intentionally not encoded here.
 *
 * The allow map is built from a frozen, deduped copy of the input so a caller
 * cannot mutate the shared policy array through the returned object.
 */

import type { NetworkPolicy, PolicyRule } from '@fly/sprites';

// Internal Fly domains an untrusted Sprite must never reach. Denied explicitly
// (and first) as defence in depth on top of the default-deny catch-all.
const INTERNAL_DENY_DOMAINS: readonly string[] = Object.freeze([
  '*.internal', // 6PN app DNS, incl. Postgres and the _api.internal metadata endpoint
  '_api.internal', // Fly metadata endpoint (explicit, in case *.internal matching is literal)
  '*.flycast', // Flycast private service addresses
  '*.tigris.dev', // Tigris object store
  'fly.storage.tigris.dev', // Tigris S3 endpoint (explicit)
]);

const DENY_ALL: PolicyRule = Object.freeze({ domain: '*', action: 'deny' });

export function buildSpriteNetworkPolicy({
  egressAllowlist = [],
}: {
  egressAllowlist?: readonly string[];
} = {}): NetworkPolicy {
  const hosts = [...new Set(egressAllowlist)].filter((h) => h.length > 0);
  if (hosts.length === 0) {
    // Default-deny: no outbound at all.
    return { rules: [{ ...DENY_ALL }] };
  }
  return {
    rules: [
      ...INTERNAL_DENY_DOMAINS.map((domain): PolicyRule => ({ domain, action: 'deny' })),
      ...hosts.map((domain): PolicyRule => ({ domain, action: 'allow' })),
      { ...DENY_ALL },
    ],
  };
}

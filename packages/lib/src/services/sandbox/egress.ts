/**
 * Sprite egress network policy construction (pure).
 *
 * Maps a policy's `egressAllowlist` to a Fly Sprites L3 `NetworkPolicy` — an
 * ordered, domain-matched rule list applied to the Sprite via the authenticated
 * policy API. Egress is default-DENY: the policy ALWAYS ends in a terminating
 * `{ domain: '*', action: 'deny' }` catch-all, so anything not explicitly allowed
 * is dropped. v1 ships an empty allowlist on every profile, so the policy is pure
 * deny-all — no outbound network at all.
 *
 * Internal-target blocking is the SDK's `{ include: 'defaults' }` preset — the
 * only lever the Sprites policy API exposes for the internal surface (6PN
 * `*.internal`, the `_api.internal` metadata endpoint, Flycast, Tigris). We
 * prepend it BEFORE any allow whenever the allowlist is deliberately widened for
 * an external registry, so even a later misconfiguration that allowed `*` could
 * not reach the internal surface. The empty-allowlist (v1) case stays a pure
 * deny-all and does not lean on the preset's semantics at all.
 *
 * KNOWN LIMITATION — domain rules cannot block IP-LITERAL egress: a policy keyed
 * on `domain` only matches name-resolved traffic, so a Sprite dialing a raw
 * `fdaa::…`/`169.254.169.254` address bypasses it. The IP-level 6PN (`fdaa::/8`)
 * / metadata isolation is therefore a DEPLOYMENT concern — a Sprite is meant to
 * sit on a separate `fdf::` prefix with no 6PN route and no `*.internal`
 * resolution. That empirical 6PN/metadata gate (G1) lives in the enablement
 * checklist, verified before exposure, NOT in this domain-rule builder.
 *
 * The allow map is built from a frozen, deduped copy of the input so a caller
 * cannot mutate the shared policy array through the returned object.
 */

import type { NetworkPolicy, PolicyRule } from '@fly/sprites';

// The SDK's curated internal-blocking preset (mutually exclusive with `domain`).
// This is the maintained replacement for a hand-rolled `*.internal` / Tigris /
// Flycast deny list — the SDK owns keeping it complete.
const INCLUDE_DEFAULTS: PolicyRule = Object.freeze({ include: 'defaults' });

const DENY_ALL: PolicyRule = Object.freeze({ domain: '*', action: 'deny' });

export function buildSpriteNetworkPolicy({
  egressAllowlist = [],
}: {
  egressAllowlist?: readonly string[];
} = {}): NetworkPolicy {
  const hosts = [...new Set(egressAllowlist)].filter((h) => h.length > 0);
  if (hosts.length === 0) {
    // Default-deny: no outbound at all. Pure deny-all — no preset semantics.
    return { rules: [{ ...DENY_ALL }] };
  }
  return {
    rules: [
      // Internal surface denied first, via the SDK preset, so a widened allowlist
      // can never reach it even if a later rule allowed `*`.
      { ...INCLUDE_DEFAULTS },
      ...hosts.map((domain): PolicyRule => ({ domain, action: 'allow' })),
      { ...DENY_ALL },
    ],
  };
}

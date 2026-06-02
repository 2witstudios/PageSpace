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
 * Allowlist entries are sanitized first (`sanitizeEgressAllowlist`): trimmed,
 * lowercased, and restricted to literal DNS hostnames. A wildcard `'*'`, an IP
 * literal, or any non-host string (URL, scheme, `host:port`, path) is DROPPED —
 * `'*'` would otherwise emit an allow-all rule that short-circuits the
 * terminating deny under first-match-wins ordering, and an IP "allow" is a
 * silent no-op (Sprites `domain` rules match DNS patterns, never IP literals).
 *
 * Internal-target blocking is the SDK's `{ include: 'defaults' }` preset — the
 * only lever the Sprites policy API exposes for the internal surface (6PN
 * `*.internal`, the `_api.internal` metadata endpoint, Flycast, Tigris). We
 * prepend it BEFORE any allow whenever the allowlist is deliberately widened for
 * an external registry, so the internal surface is denied first regardless of
 * later rules. The empty-allowlist (v1) case stays a pure deny-all and does not
 * lean on the preset's semantics at all.
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

import { isIP } from 'node:net';
import type { NetworkPolicy, PolicyRule } from '@fly/sprites';

// The SDK's curated internal-blocking preset (mutually exclusive with `domain`).
// This is the maintained replacement for a hand-rolled `*.internal` / Tigris /
// Flycast deny list — the SDK owns keeping it complete.
const INCLUDE_DEFAULTS: PolicyRule = Object.freeze({ include: 'defaults' });

const DENY_ALL: PolicyRule = Object.freeze({ domain: '*', action: 'deny' });

// A literal DNS hostname: 1–253 chars, dot-separated labels of letters/digits/
// hyphens (no leading/trailing hyphen per label). Deliberately strict — only a
// resolvable host pattern is a valid allow rule for a default-deny egress.
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Canonicalize and validate an egress allowlist into the literal hostnames safe
 * to emit as Sprites `domain` allow rules. Fail-closed: a wildcard `'*'` (which
 * would short-circuit the terminating deny under first-match-wins ordering), an
 * IP literal (Sprites `domain` rules are DNS-pattern only — IPs are not matched,
 * so an IP "allow" is a silent no-op that misleads), or any non-host string
 * (URL, scheme, path, `host:port`) is dropped rather than passed through.
 */
export function sanitizeEgressAllowlist(egressAllowlist: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const raw of egressAllowlist) {
    const host = raw.trim().toLowerCase();
    if (host.length === 0 || host === '*') continue;
    if (isIP(host) !== 0) continue; // reject IPv4/IPv6 literals
    if (!HOSTNAME_RE.test(host)) continue; // reject URLs, schemes, host:port, paths
    if (seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

export function buildSpriteNetworkPolicy({
  egressAllowlist = [],
}: {
  egressAllowlist?: readonly string[];
} = {}): NetworkPolicy {
  const hosts = sanitizeEgressAllowlist(egressAllowlist);
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

/**
 * Sprite egress network policy construction (pure).
 *
 * Maps a policy's `egressAllowlist` (or `egressMode: 'open'`) to a Fly Sprites
 * L3 `NetworkPolicy` — an ordered, domain-matched rule list applied to the Sprite
 * via the authenticated policy API.
 *
 * Two modes:
 *  - `'allowlist'` (default): deny-by-default. The policy ends in a terminating
 *    `{ domain: '*', action: 'deny' }` catch-all. v1 ships an empty allowlist,
 *    so the policy is pure deny-all — no outbound at all.
 *  - `'open'`: allow all public internet. Returns `[INCLUDE_DEFAULTS, allow-*]`.
 *    Used exclusively by the human terminal (admin-gated, isolated Sprite) where
 *    the tight allowlist would block coding CLIs that need their provider hosts.
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

// The Fly internal surface we deny EXPLICITLY rather than trusting the SDK's
// `{ include: 'defaults' }` preset — no Sprites doc states that preset blocks the
// internal surface (it is documented only as an *allowlist* of LLM-friendly
// destinations), so under full egress we must not assume it does. These are
// belt-and-suspenders DNS-layer denies; they cannot block IP-literal/6PN egress
// (a domain rule only matches name-resolved traffic), which is why the real
// boundary is verified containment (see `containment.ts`), not these rules.
const INTERNAL_SURFACE_DENY_DOMAINS: readonly string[] = Object.freeze([
  '_api.internal', // Fly Machines API over 6PN
  '*.internal', // 6PN app/private-network names
  'flycast', // Flycast apex (a `*.flycast` wildcard may not match the apex)
  '*.flycast', // Flycast internal service addresses
  'fly.storage.tigris.dev', // Tigris authed S3 apex
  '*.fly.storage.tigris.dev', // Tigris authed S3 subdomains
  't3.tigrisfiles.io', // Tigris public object-storage apex
  '*.t3.tigrisfiles.io', // Tigris public object-storage subdomains
]);

/**
 * Explicit deny rules for the Fly internal surface, independent of the SDK
 * `{ include: 'defaults' }` preset. Returns a FRESH array of fresh rule objects on
 * every call (clone-safe — a caller cannot mutate a shared policy). Ordered so the
 * internal surface is denied first when composed ahead of any allow under
 * first-match-wins.
 */
export function buildInternalSurfaceDenyRules(): PolicyRule[] {
  return INTERNAL_SURFACE_DENY_DOMAINS.map((domain): PolicyRule => ({ domain, action: 'deny' }));
}

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
  egressMode = 'allowlist',
}: {
  egressAllowlist?: readonly string[];
  egressMode?: 'allowlist' | 'open';
} = {}): NetworkPolicy {
  // Open mode: allow all public internet, but deny the Fly internal surface FIRST
  // under first-match-wins. We emit our OWN explicit internal denies
  // (`buildInternalSurfaceDenyRules`) rather than trusting the SDK's
  // `{ include: 'defaults' }` preset — no Sprites doc states that preset blocks the
  // internal surface — then keep the preset too (belt-and-suspenders), then the
  // catch-all allow. The allow-all is emitted directly — NOT routed through
  // sanitizeEgressAllowlist, which intentionally strips '*'.
  if (egressMode === 'open') {
    return {
      rules: [
        ...buildInternalSurfaceDenyRules(),
        { ...INCLUDE_DEFAULTS },
        { domain: '*', action: 'allow' },
      ],
    };
  }

  const hosts = sanitizeEgressAllowlist(egressAllowlist);
  if (hosts.length === 0) {
    // Default-deny: no outbound at all. Pure deny-all — no preset semantics.
    return { rules: [{ ...DENY_ALL }] };
  }
  return {
    rules: [
      // Internal surface denied first, via the SDK preset — defence in depth on
      // top of the allowlist sanitization, so a widened allowlist can never reach
      // the internal surface regardless of later rules.
      { ...INCLUDE_DEFAULTS },
      ...hosts.map((domain): PolicyRule => ({ domain, action: 'allow' })),
      { ...DENY_ALL },
    ],
  };
}

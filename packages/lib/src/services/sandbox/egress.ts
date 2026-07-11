/**
 * Sprite egress network policy construction (pure).
 *
 * Maps a policy's `egressAllowlist` (or `egressMode: 'open'`) to a Fly Sprites
 * L3 `NetworkPolicy` — a domain-matched rule list applied to the Sprite via the
 * authenticated policy API. The platform resolves rule precedence by
 * SPECIFICITY, not array order: per docs.sprites.dev/concepts/networking,
 * "More specific rules win: an exact match beats a subdomain wildcard, which
 * beats the global wildcard." We still emit rules in a readable order (denies
 * ahead of the broad allow), but correctness rests on specificity, not position.
 *
 * Two modes:
 *  - `'allowlist'` (default): deny-by-default. The policy ends in a global
 *    `{ domain: '*', action: 'deny' }` catch-all; each allowed host is a more
 *    specific rule that beats it. v1 ships an empty allowlist, so the policy is a
 *    pure deny-all — no outbound at all.
 *  - `'open'`: allow all public internet via a global `{ domain: '*', action:
 *    'allow' }`. Used exclusively by the human terminal (admin-gated, isolated
 *    Sprite) where the tight allowlist would block coding CLIs that need their
 *    provider hosts.
 *
 * Allowlist entries are sanitized first (`sanitizeEgressAllowlist`): trimmed,
 * lowercased, and restricted to literal DNS hostnames and `*.`-prefixed
 * subdomain wildcards. A bare wildcard `'*'`, an IP literal, or any non-host
 * string (URL, scheme, `host:port`, path) is DROPPED — a bare `'*'` allow is the
 * global wildcard and would allow everything past the terminating deny, and an
 * IP "allow" is a silent no-op (Sprites `domain` rules match DNS patterns, never
 * IP literals).
 *
 * Internal-surface protection is EXPLICIT deny rules
 * (`buildInternalSurfaceDenyRules`) plus the platform's own guarantees — NOT the
 * `{ include: 'defaults' }` preset, which the docs describe purely as an
 * allowlist convenience: it "pulls
 * in the common development domains, GitHub, npm, PyPI, Docker Hub, and the major
 * AI APIs among them, so package installs and model calls work without listing
 * every host yourself." `defaults` allows hosts; it denies nothing. Our internal
 * denies are exact/subdomain-wildcard rules, so by the specificity precedence
 * above they beat a global `{ domain: '*' }` allow regardless of position.
 *
 * The platform also blocks IP-level egress on its own: "Private IPs are always
 * blocked, so a Sprite can't reach into private network ranges," and "Raw IP
 * connections are blocked unless the IP was resolved from an allowed domain. You
 * can't route around the allowlist by dialing an address directly." A `domain`
 * rule cannot match an IP literal, but it does not have to — the platform gate
 * covers that surface. The dedicated 6PN/metadata containment topology (a Sprite
 * on a separate `fdf::` prefix with no 6PN route and no `*.internal` resolution)
 * is a DEPLOYMENT concern verified in the enablement checklist (G1) before
 * exposure, NOT this domain-rule builder; see `containment.ts`.
 *
 * The allow map is built from a frozen, deduped copy of the input so a caller
 * cannot mutate the shared policy array through the returned object.
 */

import { isIP } from 'node:net';
import type { NetworkPolicy, PolicyRule } from '@fly/sprites';

const DENY_ALL: PolicyRule = Object.freeze({ domain: '*', action: 'deny' });

const ALLOW_ALL: PolicyRule = Object.freeze({ domain: '*', action: 'allow' });

// The Fly internal surface we deny EXPLICITLY. These are defense-in-depth
// DNS-layer denies: each is an exact host or a `*.`-subdomain wildcard, both of
// which are more specific than a global `{ domain: '*' }` rule, so per the
// documented precedence ("an exact match beats a subdomain wildcard, which beats
// the global wildcard") they win over an open-mode allow-all. They are redundant
// with the platform's own guarantees ("Private IPs are always blocked"; "Raw IP
// connections are blocked unless the IP was resolved from an allowed domain") for
// the IP surface, but a name-resolved dial of e.g. `_api.internal` is exactly
// what these DNS-layer rules cover. They are NOT a substitute for verified
// containment (see `containment.ts`) — that remains the real boundary.
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

// The internal-surface DNS zones a caller must never be able to ALLOW. Derived
// from the deny list (leading `*.` stripped, deduped) so the two stay in
// lockstep — a future deny addition automatically extends this filter. Needed
// because the internal denies are wildcards/apexes: a caller-supplied allow that
// overlaps one would win (or, wildcard-vs-wildcard, MIGHT win — the docs only
// rank exact > subdomain wildcard > global, not two wildcards) and reopen the
// surface. So `sanitizeEgressAllowlist` drops any entry that overlaps a zone.
const INTERNAL_SURFACE_ZONES: readonly string[] = Object.freeze(
  Array.from(new Set(INTERNAL_SURFACE_DENY_DOMAINS.map((d) => d.replace(/^\*\./, '')))),
);

/**
 * True when an allowlist entry would overlap the internal surface. `base` is the
 * entry with any leading `*.` stripped; `isWildcard` says whether the original
 * entry was a `*.`-subdomain wildcard. Two overlap directions:
 *  - the entry IS an internal zone or a subdomain of one (e.g. `foo.internal`
 *    beats `*.internal`; `*.internal` itself; `t3.tigrisfiles.io`); OR
 *  - the entry is a WILDCARD whose base is an ANCESTOR of a zone (e.g.
 *    `*.tigrisfiles.io` matches `<bucket>.t3.tigrisfiles.io`), so the allow could
 *    reach into the internal surface.
 * A non-wildcard entry only matches itself, so only the first direction applies.
 */
function targetsInternalSurface(base: string, isWildcard: boolean): boolean {
  return INTERNAL_SURFACE_ZONES.some((zone) => {
    if (base === zone || base.endsWith(`.${zone}`)) return true; // entry is/descends a zone
    if (isWildcard && zone.endsWith(`.${base}`)) return true; // wildcard ancestor of a zone
    return false;
  });
}

/**
 * Explicit deny rules for the Fly internal surface. Returns a FRESH array of
 * fresh rule objects on every call (clone-safe — a caller cannot mutate a shared
 * policy). Every entry is an exact host or `*.`-subdomain wildcard, so by the
 * documented specificity precedence it beats a global `{ domain: '*' }` allow
 * regardless of position; we still compose them ahead of any broad allow for
 * readability.
 */
export function buildInternalSurfaceDenyRules(): PolicyRule[] {
  return INTERNAL_SURFACE_DENY_DOMAINS.map((domain): PolicyRule => ({ domain, action: 'deny' }));
}

// A literal DNS hostname: 1–253 chars, dot-separated labels of letters/digits/
// hyphens (no leading/trailing hyphen per label). Deliberately strict — only a
// resolvable host pattern is a valid allow rule for a default-deny egress.
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const WILDCARD_PREFIX = '*.';

/**
 * Canonicalize and validate an egress allowlist into the domain patterns safe to
 * emit as Sprites `domain` allow rules: literal hostnames and `*.`-prefixed
 * subdomain wildcards (e.g. `*.githubusercontent.com`), the two forms the
 * documented grammar and precedence support ("an exact match beats a subdomain
 * wildcard, which beats the global wildcard"). Fail-closed: a bare wildcard `'*'`
 * (the global wildcard — an allow-all that would defeat deny-by-default), an IP
 * literal (Sprites `domain` rules are DNS-pattern only — IPs are not matched, so
 * an IP "allow" is a silent no-op that misleads; the platform blocks raw IPs on
 * its own), or any non-host string (URL, scheme, path, `host:port`) is dropped
 * rather than passed through. Entries inside the internal-surface zones are also
 * dropped so a caller can never emit an allow that beats the wildcard internal
 * deny under the documented precedence.
 */
export function sanitizeEgressAllowlist(egressAllowlist: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const raw of egressAllowlist) {
    const entry = raw.trim().toLowerCase();
    if (entry.length === 0 || entry === '*') continue;
    // The label validated is the entry itself, or — for a subdomain wildcard —
    // the base host after the `*.` prefix.
    const isWildcard = entry.startsWith(WILDCARD_PREFIX);
    const base = isWildcard ? entry.slice(WILDCARD_PREFIX.length) : entry;
    if (base.length === 0) continue; // bare `*.`
    if (isIP(base) !== 0) continue; // reject IPv4/IPv6 literals (incl. `*.1.2.3.4`)
    if (!HOSTNAME_RE.test(base)) continue; // reject URLs, schemes, host:port, paths, `*.*`
    if (targetsInternalSurface(base, isWildcard)) continue; // never allow the internal surface
    if (seen.has(entry)) continue;
    seen.add(entry);
    hosts.push(entry);
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
  // Open mode: allow all public internet with a single global allow-all. The
  // explicit internal denies are more specific than that global wildcard, so per
  // the documented precedence they win and the internal surface stays blocked. We
  // do NOT also emit `{ include: 'defaults' }` here: it only pre-allows common
  // dev domains, all of which the allow-all already covers, so it would be pure
  // redundancy.
  if (egressMode === 'open') {
    return {
      rules: [...buildInternalSurfaceDenyRules(), { ...ALLOW_ALL }],
    };
  }

  const hosts = sanitizeEgressAllowlist(egressAllowlist);
  if (hosts.length === 0) {
    // Default-deny: no outbound at all. Pure deny-all.
    return { rules: [{ ...DENY_ALL }] };
  }
  return {
    rules: [
      // Internal surface denied via EXPLICIT deny rules — defense in depth on top
      // of allowlist sanitization and the platform's own IP/private-range blocks.
      // Not `{ include: 'defaults' }`: that preset only pre-allows common dev
      // domains, it denies nothing. Allowlist mode is therefore a PURE explicit
      // allowlist — dev registries (GitHub/npm/PyPI/…) are NOT auto-allowed here;
      // a caller that wants them must list them (or use `egressMode: 'open'`).
      ...buildInternalSurfaceDenyRules(),
      ...hosts.map((domain): PolicyRule => ({ domain, action: 'allow' })),
      { ...DENY_ALL },
    ],
  };
}

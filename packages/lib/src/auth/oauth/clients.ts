/**
 * OAuth client registry and redirect-URI rules (ADR 0002 Decision 3, as
 * amended by ADR 0004).
 *
 * The static registry below still holds the first-party clients — the CLI
 * (`client_id: "pagespace-cli"`) is defined in code, not in a table, so a
 * SQL write can never mint a first-party client. Phase 1 adds a DB-backed
 * lookup for third-party clients BEHIND this one (static first, then
 * `oauth_clients` where `disabledAt IS NULL`); an unknown `client_id` stays
 * `invalid_client`.
 *
 * The redirect rules here are the whole of that decision and are used at BOTH
 * registration time (`./client-registration`) and authorize time
 * (`./authorize-request`). Two implementations of "is this redirect valid" is
 * how an app registers a URI the authorize endpoint will not honour — or, in
 * the direction that actually hurts, one it will.
 *
 * @module @pagespace/lib/auth/oauth/clients
 */

export interface RegisteredClient {
  clientId: string;
  name: string;
  type: 'public';
  /** Exact-match redirect URIs; loopback entries wildcard only the port, and only for first-party clients (see {@link validateRedirectUri}). */
  redirectUris: string[];
  allowedGrantTypes: readonly string[];
  /**
   * Built by PageSpace. Grants exactly two things no third party ever gets:
   * the loopback port wildcard below, and the `applyKeyGrant` mint path
   * (Phase 1). Never settable from the DB — first-party clients only exist in
   * the static registry in this file.
   */
  firstParty: boolean;
  /**
   * A human reviewed this client's identity. Drives the consent screen's
   * "Unverified app" badge — so it is `false` by default for everything that
   * arrives through registration, and is never client-supplied.
   */
  verified: boolean;
  /** Shown on the consent screen (https only, enforced at registration). */
  logoUrl?: string;
  /** Shown on the consent screen so the user can check who is asking (https only). */
  homepageUrl?: string;
  /** One-line description shown on the consent screen. */
  description?: string;
  /** The PageSpace user who registered the client, for the developer console and abuse handling. */
  ownerUserId?: string;
  /**
   * Per-client scope cap (ADR 0004 Decision 7): scope SHAPES this client may
   * ever ask for, so an app cannot request beyond what it declared. Absent
   * means "no cap declared" — first-party only; registration always writes a
   * list. Shape grammar and validation live in `./client-registration`.
   */
  allowedScopes?: string[];
}

export const PAGESPACE_CLI_CLIENT_ID = 'pagespace-cli';

const PAGESPACE_CLI_CLIENT: RegisteredClient = {
  clientId: PAGESPACE_CLI_CLIENT_ID,
  name: 'PageSpace CLI',
  type: 'public',
  redirectUris: ['http://127.0.0.1/callback', 'http://[::1]/callback'],
  allowedGrantTypes: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
  firstParty: true,
  verified: true,
};

const STATIC_CLIENT_REGISTRY = new Map<string, RegisteredClient>([[PAGESPACE_CLI_CLIENT.clientId, PAGESPACE_CLI_CLIENT]]);

/** Static registry lookup. Unknown `client_id` → null (caller fails closed with `invalid_client`). */
export function getRegisteredClient(clientId: string): RegisteredClient | null {
  if (!clientId) return null;
  return STATIC_CLIENT_REGISTRY.get(clientId) ?? null;
}

/** The two loopback literals RFC 8252 §7.3 allows a wildcard port on. `localhost` is deliberately excluded (§8.3). */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]']);

/**
 * Schemes that must never be treated as a private-use redirect, no matter what
 * is registered. `http:`/`https:` have their own rules below; the rest fall
 * into three groups, each for its own reason:
 *
 *  - **script- and content-bearing** (`javascript:`, `vbscript:`, `data:`,
 *    `blob:`, `about:`, `file:`) — "redirect with the code in the URL" means
 *    something very different from opening an app.
 *  - **URL-wrapping** (`filesystem:`, `view-source:`, `jar:`) — these carry a
 *    second URL inside them, so accepting one hands the authorization code to
 *    whatever that inner URL addresses.
 *  - **platform-handled** (`chrome:`, `edge:`, `devtools:`, `resource:`, the
 *    four browser-extension schemes, `content:`, `intent:`, `android-app:`,
 *    `mailto:`, `tel:`, `sms:`) — the OS or browser routes these, so they
 *    belong to no registered app.
 *  - **network/transport** (`ftp:`, `ftps:`, `telnet:`, `ssh:`, `gopher:`,
 *    `ldap:`, `ldaps:`) — these address a server, not a program on the user's
 *    device, so a code delivered to one has left the device entirely.
 *
 * The list is best-effort by construction and makes no claim to be exhaustive:
 * this is a DENY-list, and `classifyRedirect` says so — a scheme nobody thought
 * of is treated as private-use and is registrable. See that function's note
 * for why, and ADR 0004 Decision 3 for the scheme-squatting exposure that
 * follows from it.
 */
const NEVER_PRIVATE_USE_SCHEMES = new Set([
  // Unreachable through `classifyRedirect`, which answers for both before
  // consulting this set. Kept so a direct caller does not have to know that
  // ordering to get the right answer about these two. Note the set is a
  // DENY-list and nothing more: membership proves a scheme is not private-use,
  // absence proves nothing at all (see `classifyRedirect` below).
  'http:',
  'https:',
  'ws:',
  'wss:',
  'file:',
  'data:',
  'blob:',
  'about:',
  'javascript:',
  'vbscript:',
  'filesystem:',
  'view-source:',
  'jar:',
  'chrome:',
  'chrome-extension:',
  'moz-extension:',
  'safari-extension:',
  'safari-web-extension:',
  'ms-browser-extension:',
  'edge:',
  'devtools:',
  'resource:',
  'content:',
  'intent:',
  'android-app:',
  'mailto:',
  'tel:',
  'sms:',
  // Network/transport schemes. Not app schemes under any reading, and each
  // would hand the authorization code to a server rather than to a program on
  // the user's device.
  'ftp:',
  'ftps:',
  'telnet:',
  'ssh:',
  'gopher:',
  'ldap:',
  'ldaps:',
]);

type RedirectKind = 'https' | 'loopback' | 'private_use' | 'reject';

/**
 * The hostname with EVERY trailing dot removed.
 * `new URL('https://localhost./cb').hostname` is `'localhost.'`, which names the
 * same host as `localhost` but is a different string — so an equality check
 * against `'localhost'` misses it and the refusal below is walked straight
 * past. The parser preserves repeats verbatim (`'localhost..'`,
 * `'localhost...'`), so stripping exactly one is the same bug one keystroke
 * later; this strips the lot rather than betting on what a given resolver does
 * with an empty label.
 *
 * Normalizing for CLASSIFICATION only — matching still compares the unmodified
 * `href`, so `https://app.example.com./cb` stays distinct from a registered
 * `https://app.example.com/cb` and no dotted spelling gains a match it would
 * not otherwise have.
 *
 * Written as a loop rather than `/\.+$/` because a trailing-repetition regex on
 * attacker-controlled input is the polynomial-backtracking shape static
 * analysis flags (CodeQL js/polynomial-redos); this is linear by construction,
 * matching `trimTrailingSlashes` in `./metadata` for the same reason.
 */
function canonicalHostname(url: URL): string {
  const { hostname } = url;
  let end = hostname.length;
  while (end > 0 && hostname[end - 1] === '.') {
    end -= 1;
  }
  return hostname.slice(0, end);
}

/**
 * Which rule this URI plays by. Total — every input gets one of the four
 * answers.
 *
 * `https:` and `http:` are allow-listed: each has one explicit accepting
 * condition and everything else about them is `reject`. **Private-use schemes
 * are DENY-listed**: a scheme that is neither http(s) nor on
 * `NEVER_PRIVATE_USE_SCHEMES` classifies as `private_use`, so an unfamiliar
 * scheme is registrable rather than refused.
 *
 * That asymmetry is deliberate and it is the one place this module does not
 * fail closed. RFC 8252 §7.1 says a native app's redirect scheme is one the
 * app itself chose, so the set is open by construction — an allow-list would
 * have to be a list of every app that will ever exist. The exposure it leaves
 * is scheme squatting: nothing stops a registration claiming `slack://oauth`,
 * and on a shared device the OS hands the code to whichever app claimed the
 * scheme. Exact-match registration, per-client scope caps, and the
 * "Unverified app" badge are what stand in front of that today; ADR 0004
 * Decision 3 records it as accepted rather than solved.
 */
function classifyRedirect(url: URL): RedirectKind {
  if (url.protocol === 'https:') {
    // RFC 8252 §8.3: `localhost` can be remapped; only the numeric literals
    // are trustworthy, and those live on the loopback branch.
    //
    // `https://127.0.0.1/callback` is deliberately ordinary https, NOT
    // loopback: `loopback` here means CLEARTEXT loopback, and the first-party
    // gate below exists to protect the PORT WILDCARD, which exact-match https
    // never grants. A third party may register an https numeric-IP URI and
    // gets exact matching only — pinned by test and recorded in ADR 0004
    // Decision 3.
    return canonicalHostname(url) === 'localhost' ? 'reject' : 'https';
  }
  if (url.protocol === 'http:') {
    // `http://localhost./cb` and `http://localhost/cb` both fall here and are
    // both refused: neither is one of the two numeric literals.
    return LOOPBACK_HOSTNAMES.has(canonicalHostname(url)) ? 'loopback' : 'reject';
  }
  if (NEVER_PRIVATE_USE_SCHEMES.has(url.protocol)) return 'reject';
  // Anything left is taken as a private-use scheme (see the deny-list note
  // above). No further shape check: the URL parser has already enforced RFC
  // 3986's scheme production (leading ALPHA, then ALPHA/DIGIT/`+`/`-`/`.`) — a
  // string that failed it never parsed, and a redundant re-check here would be
  // a branch no input can reach.
  return 'private_use';
}

/**
 * Redirect-URI validation (ADR 0004 Decision 3). The same function registration
 * and authorize both call.
 *
 * | Candidate | Accepted when |
 * |---|---|
 * | `https://host[:port]/path` | byte-exact match with a registered https URI after URL normalization — scheme, host, port and path all |
 * | `scheme://…` (private use) | byte-exact match with a registered private-use URI on that client |
 * | `http://127.0.0.1[:port]/path`, `http://[::1][:port]/path` | scheme, host and path match a registered loopback URI AND `client.firstParty` — the port is the only wildcard in the whole system |
 * | anything else | never |
 *
 * Rejected outright, before any registered URI is consulted: userinfo, query,
 * fragment, `*`, `localhost` under `http:`/`https:` (including the
 * trailing-dot spelling — a private-use scheme is routed by scheme rather than
 * by host, so its host component is not load-bearing and is not checked),
 * non-loopback `http://`, and every script- or content-bearing scheme.
 */
export function validateRedirectUri(
  client: Pick<RegisteredClient, 'redirectUris' | 'firstParty'>,
  redirectUri: string,
): boolean {
  if (typeof redirectUri !== 'string' || redirectUri.trim().length === 0) return false;
  // No wildcard is ever honoured. Checked on the raw candidate rather than
  // relying on the URL parser refusing `*` in a host, so a `*` anywhere is a
  // refusal rather than a parser implementation detail. This one check is
  // enough for both ends: matching is exact, so a registration containing `*`
  // could only ever be satisfied by a candidate containing `*` — which dies
  // here. A registered wildcard therefore grants exactly nothing.
  if (redirectUri.includes('*')) return false;

  let candidate: URL;
  try {
    candidate = new URL(redirectUri);
  } catch {
    return false;
  }

  if (candidate.username || candidate.password || candidate.search || candidate.hash) return false;

  const candidateKind = classifyRedirect(candidate);
  if (candidateKind === 'reject') return false;
  // The loopback port wildcard is the CLI's alone. A third party registering
  // `http://127.0.0.1/callback` gets nothing — not the wildcard, and not the
  // exact URI either: cleartext loopback is a native-app affordance, and an
  // app the user reaches over the web has no business with it.
  if (candidateKind === 'loopback' && !client.firstParty) return false;

  for (const registered of client.redirectUris) {
    let pattern: URL;
    try {
      pattern = new URL(registered);
    } catch {
      continue;
    }

    if (pattern.username || pattern.password || pattern.search || pattern.hash) continue;
    // A candidate is only ever matched against registrations playing by the
    // same rule, so a registered private-use URI can never satisfy an https
    // candidate (or the reverse) through some parser coincidence.
    if (classifyRedirect(pattern) !== candidateKind) continue;

    if (candidateKind === 'loopback') {
      // The scheme is already settled by the kind check above (only `http:`
      // on a loopback literal classifies as `loopback`), so host and path are
      // what remain — and the port, alone in the whole system, is free.
      if (candidate.hostname === pattern.hostname && candidate.pathname === pattern.pathname) {
        return true;
      }
      continue;
    }

    if (candidate.href === pattern.href) return true;
  }

  return false;
}

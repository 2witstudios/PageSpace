/**
 * Preview proxy POLICY — pure: what may cross the proxy, in which direction,
 * with what bounds. Shared by the HTTP half (web tier) and the WebSocket half
 * (realtime tier) so a header rule cannot be enforced on one and forgotten on
 * the other.
 *
 * THE INBOUND MODEL (the companion of `containment.ts`'s outbound model)
 * ---------------------------------------------------------------------
 * A sandbox Sprite runs OPEN EGRESS (`network-options.ts`) and, through this
 * proxy, is now INBOUND-REACHABLE. An inbound-reachable open-egress machine
 * is the shape of an open relay, so the proxy is built to make that shape
 * impossible to reach from a client:
 *
 *  - **The upstream is never derivable from client input.** A request
 *    arrives on a holder's own preview origin (`<kind>-<holderId>.preview.<apex>`,
 *    see `preview-grant.ts`); the proxy resolves the holder (a session or an
 *    env) from the AUTHORIZED row that host names, attaches to the sprite
 *    that row points at, and reads the sprite's URL from the control plane.
 *    The client supplies a host label and a path; it never supplies, sees,
 *    or influences an upstream host. {@link assertTrustedPreviewUpstream} is
 *    the belt to that suspender: even a poisoned control-plane answer cannot
 *    make the proxy forward to a host outside the sprite platform.
 *  - **One port.** The sprite URL proxies to port 8080 inside the VM, always
 *    (spike §3, §8); the relay on 8080 forwards to the ONE detected port the
 *    row names. Nothing a client sends selects a port.
 *  - **The org token never leaves the server.** It is attached to the
 *    upstream request here; the client's own `Cookie` (the preview cookie,
 *    or anything else) and `Authorization` never reach the sprite.
 *  - **The sandbox's code never runs as PageSpace.** The preview origin is a
 *    dedicated apex sharing no registrable domain with the app, so a dev
 *    server's JS holds no PageSpace cookie, cannot set one
 *    (`sanitizeUpstreamSetCookie` strips `Domain`), and reaches PageSpace
 *    APIs only cross-origin, without credentials. The preview cookie
 *    AUTHENTICATES; the drive gate is re-run on EVERY request.
 *  - **Bounded.** Request bodies and response bodies are capped in bytes,
 *    the upstream is given a bounded time to answer (long enough to absorb a
 *    wake), and a stream that goes idle is cut. Nothing is buffered whole.
 *  - **Attributable, without bodies.** Every forwarded or refused request is
 *    logged with WHO viewed, WHICH holder, the method, a bounded path, the
 *    outcome and whether it was a wake — and never a request or response
 *    body, never the sprite name, never the token.
 *
 * What the proxy does NOT do: it does not make the sprite public (the sprite
 * URL stays `auth: 'sprite'`, org-token-only, so nobody can open it
 * directly), and it does not proxy to any host but the holder's own sprite.
 * Public exposure is a separate task with its own containment ruling.
 */

export interface PreviewProxyLimits {
  maxRequestBodyBytes: number;
  maxResponseBodyBytes: number;
  upstreamHeadersTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

/** Byte and time bounds on one proxied request. Named so the log can say which one fired. */
export const PREVIEW_PROXY_LIMITS: Readonly<PreviewProxyLimits> = Object.freeze({
  /** A dev server takes form posts and uploads, not bulk data. */
  maxRequestBodyBytes: 32 * 1024 * 1024,
  /** Source maps and unbundled dev assets are big; whole-app bundles are not served here. */
  maxResponseBodyBytes: 256 * 1024 * 1024,
  /**
   * How long the upstream may take to answer with HEADERS. Long enough to
   * absorb a hibernation wake (the request itself is the wake — spike §6)
   * plus a cold dev-server compile, short enough that a hung relay is an
   * answer rather than a hang.
   */
  upstreamHeadersTimeoutMs: 60_000,
  /** A response stream (or WebSocket) that carries nothing for this long is cut. */
  streamIdleTimeoutMs: 120_000,
});

/** The host suffix every sprite URL carries (spike §2: `https://<name>-<org>.sprites.app`). */
export const SPRITE_URL_HOST_SUFFIX = '.sprites.app';

/**
 * Pure: throw unless `url` is an https URL on the sprite platform. The
 * upstream comes from the authorized row → control plane, never from a
 * client, so this can only ever fire on a bug or a poisoned control-plane
 * answer — and on either, refusing is the whole point.
 */
export function assertTrustedPreviewUpstream(url: URL): void {
  if (url.protocol !== 'https:' || !url.hostname.endsWith(SPRITE_URL_HOST_SUFFIX) || url.hostname === SPRITE_URL_HOST_SUFFIX.slice(1)) {
    throw new Error('preview upstream is not a sprite URL — refusing to forward');
  }
}

/**
 * Pure: the upstream URL for one proxied request. `spriteUrl` is the sprite's
 * own URL from the control plane; `pathAndQuery` is the request's path AND
 * query BELOW the proxy mount (the raw, still-encoded suffix — re-encoding
 * decoded segments would corrupt paths dev servers care about, like
 * `/@fs/…` and `?import`). Dot segments are resolved by URL parsing against a
 * fixed host, so they cannot escape it.
 */
export function buildPreviewUpstreamUrl(spriteUrl: string, pathAndQuery: string): URL {
  const base = new URL(spriteUrl);
  assertTrustedPreviewUpstream(base);
  // The client-supplied part is appended AFTER the sprite origin and a literal
  // `/`, never resolved as a URL of its own: `new URL('//evil', origin)` would
  // re-home the request, and a control character or whitespace has no place in
  // a request target. Dot segments are then resolved against the fixed host.
  const suffix = pathAndQuery.replace(/^\/+/, '');
  if (/[\s\u0000-\u001f\u007f]/.test(suffix)) throw new Error('preview path contains a control character — refusing to forward');
  const upstream = new URL(`${base.origin}/${suffix}`);
  if (upstream.origin !== base.origin) throw new Error('preview path escaped the sprite origin — refusing to forward');
  return upstream;
}

/**
 * Pure: split a request pathname below a mount prefix. `mountPrefix` is the
 * proxy route's own path (`/api/drives/<id>/envs/<id>/preview`); the result
 * is the suffix starting at `/`, or null when the pathname is not under the
 * mount (the caller 404s). Query strings are the caller's to append.
 */
export function extractPreviewPath(pathname: string, mountPrefix: string): string | null {
  if (pathname === mountPrefix) return '/';
  if (!pathname.startsWith(`${mountPrefix}/`)) return null;
  return pathname.slice(mountPrefix.length);
}

// -----------------------------------------------------------------------------
// Header policy
// -----------------------------------------------------------------------------

/** RFC 7230 hop-by-hop headers plus the ones a proxy must own. Never copied in either direction. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'proxy-connection', 'host',
]);

/**
 * Request headers that may reach the sprite. An ALLOWLIST, not a denylist:
 * the client's `Cookie` (PageSpace's session) and `Authorization` must never
 * reach untrusted code, `Origin`/`Referer` would leak PageSpace URLs, and
 * `Accept-Encoding` is deliberately absent — the web tier's `fetch`
 * transparently decompresses, so the forwarder PINS it to `identity` rather
 * than relaying the client's, and the response policy drops
 * `Content-Encoding`, so the relayed body and headers always describe the
 * same bytes.
 */
const FORWARDABLE_REQUEST_HEADERS = new Set([
  'accept', 'accept-language', 'content-type', 'content-length', 'cache-control', 'pragma',
  'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range', 'range', 'user-agent',
]);

/** WebSocket handshake headers, forwarded ONLY by the upgrade tunnel (the HTTP half never sees an upgrade). */
const FORWARDABLE_UPGRADE_HEADERS = new Set([
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions',
]);

/**
 * Response headers dropped before a sprite's answer reaches the browser.
 *  - `set-cookie`: not relayed by the generic path — the caller relays each
 *    value through `sanitizeUpstreamSetCookie` (`preview-grant.ts`), which
 *    strips `Domain` (host-only, never cross-holder) and drops anything in
 *    PageSpace's reserved cookie namespace.
 *  - `x-frame-options`, `content-security-policy-report-only`: framing is
 *    PageSpace's call — the preview is framed by the dashboard and by nothing
 *    else (see {@link buildPreviewResponseHeaders}); an upstream `DENY` would
 *    blank the frame and a report-only policy would phone home from the
 *    preview origin.
 *  - `strict-transport-security`: the preview apex's HSTS is ops' call, not
 *    untrusted code's.
 *  - `content-encoding`/`content-length`: the web tier's `fetch` decodes the
 *    body, so both would describe bytes the client does not receive.
 */
const DROPPED_RESPONSE_HEADERS = new Set([
  'set-cookie', 'set-cookie2', 'x-frame-options', 'content-security-policy-report-only',
  'strict-transport-security', 'content-encoding', 'content-length',
  // The sprite platform's own proxy adds these; they describe its topology, not ours.
  'server', 'via', 'alt-svc',
]);

/**
 * Pure: the headers PageSpace sets on every proxied response, after
 * upstream's. The upstream's own `Content-Security-Policy` is KEPT and this
 * one is appended: browsers enforce the intersection of every policy
 * delivered, so the dev server keeps whatever it asked for and PageSpace adds
 * the framing rule — the preview may be framed by the APP origin and nothing
 * else (`'none'` when the app origin is unknown: fail closed, not open).
 * `X-Frame-Options` cannot express a cross-origin ancestor, so it is not
 * emitted; `frame-ancestors` is the control.
 */
export function buildPreviewResponseHeaders(appOrigin: string | null): ReadonlyArray<readonly [string, string]> {
  return [
    ['content-security-policy', `frame-ancestors ${appOrigin ?? "'none'"}`],
    ['cache-control', 'no-store'],
    ['referrer-policy', 'no-referrer'],
    ['x-content-type-options', 'nosniff'],
  ];
}

/**
 * Pure: a dev server's `Location`, made safe to relay. A redirect back to the
 * sprite's own origin becomes origin-relative (the browser stays on the
 * preview host and the sprite URL never reaches the client); any other
 * absolute target is relayed as-is — it is the dev server's choice to send
 * the user elsewhere, and it leaks nothing of ours.
 */
export function rewriteUpstreamLocation(location: string, spriteOrigin: string): string {
  try {
    const target = new URL(location, spriteOrigin);
    if (target.origin === spriteOrigin) return `${target.pathname}${target.search}${target.hash}`;
    return location;
  } catch {
    return location;
  }
}

/** A minimal header map: lower-cased names, joined values. Shared by both tiers (Fetch `Headers` and Node `IncomingHttpHeaders` both flatten to this). */
export type HeaderMap = Record<string, string>;

/** Pure: the request headers that may cross to the sprite. `upgrade` adds the WebSocket handshake set. */
export function selectForwardableRequestHeaders(headers: HeaderMap, { upgrade = false } = {}): HeaderMap {
  const out: HeaderMap = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name)) continue;
    if (FORWARDABLE_REQUEST_HEADERS.has(name) || (upgrade && FORWARDABLE_UPGRADE_HEADERS.has(name))) out[name] = value;
  }
  return out;
}

/** Pure: the response headers that may cross back, minus everything {@link DROPPED_RESPONSE_HEADERS} names and every hop-by-hop header. */
export function selectForwardableResponseHeaders(headers: HeaderMap): HeaderMap {
  const out: HeaderMap = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || DROPPED_RESPONSE_HEADERS.has(name)) continue;
    out[name] = value;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Attributable access log (never a body)
// -----------------------------------------------------------------------------

export interface PreviewAccessLogInput {
  userId: string;
  holder: { kind: 'workspace' | 'env'; id: string };
  method: string;
  /** The request path below the mount; bounded in the record. */
  path: string;
  outcome: 'forwarded' | 'refused' | 'upstream-error' | 'limit-exceeded';
  /** The refusal reason or the limit that fired, when `outcome` is not `forwarded`. */
  reason?: string;
  status?: number;
  wake?: boolean;
  bytesOut?: number;
  durationMs?: number;
  transport: 'http' | 'websocket';
}

const LOGGED_PATH_MAX = 200;

/**
 * Pure: one attributable log record — WHO viewed WHICH holder, how, with what
 * outcome. Never a body, never the sprite name/URL/token (none are inputs),
 * and the path is bounded so a hostile client cannot fill the log.
 */
export function buildPreviewAccessLog(input: PreviewAccessLogInput): Record<string, string | number | boolean> {
  const path = input.path.length > LOGGED_PATH_MAX ? `${input.path.slice(0, LOGGED_PATH_MAX)}…` : input.path;
  return {
    userId: input.userId,
    holderKind: input.holder.kind,
    holderId: input.holder.id,
    transport: input.transport,
    method: input.method,
    path,
    outcome: input.outcome,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.wake !== undefined ? { wake: input.wake } : {}),
    ...(input.bytesOut !== undefined ? { bytesOut: input.bytesOut } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
}

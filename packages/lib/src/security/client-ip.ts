/**
 * Client IP extraction — trusted-proxy aware (GitHub issue #1908).
 *
 * `X-Forwarded-For`/`X-Real-IP` are client-settable headers: any caller that
 * can reach an app directly (bypassing the edge proxy) can set them to
 * whatever it wants, which defeats IP-keyed rate limiting. On Fly.io, every
 * request that terminates at Fly's own edge carries `Fly-Client-IP` — Fly's
 * proxy sets this itself from the actual TCP peer it accepted the connection
 * from, so it cannot be spoofed by a client-supplied header. Prefer it.
 *
 * Do not reorder this — reading `x-forwarded-for` first reintroduces the
 * spoofing hole this file exists to close.
 *
 * OFF FLY, `X-Forwarded-For`/`X-Real-IP` ARE DEFAULT-DENY (Agent Signup Phase
 * 2b). Off Fly there is no edge vouching for anything, and trusting the
 * caller's first `x-forwarded-for` let a rotating header mint a fresh
 * rate-limit bucket per request — defeating every IP-keyed limit, the agent
 * signup ceiling included. They are honoured only when the operator declares
 * the proxy topology with `TRUSTED_PROXY_HOPS=<n>`: the number of reverse
 * proxies in front of the app that each append the peer they saw to
 * `x-forwarded-for` (1 for the tenant stack's Traefik). The client is then the
 * n-th entry from the RIGHT — the address the outermost trusted proxy saw —
 * and anything a caller prepended is ignored. Unset, `0` or not an unsigned
 * integer: the headers are ignored and the client resolves to `unknown`, one
 * shared bucket (fail closed, never one bucket per forged header). Honour
 * `x-real-ip` only under the same declaration, when `x-forwarded-for` is absent.
 * This declares trust, it cannot create it: the app must not be reachable
 * except through those proxies.
 *
 * GATED ON ACTUALLY RUNNING ON FLY: `Fly-Client-IP` is trustworthy ONLY
 * because Fly's own edge sets it, unspoofably, from the real TCP peer. That
 * guarantee holds only when a request genuinely traversed Fly's infrastructure
 * — this repo also ships a `tenant` deployment mode (`infrastructure/
 * docker-compose.tenant.yml`, Traefik) that runs on non-Fly hosts, where
 * `Fly-Client-IP` is just another ordinary, unmanaged, client-settable header.
 * Trusting it unconditionally there would let any caller forge it directly to
 * bypass IP-keyed rate limits and poison audit/device-fingerprint data — the
 * exact class of attack #1908 exists to close, just via a different header
 * name. `FLY_APP_NAME` is a runtime environment variable Fly injects into
 * every Fly Machine automatically (never something a caller can set via an
 * HTTP header, and never present on a non-Fly host unless an operator
 * deliberately fakes it — not a realistic threat model change from today).
 * Use its presence to gate trust, not `DEPLOYMENT_MODE`: `cloud` and `tenant`
 * are a product/billing axis, not an infrastructure-topology one, and a
 * `tenant` deployment could in principle also run on Fly — what actually
 * determines whether `Fly-Client-IP` is trustworthy is the real, current host,
 * not which mode the app believes it's in.
 *
 * EXCEPT: even when confirmed to be on Fly, `Fly-Client-IP` is set fresh per
 * Fly Proxy hop, not chained like `X-Forwarded-For`. `pagespace.ai` traffic
 * terminates at the `pagespace-proxy` (Caddy) app, which then relays to this
 * app over the internal `flycast` network — a SECOND Fly Proxy hop, whose own
 * edge overwrites `Fly-Client-IP` with Caddy's own machine address, not the
 * original visitor's. Fly's private 6PN network exclusively uses IPv6 ULA
 * addresses in the `fdaa::/16` block, which a real internet client can never
 * present (that's what the TCP peer of a direct, public connection to Fly's
 * true edge would have to spoof, and it can't). So an `fdaa:`-prefixed
 * `Fly-Client-IP` unambiguously means this request arrived over that internal
 * hop, and Caddy has already relayed the real visitor IP as `X-Forwarded-For`
 * instead (an unconditional `header_up` replace, not append — see
 * PageSpace-Deploy's `fly/Caddyfile.fly` — so it isn't attacker-appendable
 * either). Trust that instead in this one case. A direct hit that bypasses
 * Caddy entirely (the attack #1908 exists to close) always carries a real,
 * non-6PN `Fly-Client-IP` here, since that IS the true edge for that
 * connection.
 *
 * Zero Node-only imports: this module must stay importable from the Next.js
 * Edge runtime (apps/web/src/middleware.ts).
 */

interface HeaderSource {
  get(name: string): string | null;
}

interface HasHeaders {
  headers: HeaderSource;
}

/** What the deployment says about the hops in front of it. */
export interface ClientIpTrust {
  /** Running on a Fly Machine (`FLY_APP_NAME` set) — `Fly-Client-IP` is set by Fly's edge. */
  onFly: boolean;
  /** Off Fly: reverse proxies in front of the app that append to `x-forwarded-for`; 0 = trust none. */
  trustedProxyHops: number;
}

/** Fly's private 6PN network — inter-app traffic only, never a real visitor's address. */
function isFly6pnAddress(ip: string): boolean {
  return ip.toLowerCase().startsWith('fdaa:');
}

/**
 * `FLY_APP_NAME` is auto-injected by Fly's runtime into every Fly Machine —
 * never client-settable, never present on a non-Fly host by default.
 * `TRUSTED_PROXY_HOPS` must be an unsigned integer literal; anything else is 0.
 * Read per call (not cached at module load) so tests can toggle it.
 */
export function readClientIpTrust(env: Record<string, string | undefined> = process.env): ClientIpTrust {
  const rawHops = env.TRUSTED_PROXY_HOPS?.trim() ?? '';
  return {
    onFly: Boolean(env.FLY_APP_NAME),
    trustedProxyHops: /^\d{1,2}$/.test(rawHops) ? Number.parseInt(rawHops, 10) : 0,
  };
}

function forwardedFor(headers: HeaderSource): string[] {
  return (headers.get('x-forwarded-for') ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

export function resolveClientIP(headers: HeaderSource, trust: ClientIpTrust): string {
  if (trust.onFly) {
    const flyClientIP = headers.get('fly-client-ip')?.trim();
    if (flyClientIP && !isFly6pnAddress(flyClientIP)) return flyClientIP;
    return forwardedFor(headers)[0] || headers.get('x-real-ip')?.trim() || flyClientIP || 'unknown';
  }

  if (trust.trustedProxyHops < 1) return 'unknown';
  const chain = forwardedFor(headers);
  if (chain.length > 0) return chain[Math.max(0, chain.length - trust.trustedProxyHops)] ?? 'unknown';
  return headers.get('x-real-ip')?.trim() || 'unknown';
}

let warnedIgnoredForwardedFor = false;

/**
 * A misconfigured self-host (a proxy in front, TRUSTED_PROXY_HOPS unset)
 * collapses every visitor into the one `unknown` bucket. Say so once, in the
 * log an operator reads — console, because this module must stay importable
 * from the Edge runtime.
 *
 * Next.js itself fills a missing `x-forwarded-for` with the socket peer, so a
 * single entry proves nothing. Only a proxy's fingerprints count: `x-real-ip`,
 * or a chain of two or more entries.
 */
function warnIfForwardedForIgnored(headers: HeaderSource, trust: ClientIpTrust): void {
  if (warnedIgnoredForwardedFor || trust.onFly || trust.trustedProxyHops > 0) return;
  if (!headers.get('x-real-ip') && forwardedFor(headers).length < 2) return;
  warnedIgnoredForwardedFor = true;
  console.warn('[client-ip] A reverse proxy appears to be in front of this app, but TRUSTED_PROXY_HOPS is unset, so X-Forwarded-For is ignored and every client shares one rate-limit bucket. Set TRUSTED_PROXY_HOPS to the number of proxies that append to X-Forwarded-For (see infrastructure/UPGRADE.md).');
}

export function getClientIP(request: HasHeaders): string {
  const trust = readClientIpTrust();
  warnIfForwardedForIgnored(request.headers, trust);
  return resolveClientIP(request.headers, trust);
}

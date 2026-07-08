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
 * `X-Forwarded-For`/`X-Real-IP` remain the fallback for local dev/CI, where
 * there's no Fly edge and no real exposure. Do not reorder this — reading
 * `x-forwarded-for` first reintroduces the spoofing hole this file exists to
 * close.
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

interface HasHeaders {
  headers: { get(name: string): string | null };
}

/** Fly's private 6PN network — inter-app traffic only, never a real visitor's address. */
function isFly6pnAddress(ip: string): boolean {
  return ip.toLowerCase().startsWith('fdaa:');
}

/**
 * `FLY_APP_NAME` is auto-injected by Fly's runtime into every Fly Machine —
 * never client-settable, never present on a non-Fly host by default. Read
 * per-call (not cached at module load) so tests can toggle it deterministically.
 */
function isRunningOnFly(): boolean {
  return Boolean(process.env.FLY_APP_NAME);
}

export function getClientIP(request: HasHeaders): string {
  const flyClientIP = isRunningOnFly() ? request.headers.get('fly-client-ip')?.trim() : undefined;
  if (flyClientIP && !isFly6pnAddress(flyClientIP)) return flyClientIP;

  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    flyClientIP ||
    'unknown'
  );
}

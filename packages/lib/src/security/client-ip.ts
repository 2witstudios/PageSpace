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
 * EXCEPT: `Fly-Client-IP` is set fresh per Fly Proxy hop, not chained like
 * `X-Forwarded-For`. `pagespace.ai` traffic terminates at the `pagespace-proxy`
 * (Caddy) app, which then relays to this app over the internal `flycast`
 * network — a SECOND Fly Proxy hop, whose own edge overwrites `Fly-Client-IP`
 * with Caddy's own machine address, not the original visitor's. Fly's private
 * 6PN network exclusively uses IPv6 ULA addresses in the `fdaa::/16` block,
 * which a real internet client can never present (that's what the TCP peer
 * of a direct, public connection to Fly's true edge would have to spoof, and
 * it can't — Fly's edge sets `Fly-Client-IP` from what it actually observed,
 * not from anything the client sent). So an `fdaa:`-prefixed `Fly-Client-IP`
 * unambiguously means this request arrived over that internal hop, and
 * Caddy has already relayed the real visitor IP as `X-Forwarded-For` instead
 * (an unconditional `header_up` replace, not append — see
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

export function getClientIP(request: HasHeaders): string {
  const flyClientIP = request.headers.get('fly-client-ip')?.trim();
  if (flyClientIP && !isFly6pnAddress(flyClientIP)) return flyClientIP;

  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    flyClientIP ||
    'unknown'
  );
}

/**
 * Client IP extraction for the Edge-runtime middleware graph — a deliberate
 * duplicate of @pagespace/lib/security/client-ip's logic. Edge-runtime files
 * (src/middleware.ts, src/middleware/monitoring.ts) cannot import
 * @pagespace/lib at all (see eslint.config.mjs's edge-runtime import-graph
 * rule), so this stays a standalone leaf with zero imports rather than a
 * re-export. Keep this in sync with the packages/lib version by hand if the
 * trust logic ever changes.
 *
 * Prefers Fly's own `Fly-Client-IP` header — set by Fly's edge from the
 * actual TCP peer it accepted the connection from, so it cannot be spoofed
 * by a client-supplied header (GitHub issue #1908). Falls back to
 * `x-forwarded-for`/`x-real-ip` for local dev/CI, where there's no Fly edge.
 *
 * EXCEPT: `Fly-Client-IP` is set fresh per Fly Proxy hop, not chained.
 * `pagespace.ai` traffic reaches this app via `pagespace-proxy` (Caddy) over
 * the internal `flycast` network — a second hop whose own edge overwrites
 * `Fly-Client-IP` with Caddy's own machine address, not the visitor's. Fly's
 * private 6PN network exclusively uses IPv6 ULA addresses in `fdaa::/16`,
 * which a real internet client's direct connection can never present — so an
 * `fdaa:`-prefixed value unambiguously means this arrived over that internal
 * hop, and Caddy has already relayed the real visitor IP as
 * `X-Forwarded-For` instead (an unconditional replace, not an append — see
 * PageSpace-Deploy's `fly/Caddyfile.fly` — so it isn't attacker-appendable).
 * Trust that instead in this one case; see the `packages/lib` copy's doc for
 * the full reasoning.
 *
 * GATED ON ACTUALLY RUNNING ON FLY: this repo also ships a non-Fly `tenant`
 * deployment mode (Docker/Traefik), where `Fly-Client-IP` is just another
 * ordinary, client-settable header with no trust guarantee at all — trusting
 * it unconditionally there would let any caller forge it to bypass IP-keyed
 * rate limits. `FLY_APP_NAME` is a runtime env var Fly injects into every Fly
 * Machine automatically (never client-settable); use its presence to gate
 * trust, not `DEPLOYMENT_MODE` — see the `packages/lib` copy's doc for why.
 */
export function getClientIP(request: Request): string {
  const flyClientIP = process.env.FLY_APP_NAME ? request.headers.get('fly-client-ip')?.trim() : undefined;
  if (flyClientIP && !flyClientIP.toLowerCase().startsWith('fdaa:')) return flyClientIP;

  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    flyClientIP ||
    'unknown'
  );
}

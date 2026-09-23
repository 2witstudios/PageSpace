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
 * by a client-supplied header (GitHub issue #1908). Off Fly it is a LOGGING
 * address only (see `getClientIP` below): the gating copy in packages/lib is
 * default-deny, this one reports the observed address.
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
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A duplicate of packages/lib `isIpAddress`: only an IP literal is ever reported. */
function isIpAddress(value: string): boolean {
  if (IPV4.test(value)) return true;
  const address = value.split('%')[0] ?? '';
  if (!/^[0-9a-f:.]+$/i.test(address) || !address.includes(':')) return false;
  let groups = address;
  let tailGroups = 0;
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!IPV4.test(tail)) return false;
    groups = `${address.slice(0, lastColon + 1)}0`;
    tailGroups = 1;
  }
  const halves = groups.split('::');
  if (halves.length > 2) return false;
  const parts = halves.flatMap((half) => (half ? half.split(':') : []));
  if (!parts.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) return false;
  const total = parts.length + tailGroups;
  return halves.length === 2 ? total <= 7 : total === 8;
}

function ipOrUnknown(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && isIpAddress(trimmed) ? trimmed : 'unknown';
}

/**
 * The address the middleware graph LOGS (security events, monitoring ingest).
 * It never gates anything, so unlike the packages/lib copy it does not fail
 * closed: when no trusted proxy is declared it reports the observed address
 * (x-forwarded-for's first entry, else x-real-ip) rather than `unknown` — a
 * forged value there can only mislabel a log line, while `unknown` would strip
 * the address from every origin/authorization event. Under a declared
 * TRUSTED_PROXY_HOPS it reports the same entry the gating copy trusts. Every
 * reported value must parse as an IP literal.
 */
export function getClientIP(request: Request): string {
  const headers = request.headers;
  const forwardedFor = (headers.get('x-forwarded-for') ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);

  if (process.env.FLY_APP_NAME) {
    const flyClientIP = headers.get('fly-client-ip')?.trim();
    if (flyClientIP && !flyClientIP.toLowerCase().startsWith('fdaa:') && isIpAddress(flyClientIP)) return flyClientIP;
    return ipOrUnknown(forwardedFor[0] || headers.get('x-real-ip') || flyClientIP);
  }

  const rawHops = process.env.TRUSTED_PROXY_HOPS?.trim() ?? '';
  const hops = /^\d{1,2}$/.test(rawHops) ? Number.parseInt(rawHops, 10) : 0;
  if (hops >= 1 && forwardedFor.length >= hops) return ipOrUnknown(forwardedFor[forwardedFor.length - hops]);
  return ipOrUnknown(forwardedFor[0] || headers.get('x-real-ip'));
}

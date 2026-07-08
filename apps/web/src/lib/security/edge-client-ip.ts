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
 */
export function getClientIP(request: Request): string {
  const flyClientIP = request.headers.get('fly-client-ip');
  if (flyClientIP) return flyClientIP.trim();

  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    'unknown'
  );
}

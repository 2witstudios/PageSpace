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
 * Zero Node-only imports: this module must stay importable from the Next.js
 * Edge runtime (apps/web/src/middleware.ts).
 */

interface HasHeaders {
  headers: { get(name: string): string | null };
}

export function getClientIP(request: HasHeaders): string {
  const flyClientIP = request.headers.get('fly-client-ip');
  if (flyClientIP) return flyClientIP.trim();

  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    'unknown'
  );
}

/**
 * Deployment mode detection utilities (client-side).
 *
 * Uses NEXT_PUBLIC_DEPLOYMENT_MODE which is inlined at build time by Next.js.
 * For server-side code, import from '@pagespace/lib' instead.
 *
 * Build-time env var audit (Epic 2):
 * - NEXT_PUBLIC_APP_URL: Only used in server-side route handlers and packages/lib.
 *   No client-side .tsx components reference it directly.
 *   Server-side usage is acceptable since it reads at runtime, not inlined client-side.
 * - NEXT_PUBLIC_REALTIME_URL: Socket store falls back to same-origin when undefined,
 *   so this var is optional for builds routing /socket.io through Traefik.
 */

export function isOnPrem(): boolean {
  return process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === 'onprem';
}

export function isCloud(): boolean {
  return !isOnPrem();
}

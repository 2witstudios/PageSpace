/**
 * How the e2e proxy (support/e2e-proxy.ts) splits its one origin, as the production edge does:
 * `/socket.io` to realtime, imago's basePath `/imago` to apps/imago, everything else (sign-in
 * included) to web. Pure, so the split is unit-tested without opening a port.
 */

export interface ProxyTargets {
  web: URL;
  realtime: URL;
  /** apps/imago, or null when the run serves no imago (requests under /imago then reach web). */
  imago: URL | null;
}

/** apps/imago's basePath (apps/imago/next.config.ts). */
const IMAGO_BASE_PATH = '/imago';

const isRealtimePath = (url: string): boolean => url.startsWith('/socket.io');

/** `/imago` itself or anything below it; not `/imagonary`. */
const isImagoPath = (url: string): boolean => {
  if (!url.startsWith(IMAGO_BASE_PATH)) return false;
  const next = url.charAt(IMAGO_BASE_PATH.length);
  return next === '' || next === '/' || next === '?';
};

export const targetFor = (url: string | undefined, targets: ProxyTargets): URL => {
  const path = url ?? '/';
  if (isRealtimePath(path)) return targets.realtime;
  if (targets.imago !== null && isImagoPath(path)) return targets.imago;
  return targets.web;
};

export const proxyTargets = (env: Record<string, string | undefined>): ProxyTargets => ({
  web: new URL(env.E2E_WEB_TARGET ?? 'http://127.0.0.1:3100'),
  realtime: new URL(env.E2E_REALTIME_TARGET ?? 'http://127.0.0.1:3001'),
  imago: env.E2E_IMAGO_TARGET ? new URL(env.E2E_IMAGO_TARGET) : null,
});

// Where a signed-out imago request is sent, and how it gets back. Shared by the
// edge middleware and the server-only getViewer(), so it imports nothing:
// keep it free of Node-only and @pagespace/lib imports.
//
// Every redirect imago issues becomes reachable from classic's sign-in, which
// returns the user to `next`. So `next` is built only from the request's own
// pathname (never a query parameter), and anything that is not a plain path
// under /imago collapses to the bare /imago root instead of being forwarded.

/** Classic's session cookie (apps/web/src/lib/auth/cookie-config.ts). */
export const SESSION_COOKIE = 'session';

/** Classic's sign-in page, served by apps/web outside imago's basePath. */
export const SIGN_IN_PATH = '/auth/signin';

export const IMAGO_BASE_PATH = '/imago';

/**
 * Request header the middleware sets to the basePath-relative pathname, so a
 * server component can rebuild `next` (server components cannot see the URL).
 * Middleware always overwrites it; a request middleware skips may carry a
 * client-supplied value, which imagoReturnPath sanitises like any other.
 */
export const PATHNAME_HEADER = 'x-imago-pathname';

const FALLBACK_HOST = 'https://imago.invalid';

// Rejected raw or once-decoded: a second slash or a backslash could turn into
// an authority, a colon into a scheme, and control characters into header or
// log injection. None occur in an imago route.
const hasUnsafeCharacter = (path: string): boolean =>
  path.includes('//') ||
  path.includes('\\') ||
  path.includes(':') ||
  /[\u0000-\u001f\u007f]/.test(path);

/**
 * The imago path to return to after sign-in, from a basePath-relative pathname
 * (what `req.nextUrl.pathname` holds under basePath: '/imago').
 */
export function imagoReturnPath(pathname: string | null | undefined): string {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return IMAGO_BASE_PATH;

  const candidate = pathname === '/' ? IMAGO_BASE_PATH : `${IMAGO_BASE_PATH}${pathname}`;
  if (hasUnsafeCharacter(candidate)) return IMAGO_BASE_PATH;

  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return IMAGO_BASE_PATH;
  }
  if (hasUnsafeCharacter(decoded)) return IMAGO_BASE_PATH;

  // The URL parser resolves dot segments, including encoded ones (%2e%2e). A
  // path it rewrites was trying to climb out of /imago.
  const parsed = new URL(candidate, FALLBACK_HOST);
  if (parsed.origin !== FALLBACK_HOST || parsed.pathname !== candidate) return IMAGO_BASE_PATH;

  return candidate;
}

/**
 * Absolute sign-in URL on `origin` that returns to the given imago path.
 * Absolute on purpose: Next prefixes basePath onto a root-relative redirect()
 * target, which would turn /auth/signin into /imago/auth/signin.
 */
export function signInLocation({
  origin,
  pathname,
}: {
  origin: string;
  pathname: string | null | undefined;
}): string {
  const url = new URL(SIGN_IN_PATH, origin);
  url.searchParams.set('next', imagoReturnPath(pathname));
  return url.toString();
}

/** apps/web's own dev origin, used under next dev when NEXT_PUBLIC_WEB_APP_URL is unset. */
export const DEFAULT_DEV_WEB_APP_URL = 'http://localhost:3000';

/**
 * The origin that serves classic's sign-in page, given the origin imago was
 * served from. In production the edge serves /auth on imago's own origin, so
 * sign-in stays same-origin. `next dev` proxies only /api to apps/web, so the
 * page lives on apps/web's dev origin instead (localhost cookies ignore the
 * port, so the session it sets reaches imago too).
 *
 * Dot access on purpose: Next inlines NODE_ENV and NEXT_PUBLIC_* into the edge
 * and client bundles only when they are referenced literally.
 */
export function signInOrigin(origin: string): string {
  if (process.env.NODE_ENV !== 'development') return origin;
  return devWebAppOrigin();
}

/** apps/web's origin under next dev: NEXT_PUBLIC_WEB_APP_URL, or its default dev origin. */
const devWebAppOrigin = (): string =>
  httpOrigin('NEXT_PUBLIC_WEB_APP_URL', process.env.NEXT_PUBLIC_WEB_APP_URL || DEFAULT_DEV_WEB_APP_URL);

const httpOrigin = (name: string, value: string): string => {
  const url = parseURL(value);
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') {
    throw new Error(`${name} is not a valid http(s) URL: "${value}"`);
  }
  return url.origin;
};

/**
 * The origin server code builds its absolute redirects on (classic's sign-in
 * from getViewer(), classic's /dashboard from the index page), from
 * configuration only. The request's Host and forwarded headers are the
 * client's to write, so they never choose where imago sends anyone.
 * WEB_APP_URL is apps/web's public URL, which in production is also imago's
 * origin (both are served on one origin); next dev uses apps/web's dev
 * origin, as signInOrigin() does. A missing or invalid value is a deploy
 * error, so it throws rather than fall back to the request.
 */
export function webAppOrigin(): string {
  if (process.env.NODE_ENV === 'development') return devWebAppOrigin();
  const value = process.env.WEB_APP_URL;
  if (!value) throw new Error('WEB_APP_URL is not set: imago builds its sign-in and classic redirects from it');
  return httpOrigin('WEB_APP_URL', value);
}

const parseURL = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * A browser pathname (`window.location.pathname`, which includes the basePath)
 * made basePath-relative, as imagoReturnPath expects; null outside /imago.
 */
export function basePathRelative(pathname: string): string | null {
  if (pathname === IMAGO_BASE_PATH) return '/';
  if (!pathname.startsWith(`${IMAGO_BASE_PATH}/`)) return null;
  return pathname.slice(IMAGO_BASE_PATH.length);
}

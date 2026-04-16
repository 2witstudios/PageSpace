/**
 * Cookie Security Configuration (P3-T4)
 *
 * Centralized cookie configuration for session-based authentication.
 * Uses opaque session tokens instead of JWTs for instant revocation capability.
 *
 * SECURITY FEATURES:
 * - httpOnly: Prevents XSS attacks from accessing tokens via JavaScript
 * - secure: Ensures cookies are only sent over HTTPS in production
 * - sameSite: strict - Prevents CSRF attacks by not sending cookies with cross-site requests
 * - Opaque tokens: Server-validated, instantly revocable
 *
 * @module @pagespace/web/lib/auth/cookie-config
 */

import { serialize, parse } from 'cookie';

/**
 * Session duration: 7 days in seconds
 */
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

/**
 * Cookie configuration constants
 */
export const COOKIE_CONFIG = {
  session: {
    name: 'session',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  },
  loggedIn: {
    name: 'ps_logged_in',
    value: '1',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  },
} as const;

/**
 * Get common cookie options based on environment
 */
function getCommonOptions(httpOnly = true) {
  const isProduction = process.env.NODE_ENV === 'production';
  // Use 'lax' when COOKIE_DOMAIN is set (multi-tenant subdomain sharing).
  // Existing CSRF token validation covers POST protection independently of sameSite.
  const sameSite = (isProduction && process.env.COOKIE_DOMAIN) ? 'lax' as const : 'strict' as const;
  return {
    httpOnly,
    secure: isProduction,
    sameSite,
    ...(isProduction && process.env.COOKIE_DOMAIN && { domain: process.env.COOKIE_DOMAIN }),
  };
}

/**
 * Create a session cookie string
 *
 * @param token - The opaque session token (ps_sess_...)
 * @returns Serialized cookie string for Set-Cookie header
 */
export function createSessionCookie(token: string): string {
  return serialize(COOKIE_CONFIG.session.name, token, {
    ...getCommonOptions(),
    path: COOKIE_CONFIG.session.path,
    maxAge: COOKIE_CONFIG.session.maxAge,
  });
}

/**
 * Create a logged-in indicator cookie.
 * Non-httpOnly for client-side auth detection across same-domain apps.
 * Contains no sensitive data -- just signals "a session exists".
 *
 * @remarks This cookie is informational only. It can be stale if a session
 * is revoked server-side without an explicit logout (e.g., suspension, token
 * rotation). Never use it to gate access -- only for UI hints.
 */
export function createLoggedInIndicatorCookie(): string {
  return serialize(COOKIE_CONFIG.loggedIn.name, COOKIE_CONFIG.loggedIn.value, {
    ...getCommonOptions(false),
    path: COOKIE_CONFIG.loggedIn.path,
    maxAge: COOKIE_CONFIG.loggedIn.maxAge,
  });
}

/**
 * Create a cookie that clears the logged-in indicator
 */
export function createClearLoggedInIndicatorCookie(): string {
  return serialize(COOKIE_CONFIG.loggedIn.name, '', {
    ...getCommonOptions(false),
    path: COOKIE_CONFIG.loggedIn.path,
    expires: new Date(0),
  });
}

/**
 * Create a cookie that clears the session
 *
 * @returns Serialized cookie string that expires the session
 */
export function createClearSessionCookie(): string {
  return serialize(COOKIE_CONFIG.session.name, '', {
    ...getCommonOptions(),
    path: COOKIE_CONFIG.session.path,
    expires: new Date(0),
  });
}

/**
 * Append session cookie to headers for login responses
 *
 * @param headers - Headers object to append cookies to
 * @param sessionToken - The opaque session token
 */
export function appendSessionCookie(headers: Headers, sessionToken: string): void {
  headers.append('Set-Cookie', createSessionCookie(sessionToken));
  headers.append('Set-Cookie', createLoggedInIndicatorCookie());
}

/**
 * Create a short-lived, JS-readable cookie to hand a device token to the client
 * during OAuth/signup redirects. The client reads it once, stores the value in
 * localStorage, then immediately clears the cookie.
 *
 * NOT httpOnly so document.cookie can read it; SameSite=Lax for redirect compat.
 */
export function createDeviceTokenHandoffCookie(deviceToken: string): string {
  return serialize('ps_device_token', deviceToken, {
    ...getCommonOptions(false), // httpOnly = false
    sameSite: 'lax',
    path: '/',
    maxAge: 60, // 1 minute — just long enough for the redirect round-trip
  });
}

/**
 * Append clear cookies to headers for logout responses
 *
 * @param headers - Headers object to append cookies to
 */
export function appendClearCookies(headers: Headers): void {
  headers.append('Set-Cookie', createClearSessionCookie());
  headers.append('Set-Cookie', createClearLoggedInIndicatorCookie());
}

/**
 * Get session token from cookie header
 *
 * @param cookieHeader - The cookie header string
 * @returns The session token or null if not found
 */
export function getSessionFromCookies(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const cookies = parse(cookieHeader);
  return cookies[COOKIE_CONFIG.session.name] ?? null;
}

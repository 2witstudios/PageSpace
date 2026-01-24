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

import { serialize } from 'cookie';

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
} as const;

/**
 * Get common cookie options based on environment
 */
function getCommonOptions() {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict' as const,
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
}

/**
 * Append clear cookies to headers for logout responses
 *
 * @param headers - Headers object to append cookies to
 */
export function appendClearCookies(headers: Headers): void {
  headers.append('Set-Cookie', createClearSessionCookie());
}

/**
 * Get session token from cookie header
 *
 * @param cookieHeader - The cookie header string
 * @returns The session token or null if not found
 */
export function getSessionFromCookies(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
    const [key, value] = cookie.trim().split('=');
    if (key && value) acc[key] = value;
    return acc;
  }, {} as Record<string, string>);

  return cookies[COOKIE_CONFIG.session.name] ?? null;
}

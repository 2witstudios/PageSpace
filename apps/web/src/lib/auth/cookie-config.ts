/**
 * Cookie Security Configuration (P3-T4)
 *
 * Centralized cookie configuration for all auth-related cookies.
 * This ensures consistent security settings across login, refresh, and logout routes.
 *
 * SECURITY FEATURES:
 * - httpOnly: Prevents XSS attacks from accessing tokens via JavaScript
 * - secure: Ensures cookies are only sent over HTTPS in production
 * - sameSite: strict - Prevents CSRF attacks by not sending cookies with cross-site requests
 * - path scoping: Refresh token limited to /api/auth endpoints (refresh, logout)
 *
 * @module @pagespace/web/lib/auth/cookie-config
 */

import { serialize } from 'cookie';
import { getRefreshTokenMaxAge } from '@pagespace/lib/server';

/**
 * Cookie configuration constants
 */
export const COOKIE_CONFIG = {
  accessToken: {
    name: 'accessToken',
    maxAge: 15 * 60, // 15 minutes
    path: '/',
  },
  refreshToken: {
    name: 'refreshToken',
    path: '/api/auth', // SCOPED: Only sent to auth endpoints (refresh, logout)
    // maxAge is dynamic - use getRefreshTokenMaxAge()
  },
  /**
   * Legacy paths for migration: clear old cookies from previous deployments
   * Required during transition from unscoped to scoped refresh token path
   */
  legacyRefreshTokenPath: '/',
  /**
   * Previous scoped path: /api/auth/refresh was used before /api/auth
   * Clear this to handle any lingering cookies from intermediate rollouts
   */
  legacyRefreshTokenPathScoped: '/api/auth/refresh',
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
 * Create an access token cookie string
 *
 * @param token - The JWT access token
 * @returns Serialized cookie string for Set-Cookie header
 */
export function createAccessTokenCookie(token: string): string {
  return serialize(COOKIE_CONFIG.accessToken.name, token, {
    ...getCommonOptions(),
    path: COOKIE_CONFIG.accessToken.path,
    maxAge: COOKIE_CONFIG.accessToken.maxAge,
  });
}

/**
 * Create a refresh token cookie string with scoped path
 *
 * The refresh token is scoped to /api/auth/refresh to minimize exposure.
 * This prevents the refresh token from being sent with every request.
 *
 * @param token - The JWT refresh token
 * @returns Serialized cookie string for Set-Cookie header
 */
export function createRefreshTokenCookie(token: string): string {
  return serialize(COOKIE_CONFIG.refreshToken.name, token, {
    ...getCommonOptions(),
    path: COOKIE_CONFIG.refreshToken.path,
    maxAge: getRefreshTokenMaxAge(),
  });
}

/**
 * Create a cookie that clears the access token
 *
 * @returns Serialized cookie string that expires the access token
 */
export function createClearAccessTokenCookie(): string {
  return serialize(COOKIE_CONFIG.accessToken.name, '', {
    ...getCommonOptions(),
    path: COOKIE_CONFIG.accessToken.path,
    expires: new Date(0),
  });
}

/**
 * Create a cookie that clears the refresh token
 *
 * @returns Serialized cookie string that expires the refresh token
 */
export function createClearRefreshTokenCookie(): string {
  return serialize(COOKIE_CONFIG.refreshToken.name, '', {
    ...getCommonOptions(),
    path: COOKIE_CONFIG.refreshToken.path,
    expires: new Date(0),
  });
}

/**
 * Create a cookie that clears the legacy refresh token (path '/')
 *
 * MIGRATION: This clears old refresh tokens that used path '/' instead of
 * the new scoped path '/api/auth'. During migration, this should be used
 * to ensure cleanup.
 *
 * @returns Serialized cookie string that expires the legacy refresh token
 */
export function createClearLegacyRefreshTokenCookie(): string {
  return serialize(COOKIE_CONFIG.refreshToken.name, '', {
    ...getCommonOptions(),
    path: COOKIE_CONFIG.legacyRefreshTokenPath,
    expires: new Date(0),
  });
}

/**
 * Create a cookie that clears the legacy scoped refresh token (path '/api/auth/refresh')
 *
 * MIGRATION: This clears refresh tokens from intermediate rollouts that used
 * the narrower path '/api/auth/refresh' before we settled on '/api/auth'.
 *
 * @returns Serialized cookie string that expires the legacy scoped refresh token
 */
export function createClearLegacyScopedRefreshTokenCookie(): string {
  return serialize(COOKIE_CONFIG.refreshToken.name, '', {
    ...getCommonOptions(),
    path: COOKIE_CONFIG.legacyRefreshTokenPathScoped,
    expires: new Date(0),
  });
}

/**
 * Get all clear cookies for logout
 *
 * Returns current and all legacy cookie clear strings.
 * Use all of these during logout to ensure complete session termination.
 *
 * @returns Object with all clear cookie strings
 */
export function createClearCookies(): {
  accessToken: string;
  refreshToken: string;
  legacyRefreshToken: string;
  legacyScopedRefreshToken: string;
} {
  return {
    accessToken: createClearAccessTokenCookie(),
    refreshToken: createClearRefreshTokenCookie(),
    legacyRefreshToken: createClearLegacyRefreshTokenCookie(),
    legacyScopedRefreshToken: createClearLegacyScopedRefreshTokenCookie(),
  };
}

/**
 * Append auth cookies to headers for login/refresh responses
 *
 * Sets both the access token and refresh token cookies.
 * Also clears any legacy refresh token cookie (migration).
 *
 * @param headers - Headers object to append cookies to
 * @param accessToken - The JWT access token
 * @param refreshToken - The JWT refresh token
 */
export function appendAuthCookies(
  headers: Headers,
  accessToken: string,
  refreshToken: string
): void {
  headers.append('Set-Cookie', createAccessTokenCookie(accessToken));
  headers.append('Set-Cookie', createRefreshTokenCookie(refreshToken));
  // Clear any legacy refresh token cookies during migration
  headers.append('Set-Cookie', createClearLegacyRefreshTokenCookie());
  headers.append('Set-Cookie', createClearLegacyScopedRefreshTokenCookie());
}

/**
 * Append clear cookies to headers for logout responses
 *
 * Clears access token, refresh token, and legacy refresh token cookies.
 *
 * @param headers - Headers object to append cookies to
 */
export function appendClearCookies(headers: Headers): void {
  const clearCookies = createClearCookies();
  headers.append('Set-Cookie', clearCookies.accessToken);
  headers.append('Set-Cookie', clearCookies.refreshToken);
  headers.append('Set-Cookie', clearCookies.legacyRefreshToken);
  headers.append('Set-Cookie', clearCookies.legacyScopedRefreshToken);
}

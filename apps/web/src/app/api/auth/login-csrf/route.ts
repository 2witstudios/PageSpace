import { NextResponse } from 'next/server';
import { serialize } from 'cookie';
import {
  generateLoginCSRFToken,
  LOGIN_CSRF_COOKIE_NAME,
  LOGIN_CSRF_MAX_AGE,
} from '@/lib/auth/login-csrf-utils';

/**
 * GET /api/auth/login-csrf
 *
 * Generates a login CSRF token for the login/signup forms.
 * The token is returned in both the response body and as an httpOnly cookie.
 *
 * Security:
 * - Token is valid for 5 minutes
 * - Token is HMAC-SHA256 signed
 * - Cookie is httpOnly to prevent XSS theft
 * - SameSite=strict prevents cross-site requests
 */
export async function GET() {
  const token = generateLoginCSRFToken();

  const isProduction = process.env.NODE_ENV === 'production';

  const cookie = serialize(LOGIN_CSRF_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: LOGIN_CSRF_MAX_AGE,
    path: '/api/auth',
    ...(isProduction && process.env.COOKIE_DOMAIN && { domain: process.env.COOKIE_DOMAIN })
  });

  return NextResponse.json(
    { csrfToken: token },
    {
      headers: {
        'Set-Cookie': cookie,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    }
  );
}

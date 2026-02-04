import { NextRequest, NextResponse } from 'next/server';
import { monitoringMiddleware } from '@/middleware/monitoring';
import {
  createSecureResponse,
  createSecureErrorResponse,
} from '@/middleware/security-headers';
import { logSecurityEvent } from '@pagespace/lib/server';
import {
  validateOriginForMiddleware,
  isOriginValidationBlocking,
} from '@/lib/auth';
import { getSessionFromCookies } from '@/lib/auth/cookie-config';

// Edge-safe middleware: only checks presence of auth tokens, not validity.
// Full validation happens in route handlers via verifyAuth()/validateMCPToken().

const MCP_BEARER_PREFIX = 'Bearer mcp_';
const SESSION_BEARER_PREFIX = 'Bearer ps_sess_';

export async function middleware(req: NextRequest) {
  return monitoringMiddleware(req, async () => {
    const { pathname } = req.nextUrl;
    const isProduction = process.env.NODE_ENV === 'production';
    const isAPIRoute = pathname.startsWith('/api');
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0] ||
      req.headers.get('x-real-ip') ||
      'unknown';

    // Origin validation for API routes (defense-in-depth)
    if (pathname.startsWith('/api')) {
      const originResult = validateOriginForMiddleware(req);

      if (!originResult.valid && !originResult.skipped) {
        if (isOriginValidationBlocking()) {
          logSecurityEvent('origin_validation_failed', {
            pathname,
            origin: originResult.origin,
            reason: originResult.reason,
            action: 'blocked',
            ip,
          });
          return createSecureErrorResponse(
            { error: 'Origin not allowed', code: 'ORIGIN_INVALID' },
            403,
            isProduction
          );
        }
        logSecurityEvent('origin_validation_warning', {
          pathname,
          origin: originResult.origin,
          reason: originResult.reason,
          action: 'allowed',
          ip,
        });
      }
    }

    // Bearer token format check (Edge-safe - no database access)
    // Full validation happens in route handlers via validateMCPToken()/validateSessionToken()
    const authHeader = req.headers.get('authorization');
    if (authHeader?.startsWith(MCP_BEARER_PREFIX) || authHeader?.startsWith(SESSION_BEARER_PREFIX)) {
      // API routes get restrictive CSP (no nonce needed)
      const { response } = createSecureResponse(isProduction, req, true);
      return response;
    }

    // Public routes that don't require authentication
    // Note: Cron routes handle their own auth via validateCronRequest (internal network only)
    if (
      pathname.startsWith('/api/auth/login') ||
      pathname.startsWith('/api/auth/signup') ||
      pathname.startsWith('/api/auth/csrf') ||
      pathname.startsWith('/api/auth/google') ||
      pathname.startsWith('/api/mcp/') ||
      pathname.startsWith('/api/drives') ||
      pathname.startsWith('/api/cron/') ||
      pathname === '/api/memory/cron' ||
      pathname === '/api/pulse/cron'
    ) {
      const { response } = createSecureResponse(isProduction, req, isAPIRoute);
      return response;
    }

    // Session cookie presence check (Edge-safe - no database access)
    // Full validation happens in route handlers via verifyAuth()
    const cookieHeader = req.headers.get('cookie');
    const sessionToken = getSessionFromCookies(cookieHeader);

    if (!sessionToken) {
      logSecurityEvent('unauthorized', {
        pathname,
        reason: 'No session token',
        ip,
      });

      if (isAPIRoute) {
        return createSecureErrorResponse('Authentication required', 401, isProduction);
      }

      return NextResponse.redirect(new URL('/auth/signin', req.url));
    }

    // Session cookie exists - let request through
    // Route handlers will validate the session and check admin role
    const { response } = createSecureResponse(isProduction, req, isAPIRoute);

    return response;
  });
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico|auth).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

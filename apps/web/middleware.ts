import { NextRequest, NextResponse } from 'next/server';
import { monitoringMiddleware } from '@/middleware/monitoring';
import { logSecurityEvent } from '@pagespace/lib/server';
import {
  validateOriginForMiddleware,
  isOriginValidationBlocking,
} from '@/lib/auth';
import { getSessionFromCookies } from '@/lib/auth/cookie-config';

// Edge-safe middleware: only checks presence of auth tokens, not validity.
// Full validation happens in route handlers via verifyAuth()/validateMCPToken().

const MCP_BEARER_PREFIX = 'Bearer mcp_';

export async function middleware(req: NextRequest) {
  return monitoringMiddleware(req, async () => {
    const { pathname } = req.nextUrl;
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
          return new NextResponse(
            JSON.stringify({
              error: 'Origin not allowed',
              code: 'ORIGIN_INVALID',
            }),
            {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            }
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

    // MCP token format check (Edge-safe - no database access)
    // Full validation happens in route handlers via validateMCPToken()
    const authHeader = req.headers.get('authorization');
    if (authHeader?.startsWith(MCP_BEARER_PREFIX)) {
      // Let the request through - route handlers will validate the token
      return NextResponse.next();
    }

    // Public routes that don't require authentication
    if (
      pathname.startsWith('/api/auth/login') ||
      pathname.startsWith('/api/auth/signup') ||
      pathname.startsWith('/api/auth/csrf') ||
      pathname.startsWith('/api/auth/google') ||
      pathname.startsWith('/api/mcp/') ||
      pathname.startsWith('/api/drives')
    ) {
      return NextResponse.next();
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

      if (pathname.startsWith('/api')) {
        return new NextResponse('Authentication required', { status: 401 });
      }

      return NextResponse.redirect(new URL('/auth/signin', req.url));
    }

    // Session cookie exists - let request through
    // Route handlers will validate the session and check admin role
    const response = NextResponse.next();

    // Security headers
    response.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob: https:; " +
      "connect-src 'self' ws: wss: https:; " +
      "font-src 'self' data:; " +
      "frame-ancestors 'none';"
    );
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

    if (process.env.NODE_ENV === 'production') {
      response.headers.set(
        'Strict-Transport-Security',
        'max-age=63072000; includeSubDomains; preload'
      );
    }

    return response;
  });
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|auth).*)',
  ],
};

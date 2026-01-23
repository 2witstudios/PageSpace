import { NextRequest, NextResponse } from 'next/server';
import { sessionService } from '@pagespace/lib/auth';
import { monitoringMiddleware } from '@/middleware/monitoring';
import { loggers, logAuthEvent, logSecurityEvent } from '@pagespace/lib/server';
import {
  validateMCPToken,
  validateOriginForMiddleware,
  isOriginValidationBlocking,
} from '@/lib/auth';
import { getSessionFromCookies } from '@/lib/auth/cookie-config';

// Use Node.js runtime for database access in session validation
// Edge runtime doesn't support node-postgres which sessionService uses
export const runtime = 'nodejs';

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

    // MCP token authentication
    const authHeader = req.headers.get('authorization');
    if (authHeader?.startsWith(MCP_BEARER_PREFIX)) {
      const mcpToken = authHeader.substring('Bearer '.length);
      const authDetails = await validateMCPToken(mcpToken);

      if (authDetails) {
        logAuthEvent('login', authDetails.userId, undefined, ip, 'MCP token');

        const requestHeaders = new Headers(req.headers);
        requestHeaders.set('x-user-id', authDetails.userId);
        requestHeaders.set('x-auth-type', 'mcp');
        requestHeaders.set('x-auth-role', authDetails.role);
        requestHeaders.set('x-auth-token-version', String(authDetails.tokenVersion));

        return NextResponse.next({
          request: {
            headers: requestHeaders,
          },
        });
      }

      logSecurityEvent('invalid_token', {
        type: 'mcp',
        token: `${mcpToken.slice(0, 10)}...`,
        ip,
      });

      if (pathname.startsWith('/api')) {
        return new NextResponse('Invalid MCP token', { status: 401 });
      }
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

    // Session-based authentication
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

    // Validate session with server
    const sessionClaims = await sessionService.validateSession(sessionToken);

    if (!sessionClaims) {
      logSecurityEvent('invalid_token', {
        type: 'session',
        pathname,
        ip,
      });

      if (pathname.startsWith('/api')) {
        return new NextResponse('Invalid or expired session', { status: 401 });
      }

      return NextResponse.redirect(new URL('/auth/signin', req.url));
    }

    // Admin route protection
    if (pathname.startsWith('/admin')) {
      if (sessionClaims.userRole !== 'admin') {
        logSecurityEvent('unauthorized', {
          pathname,
          reason: 'Admin access required',
          userId: sessionClaims.userId,
          userRole: sessionClaims.userRole,
          ip,
        });

        if (pathname.startsWith('/api/admin')) {
          return new NextResponse('Admin access required', { status: 403 });
        }

        return NextResponse.redirect(new URL('/', req.url));
      }
    }

    // Set request headers with session claims
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('x-user-id', sessionClaims.userId);
    requestHeaders.set('x-user-role', sessionClaims.userRole);
    requestHeaders.set('x-session-id', sessionClaims.sessionId);

    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });

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

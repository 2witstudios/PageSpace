import { NextRequest, NextResponse } from 'next/server';
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { monitoringMiddleware } from '@/middleware/monitoring';
import { loggers, logAuthEvent, logSecurityEvent } from '@pagespace/lib/server';
import {
  validateMCPToken,
  validateOriginForMiddleware,
  isOriginValidationBlocking,
} from '@/lib/auth';

const MCP_BEARER_PREFIX = 'Bearer mcp_';

export async function middleware(req: NextRequest) {
  return monitoringMiddleware(req, async () => {
    const { pathname } = req.nextUrl;
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0] ||
      req.headers.get('x-real-ip') ||
      'unknown';

    // Origin validation for API routes (defense-in-depth)
    // This provides application-wide origin checking as an additional security layer
    // By default operates in warning-only mode; set ORIGIN_VALIDATION_MODE=block to reject
    if (pathname.startsWith('/api')) {
      const originResult = validateOriginForMiddleware(req);

      if (!originResult.valid && !originResult.skipped) {
        // Origin validation failed
        if (isOriginValidationBlocking()) {
          // Block mode: reject the request
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
        // Warn mode: log warning but allow request to continue
        logSecurityEvent('origin_validation_warning', {
          pathname,
          origin: originResult.origin,
          reason: originResult.reason,
          action: 'allowed',
          ip,
        });
      }
    }

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

    if (
      pathname.startsWith('/api/auth/login') ||
      pathname.startsWith('/api/auth/signup') ||
      pathname.startsWith('/api/auth/refresh') ||
      pathname.startsWith('/api/auth/csrf') ||
      pathname.startsWith('/api/auth/google') ||
      pathname.startsWith('/api/mcp/') ||
      pathname.startsWith('/api/drives')
    ) {
      return NextResponse.next();
    }

    const cookieHeader = req.headers.get('cookie');
    const cookies = parse(cookieHeader || '');
    const accessToken = cookies.accessToken;

    if (!accessToken) {
      logSecurityEvent('unauthorized', {
        pathname,
        reason: 'No access token',
        ip,
      });

      if (pathname.startsWith('/api')) {
        return new NextResponse('Authentication required', { status: 401 });
      }

      return NextResponse.redirect(new URL('/auth/signin', req.url));
    }

    const decoded = await decodeToken(accessToken);

    if (!decoded) {
      const refreshToken = cookies.refreshToken;

      if (refreshToken && pathname.startsWith('/api/auth/refresh')) {
        return NextResponse.next();
      }

      if (refreshToken) {
        if (pathname.startsWith('/api')) {
          return new NextResponse('Token expired', {
            status: 401,
            headers: {
              'X-Auth-Error': 'token-expired',
            },
          });
        }

        const response = NextResponse.next();
        response.headers.set('X-Auth-Error', 'token-expired');
        return response;
      }

      logSecurityEvent('invalid_token', {
        type: 'jwt',
        pathname,
        ip,
      });

      if (pathname.startsWith('/api')) {
        return new NextResponse('Invalid token', { status: 401 });
      }

      return NextResponse.redirect(new URL('/auth/signin', req.url));
    }

    if (pathname.startsWith('/admin')) {
      if (decoded.role !== 'admin') {
        logSecurityEvent('unauthorized', {
          pathname,
          reason: 'Admin access required',
          userId: decoded.userId,
          userRole: decoded.role,
          ip,
        });

        if (pathname.startsWith('/api/admin')) {
          return new NextResponse('Admin access required', { status: 403 });
        }

        return NextResponse.redirect(new URL('/', req.url));
      }
    }

    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('x-user-id', decoded.userId);
    requestHeaders.set('x-user-role', decoded.role);

    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });

    // Add security headers
    response.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " + // TipTap/Monaco require unsafe-eval
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

    // Add HSTS in production
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

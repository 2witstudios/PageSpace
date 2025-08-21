import { NextRequest, NextResponse } from 'next/server';
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { db, mcpTokens, eq } from '@pagespace/db';
import { monitoringMiddleware } from '@/middleware/monitoring';
import { loggers, logAuthEvent, logSecurityEvent } from '@pagespace/lib/logger-config';

async function validateMCPToken(token: string): Promise<string | null> {
  try {
    // Look up the MCP token in the database
    const mcpToken = await db.query.mcpTokens.findFirst({
      where: (tokens, { eq, isNull, and }) => and(
        eq(tokens.token, token),
        isNull(tokens.revokedAt)
      ),
    });

    if (!mcpToken) {
      return null;
    }

    // Update last used timestamp
    await db
      .update(mcpTokens)
      .set({ lastUsed: new Date() })
      .where(eq(mcpTokens.id, mcpToken.id));

    return mcpToken.userId;
  } catch (error) {
    loggers.auth.error('Error validating MCP token', error as Error);
    return null;
  }
}

export async function middleware(req: NextRequest) {
  // Wrap with monitoring middleware
  return monitoringMiddleware(req, async () => {
    const { pathname } = req.nextUrl;
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || 
               req.headers.get('x-real-ip') || 'unknown';

    // Check for Bearer token (MCP authentication) first
    const authHeader = req.headers.get('authorization');
    if (authHeader?.startsWith('Bearer mcp_')) {
      const mcpToken = authHeader.substring(7); // Remove "Bearer " prefix
      const userId = await validateMCPToken(mcpToken);
      
      if (userId) {
        logAuthEvent('login', userId, undefined, ip, 'MCP token');
        
        // Add userId to headers for downstream use
        const requestHeaders = new Headers(req.headers);
        requestHeaders.set('x-user-id', userId);
        requestHeaders.set('x-auth-type', 'mcp');
        
        const response = NextResponse.next({
          request: {
            headers: requestHeaders,
          },
        });
        return response;
      } else {
        // Invalid MCP token
        logSecurityEvent('invalid_token', { 
          type: 'mcp', 
          token: mcpToken.substring(0, 10) + '...', 
          ip 
        });
        
        if (pathname.startsWith('/api')) {
          return new NextResponse('Invalid MCP token', { status: 401 });
        }
      }
    }

    // Allow specific auth routes and MCP endpoints to be accessed without authentication
    if (pathname.startsWith('/api/auth/login') || 
        pathname.startsWith('/api/auth/signup') || 
        pathname.startsWith('/api/auth/refresh') ||
        pathname.startsWith('/api/auth/csrf') ||
        pathname.startsWith('/api/auth/google') ||
        pathname.startsWith('/api/mcp/') ||
        pathname.startsWith('/api/drives')) {
      return NextResponse.next();
    }

    // Check for cookie-based authentication
    const cookieHeader = req.headers.get('cookie');
    const cookies = parse(cookieHeader || '');
    const accessToken = cookies.accessToken;

    if (!accessToken) {
      logSecurityEvent('unauthorized', { 
        pathname, 
        reason: 'No access token',
        ip 
      });
      
      // If on an API route, return 401
      if (pathname.startsWith('/api')) {
        return new NextResponse('Authentication required', { status: 401 });
      }
      // For page routes, redirect to signin
      return NextResponse.redirect(new URL('/auth/signin', req.url));
    }

    const decoded = await decodeToken(accessToken);

    if (!decoded) {
      // Check if we have a refresh token before fully rejecting
      const refreshToken = cookies.refreshToken;
      
      if (refreshToken && pathname.startsWith('/api/auth/refresh')) {
        // Allow refresh endpoint even with expired access token
        return NextResponse.next();
      }
      
      if (refreshToken) {
        // We have a refresh token, so this might be an expired access token
        // For API routes, return 401 to trigger refresh on client
        if (pathname.startsWith('/api')) {
          return new NextResponse('Token expired', { 
            status: 401,
            headers: {
              'X-Auth-Error': 'token-expired'
            }
          });
        }
        
        // For page routes, allow the request but the client should refresh
        const response = NextResponse.next();
        response.headers.set('X-Auth-Error', 'token-expired');
        return response;
      }
      
      // No refresh token, fully logged out
      logSecurityEvent('invalid_token', { 
        type: 'jwt',
        pathname,
        ip 
      });
      
      // If on an API route, return 401
      if (pathname.startsWith('/api')) {
        return new NextResponse('Invalid token', { status: 401 });
      }
      // For page routes, redirect to signin
      return NextResponse.redirect(new URL('/auth/signin', req.url));
    }

    // Check admin routes
    if (pathname.startsWith('/admin')) {
      if (decoded.role !== 'admin') {
        logSecurityEvent('unauthorized', { 
          pathname, 
          reason: 'Admin access required',
          userId: decoded.userId,
          userRole: decoded.role,
          ip 
        });
        
        // If on an API route, return 403
        if (pathname.startsWith('/api/admin')) {
          return new NextResponse('Admin access required', { status: 403 });
        }
        // For page routes, redirect to home
        return NextResponse.redirect(new URL('/', req.url));
      }
    }

    // Token is valid, proceed with the request
    return NextResponse.next();
  });
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - /auth (authentication pages)
     */
    '/((?!_next/static|_next/image|favicon.ico|auth).*)',
  ],
};
import { NextRequest, NextResponse } from 'next/server';
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { db, mcpTokens, users, eq, and, isNull } from '@pagespace/db';

export interface AuthUser {
  userId: string;
  role: 'user' | 'admin';
  tokenVersion: number;
  authType: 'cookie' | 'mcp';
}

/**
 * Validates MCP token and returns user information
 */
async function validateMCPToken(token: string): Promise<AuthUser | null> {
  try {
    if (!token || !token.startsWith('mcp_')) {
      return null;
    }

    const tokenData = await db.query.mcpTokens.findFirst({
      where: and(
        eq(mcpTokens.token, token),
        isNull(mcpTokens.revokedAt)
      ),
      with: {
        user: true,
      },
    });

    if (!tokenData) {
      return null;
    }

    // Update last used timestamp
    await db
      .update(mcpTokens)
      .set({ lastUsed: new Date() })
      .where(eq(mcpTokens.id, tokenData.id));

    return {
      userId: tokenData.userId,
      role: tokenData.user.role as 'user' | 'admin',
      tokenVersion: tokenData.user.tokenVersion,
      authType: 'mcp',
    };
  } catch (error) {
    console.error('MCP token validation error:', error);
    return null;
  }
}

/**
 * Extracts and validates authentication from a request
 * Supports both cookie-based JWT and MCP Bearer tokens
 */
export async function getAuthUser(request: Request | NextRequest): Promise<AuthUser | null> {
  // Check for Bearer token (MCP authentication) first
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer mcp_')) {
    const mcpToken = authHeader.substring(7); // Remove "Bearer " prefix
    return validateMCPToken(mcpToken);
  }

  // Check for x-user-id header (set by middleware for MCP tokens)
  const xUserId = request.headers.get('x-user-id');
  const xAuthType = request.headers.get('x-auth-type');
  if (xUserId && xAuthType === 'mcp') {
    // This was already validated by middleware
    const user = await db.query.users.findFirst({
      where: eq(users.id, xUserId),
      columns: {
        id: true,
        role: true,
        tokenVersion: true,
      },
    });

    if (user) {
      return {
        userId: user.id,
        role: user.role as 'user' | 'admin',
        tokenVersion: user.tokenVersion,
        authType: 'mcp',
      };
    }
  }

  // Fall back to cookie authentication
  const cookieHeader = request.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const accessToken = cookies.accessToken;

  if (!accessToken) {
    return null;
  }

  const decoded = await decodeToken(accessToken);
  if (!decoded) {
    return null;
  }

  // Verify token version against database
  const user = await db.query.users.findFirst({
    where: eq(users.id, decoded.userId),
    columns: {
      id: true,
      tokenVersion: true,
      role: true,
    },
  });

  if (!user || user.tokenVersion !== decoded.tokenVersion) {
    return null;
  }

  return {
    userId: decoded.userId,
    role: decoded.role,
    tokenVersion: decoded.tokenVersion,
    authType: 'cookie',
  };
}

/**
 * Requires authentication for an API route
 * Returns the authenticated user or sends a 401 response
 */
export async function requireAuth(
  request: Request | NextRequest
): Promise<AuthUser | NextResponse> {
  const authUser = await getAuthUser(request);

  if (!authUser) {
    return new NextResponse('Unauthorized', { 
      status: 401,
      headers: {
        'Content-Type': 'text/plain',
      },
    });
  }

  return authUser;
}

/**
 * Requires admin authentication for an API route
 * Returns the authenticated admin user or sends a 403 response
 */
export async function requireAdmin(
  request: Request | NextRequest
): Promise<AuthUser | NextResponse> {
  const authUser = await getAuthUser(request);

  if (!authUser) {
    return new NextResponse('Unauthorized', { 
      status: 401,
      headers: {
        'Content-Type': 'text/plain',
      },
    });
  }

  if (authUser.role !== 'admin') {
    return new NextResponse('Forbidden: Admin access required', { 
      status: 403,
      headers: {
        'Content-Type': 'text/plain',
      },
    });
  }

  return authUser;
}

/**
 * Helper to check if the auth result is an error response
 */
export function isAuthError(result: AuthUser | NextResponse): result is NextResponse {
  return result instanceof NextResponse;
}

/**
 * Usage example in an API route:
 * 
 * export async function GET(request: Request) {
 *   const auth = await requireAuth(request);
 *   if (isAuthError(auth)) return auth;
 *   
 *   // auth is now typed as AuthUser
 *   const { userId, role } = auth;
 *   // ... rest of your handler
 * }
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  authenticateSessionRequest,
  isAuthError as isAuthResultError,
} from './index';

/**
 * Extract client IP address from request headers.
 * Checks x-forwarded-for (proxy), x-real-ip (nginx), falls back to 'unknown'.
 *
 * @example
 * const clientIP = getClientIP(request);
 * const rateLimit = await checkDistributedRateLimit(`login:ip:${clientIP}`, config);
 */
export function getClientIP(request: Request | NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

export interface AuthUser {
  userId: string;
  role: 'user' | 'admin';
  tokenVersion: number;
  tokenType: 'session';
  sessionId: string;
}

async function getAuthUser(request: Request | NextRequest): Promise<AuthUser | null> {
  const result = await authenticateSessionRequest(request);
  if (isAuthResultError(result)) {
    return null;
  }

  // authenticateSessionRequest only returns SessionAuthResult on success
  if (result.tokenType !== 'session') {
    return null;
  }

  return {
    userId: result.userId,
    role: result.role,
    tokenVersion: result.tokenVersion,
    tokenType: 'session',
    sessionId: result.sessionId,
  } satisfies AuthUser;
}

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

export function isAuthError(result: AuthUser | NextResponse): result is NextResponse {
  return result instanceof NextResponse;
}

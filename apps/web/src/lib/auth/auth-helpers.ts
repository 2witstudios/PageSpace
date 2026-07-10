import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { authenticateSessionRequest } from './request-auth';
import { isAuthError as isAuthResultError } from './auth-core';

// NOTE: URL helpers (isSafeReturnUrl/isSafeNextPath/SIGNIN_NEXT_ALLOWED_PREFIXES)
// and getClientIP are NOT re-exported here — import them from their owners
// (`./url-utils` and `@pagespace/lib/security/client-ip`) directly (issue #1393).

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

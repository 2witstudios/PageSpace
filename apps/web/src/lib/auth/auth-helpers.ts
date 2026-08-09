import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import {
  authenticateSessionRequest,
  isAuthError as isAuthResultError,
} from './index';

export { isSafeReturnUrl, isSafeNextPath, SIGNIN_NEXT_ALLOWED_PREFIXES } from './url-utils';
export { getClientIP } from '@pagespace/lib/security/client-ip';

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

export function isAuthError(result: AuthUser | NextResponse): result is NextResponse {
  return result instanceof NextResponse;
}

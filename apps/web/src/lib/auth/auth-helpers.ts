import { NextRequest, NextResponse } from 'next/server';
import {
  authenticateWebRequest,
  isAuthError as isAuthResultError,
} from './index';

export interface AuthUser {
  userId: string;
  role: 'user' | 'admin';
  tokenVersion: number;
  tokenType: 'jwt';
}

async function getAuthUser(request: Request | NextRequest): Promise<AuthUser | null> {
  const result = await authenticateWebRequest(request);
  if (isAuthResultError(result)) {
    return null;
  }

  return {
    userId: result.userId,
    role: result.role,
    tokenVersion: result.tokenVersion,
    tokenType: 'jwt',
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

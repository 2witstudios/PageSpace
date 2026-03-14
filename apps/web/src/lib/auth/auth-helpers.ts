import { NextRequest, NextResponse } from 'next/server';
import {
  authenticateSessionRequest,
  isAuthError as isAuthResultError,
} from './index';
import { logUserActivity } from '@pagespace/lib/monitoring/activity-logger';
import { securityAudit, maskEmail } from '@pagespace/lib/audit';

/**
 * Validates that a return URL is a safe same-origin path.
 * Prevents open redirect attacks by ensuring the URL:
 * - Is a relative path starting with /
 * - Does not contain protocol-relative URLs (//evil.com)
 * - Does not contain backslash tricks (\/evil.com)
 * - Does not contain encoded sequences that could bypass validation
 */
export function isSafeReturnUrl(url: string | undefined): boolean {
  if (!url) return true; // undefined/empty falls back to /dashboard
  if (!url.startsWith('/')) return false;
  if (url.startsWith('//') || url.startsWith('/\\')) return false;
  if (/[a-z]+:/i.test(url)) return false;
  try {
    const decoded = decodeURIComponent(url);
    if (decoded.startsWith('//') || decoded.startsWith('/\\')) return false;
    if (/[a-z]+:/i.test(decoded)) return false;
  } catch {
    return false;
  }
  return true;
}

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

export function logLoginAudit(
  user: { id: string; email: string },
  sessionId: string,
  clientIP: string,
  userAgent: string | null
): void {
  logUserActivity(user.id, 'login', {
    targetUserId: user.id,
    targetUserEmail: user.email,
    ip: clientIP,
    userAgent: userAgent || undefined,
  }, { actorEmail: user.email });
  securityAudit.logAuthSuccess(
    user.id, sessionId, clientIP, userAgent || 'unknown'
  ).catch(() => {});
  securityAudit.logTokenCreated(user.id, 'session', clientIP).catch(() => {});
}

export function logSignupAudit(
  user: { id: string; email: string },
  clientIP: string,
  userAgent: string | null,
  method: string
): void {
  logUserActivity(user.id, 'signup', {
    targetUserId: user.id,
    targetUserEmail: user.email,
    ip: clientIP,
    userAgent: userAgent || undefined,
  }, { actorEmail: user.email });
  securityAudit.logEvent({
    eventType: 'auth.session.created',
    userId: user.id,
    ipAddress: clientIP,
    userAgent: userAgent || undefined,
    details: { method, email: maskEmail(user.email) },
  }).catch(() => {});
  securityAudit.logTokenCreated(user.id, 'session', clientIP).catch(() => {});
}

export function logAdminUserCreateAudit(
  adminUserId: string,
  targetUserId: string,
  targetEmail: string,
  role: string,
  clientIP: string,
  userAgent: string | null
): void {
  logUserActivity(adminUserId, 'signup', {
    targetUserId,
    targetUserEmail: targetEmail,
    ip: clientIP,
    userAgent: userAgent || undefined,
  });
  securityAudit.logEvent({
    eventType: 'admin.user.created',
    userId: adminUserId,
    ipAddress: clientIP,
    userAgent: userAgent || undefined,
    resourceType: 'user',
    resourceId: targetUserId,
    details: { targetEmail: maskEmail(targetEmail), role },
  }).catch(() => {});
}

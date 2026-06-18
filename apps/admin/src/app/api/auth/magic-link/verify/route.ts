import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { verifyMagicLinkToken } from '@pagespace/lib/auth/magic-link-service';
import { SESSION_DURATION_MS, ADMIN_SESSION_SERVICE } from '@pagespace/lib/auth/constants';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { appendSessionCookie } from '@/lib/auth/cookie-config';

function getAdminUrl(): string {
  if (!process.env.ADMIN_URL) {
    if (process.env.NODE_ENV === 'production') throw new Error('ADMIN_URL env var must be set in production');
    return 'http://localhost:3005';
  }
  return process.env.ADMIN_URL;
}

/**
 * Sanitizes the `next` redirect parameter to prevent open-redirect attacks.
 *
 * The simple `startsWith('/')` guard is insufficient — backslash variants like
 * `/\evil.example` and percent-encoded forms `/%5Cevil.example` pass the string
 * check but are normalized by `new URL` into external hostnames. This helper uses
 * URL parsing against a sentinel origin to ensure the value is truly a relative
 * path before it is used.
 */
function sanitizeNext(raw: string | null): string {
  if (!raw) return '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return '/';
  }
  let candidate: URL;
  try {
    candidate = new URL(decoded, 'https://internal.invalid');
  } catch {
    return '/';
  }
  if (candidate.hostname !== 'internal.invalid') return '/';
  return candidate.pathname + candidate.search + candidate.hash;
}

function redirectWithError(code: string): NextResponse {
  const url = new URL('/login', getAdminUrl());
  url.searchParams.set('error', code);
  return NextResponse.redirect(url, 302);
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const token = searchParams.get('token') ?? '';
    const next = sanitizeNext(searchParams.get('next'));

    const result = await verifyMagicLinkToken({ token });

    if (!result.ok) {
      const errorMap: Record<string, string> = {
        TOKEN_EXPIRED: 'magic_link_expired',
        TOKEN_ALREADY_USED: 'magic_link_used',
        TOKEN_NOT_FOUND: 'invalid_token',
        USER_SUSPENDED: 'account_suspended',
        VALIDATION_FAILED: 'invalid_token',
      };
      const code = errorMap[result.error.code] ?? 'invalid_token';
      loggers.auth.warn('Admin magic link verification failed', { code: result.error.code });
      return redirectWithError(code);
    }

    const { userId } = result.data;

    // Ensure the authenticated user has admin role
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { role: true },
    });

    if (!user || user.role !== 'admin') {
      loggers.auth.warn('Magic link used by non-admin user', { userId });
      auditRequest(req, {
        eventType: 'authz.access.denied',
        userId,
        resourceType: 'admin-login',
        resourceId: 'magic_link_verify',
        details: { reason: 'not_admin' },
        riskScore: 0.4,
      });
      return redirectWithError('not_admin');
    }

    // Revoke only prior admin-console sessions — never the user's web sessions.
    await sessionService.revokeAdminUserSessions(userId, 'admin_login');

    const sessionToken = await sessionService.createSession({
      userId,
      type: 'user',
      scopes: [],
      expiresInMs: SESSION_DURATION_MS,
      createdByService: ADMIN_SESSION_SERVICE,
    });

    auditRequest(req, {
      eventType: 'auth.login.success',
      userId,
      resourceType: 'admin-login',
      resourceId: 'magic_link_verify',
      details: { method: 'magic_link' },
    });

    const headers = new Headers();
    appendSessionCookie(headers, sessionToken);
    return NextResponse.redirect(new URL(next, getAdminUrl()), { status: 302, headers });
  } catch (error) {
    loggers.auth.error('Admin magic link verify error', error as Error);
    return redirectWithError('server_error');
  }
}

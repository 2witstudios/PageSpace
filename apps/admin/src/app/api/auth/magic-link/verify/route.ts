import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { verifyMagicLinkToken } from '@pagespace/lib/auth/magic-link-service';
import { SESSION_DURATION_MS } from '@pagespace/lib/auth/constants';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { appendSessionCookie } from '@/lib/auth/cookie-config';

function redirectWithError(code: string): Response {
  const base = process.env.ADMIN_URL ?? 'http://localhost:3005';
  const url = new URL('/login', base);
  url.searchParams.set('error', code);
  return Response.redirect(url, 302);
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const token = searchParams.get('token');

    if (!token) {
      return redirectWithError('invalid_token');
    }

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

    const sessionToken = await sessionService.createSession({
      userId,
      type: 'user',
      scopes: [],
      expiresInMs: SESSION_DURATION_MS,
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
    headers.set('Location', '/');
    return new Response(null, { status: 302, headers });
  } catch (error) {
    loggers.auth.error('Admin magic link verify error', error as Error);
    return redirectWithError('server_error');
  }
}

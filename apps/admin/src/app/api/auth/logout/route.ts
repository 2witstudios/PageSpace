import { NextResponse } from 'next/server';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getSessionFromCookies, appendClearCookies } from '@/lib/auth/cookie-config';
import { validateCSRF } from '@/lib/auth/csrf-validation';

// Logout must clear cookies even when the session is already invalid, so this
// does not use withAdminAuth; CSRF is still enforced for the state change.
export async function POST(request: Request) {
  const csrfError = await validateCSRF(request);
  if (csrfError) return csrfError;

  const sessionToken = getSessionFromCookies(request.headers.get('cookie'));
  if (sessionToken) {
    const claims = await sessionService.validateSession(sessionToken, { expectedType: 'user' });
    try {
      await sessionService.revokeSession(sessionToken, 'logout');
      if (claims) {
        auditRequest(request, {
          eventType: 'auth.logout',
          userId: claims.userId,
          resourceType: 'admin-endpoint',
          resourceId: '/api/auth/logout',
        });
      }
    } catch (error) {
      loggers.auth.error('Failed to revoke admin session on logout', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const response = NextResponse.json({ success: true });
  appendClearCookies(response.headers);
  return response;
}

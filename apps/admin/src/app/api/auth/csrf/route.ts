import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getSessionFromCookies } from '@/lib/auth/cookie-config';

export async function GET(req: Request) {
  try {
    const cookieHeader = req.headers.get('cookie');
    const sessionToken = getSessionFromCookies(cookieHeader);

    if (!sessionToken) {
      return Response.json({ error: 'No session found' }, { status: 401 });
    }

    const sessionClaims = await sessionService.validateSession(sessionToken);
    if (!sessionClaims) {
      return Response.json({ error: 'Invalid or expired session' }, { status: 401 });
    }

    const csrfToken = generateCSRFToken(sessionClaims.sessionId);
    return Response.json({ csrfToken });
  } catch (error) {
    loggers.auth.error('CSRF token generation error:', error as Error);
    return Response.json({ error: 'Failed to generate CSRF token' }, { status: 500 });
  }
}

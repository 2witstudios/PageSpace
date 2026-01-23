import { generateCSRFToken, sessionService } from '@pagespace/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { getSessionFromCookies } from '@/lib/auth/cookie-config';

export async function GET(req: Request) {
  try {
    // Extract session token from cookies
    const cookieHeader = req.headers.get('cookie');
    const sessionToken = getSessionFromCookies(cookieHeader);

    if (!sessionToken) {
      return Response.json({ error: 'No session found' }, { status: 401 });
    }

    // Validate session with server
    const sessionClaims = await sessionService.validateSession(sessionToken);
    if (!sessionClaims) {
      return Response.json({ error: 'Invalid or expired session' }, { status: 401 });
    }

    // Generate CSRF token bound to session ID
    const csrfToken = generateCSRFToken(sessionClaims.sessionId);

    return Response.json({ csrfToken });
  } catch (error) {
    loggers.auth.error('CSRF token generation error:', error as Error);
    return Response.json({ error: 'Failed to generate CSRF token' }, { status: 500 });
  }
}

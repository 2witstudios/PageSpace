import { sessionService } from '@pagespace/lib/auth';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { getClientIP } from '@/lib/auth';
import { getSessionFromCookies, appendClearCookies } from '@/lib/auth/cookie-config';

export async function POST(req: Request) {
  const clientIP = getClientIP(req);
  const cookieHeader = req.headers.get('cookie');
  const sessionToken = getSessionFromCookies(cookieHeader);

  if (!sessionToken) {
    // No session to logout from
    const headers = new Headers();
    appendClearCookies(headers);
    return Response.json({ message: 'Logged out successfully' }, { status: 200, headers });
  }

  // Validate session to get user ID for logging
  const sessionClaims = await sessionService.validateSession(sessionToken);
  const userId = sessionClaims?.userId;

  // Revoke the session
  try {
    await sessionService.revokeSession(sessionToken, 'logout');
    loggers.auth.debug('Session revoked on logout', { userId });
  } catch (error) {
    loggers.auth.error('Failed to revoke session on logout', {
      error: error instanceof Error ? error.message : String(error),
      userId,
    });
  }

  // Log the logout event
  if (userId) {
    logAuthEvent('logout', userId, undefined, clientIP);
    trackAuthEvent(userId, 'logout', {
      ip: clientIP,
      userAgent: req.headers.get('user-agent')
    });
  }

  const headers = new Headers();
  appendClearCookies(headers);

  return Response.json({ message: 'Logged out successfully' }, { status: 200, headers });
}

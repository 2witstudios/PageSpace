import { generateCSRFToken, getSessionIdFromJWT, decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { loggers } from '@pagespace/lib/logger-config';

export async function GET(req: Request) {
  try {
    const cookieHeader = req.headers.get('cookie');
    const cookies = parse(cookieHeader || '');
    const accessToken = cookies.accessToken;

    if (!accessToken) {
      return Response.json({ error: 'No session found' }, { status: 401 });
    }

    const decoded = await decodeToken(accessToken);
    if (!decoded) {
      return Response.json({ error: 'Invalid session' }, { status: 401 });
    }

    const sessionId = getSessionIdFromJWT(decoded);
    const csrfToken = generateCSRFToken(sessionId);

    return Response.json({ csrfToken });
  } catch (error) {
    loggers.auth.error('CSRF token generation error:', error as Error);
    return Response.json({ error: 'Failed to generate CSRF token' }, { status: 500 });
  }
}
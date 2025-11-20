import { generateCSRFToken, getSessionIdFromJWT, loggers, decodeToken } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { parse } from 'cookie';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: false } as const;

export async function GET(req: Request) {
  try {
    // Support both Bearer tokens (desktop) and cookies (web)
    const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }

    // Get the JWT token to extract the iat claim
    const authHeader = req.headers.get('authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    const jwtToken = bearerToken || (() => {
      const cookieHeader = req.headers.get('cookie');
      const cookies = parse(cookieHeader || '');
      return cookies.accessToken || null;
    })();

    if (!jwtToken) {
      return Response.json({ error: 'No JWT token found' }, { status: 401 });
    }

    // Decode the JWT to get the iat claim
    const decoded = await decodeToken(jwtToken);
    if (!decoded?.iat) {
      return Response.json({ error: 'Invalid JWT token' }, { status: 401 });
    }

    // Get session ID from JWT claims
    const sessionId = getSessionIdFromJWT({
      userId: auth.userId,
      tokenVersion: auth.tokenVersion,
      iat: decoded.iat,
    });
    const csrfToken = generateCSRFToken(sessionId);

    return Response.json({ csrfToken });
  } catch (error) {
    loggers.auth.error('CSRF token generation error:', error as Error);
    return Response.json({ error: 'Failed to generate CSRF token' }, { status: 500 });
  }
}
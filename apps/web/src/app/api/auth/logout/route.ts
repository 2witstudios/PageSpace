import { refreshTokens } from '@pagespace/db';
import { db, eq } from '@pagespace/db';
import { parse, serialize } from 'cookie';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

export async function POST(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;
  const cookieHeader = req.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const refreshTokenValue = cookies.refreshToken;

  const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] ||
                   req.headers.get('x-real-ip') ||
                   'unknown';

  if (refreshTokenValue) {
    try {
      await db.delete(refreshTokens).where(eq(refreshTokens.token, refreshTokenValue));
    } catch (error) {
      // If the token is not found, we can ignore the error and proceed with clearing cookies.
      loggers.auth.debug('Refresh token not found in DB during logout', { 
        error: (error as Error).message 
      });
    }
  }
  
  // Log the logout event
  logAuthEvent('logout', userId, undefined, clientIP);
  
  // Track logout event
  trackAuthEvent(userId, 'logout', {
    ip: clientIP,
    userAgent: req.headers.get('user-agent')
  });

  const isProduction = process.env.NODE_ENV === 'production';

  const accessTokenCookie = serialize('accessToken', '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    expires: new Date(0),
    ...(isProduction && { domain: process.env.COOKIE_DOMAIN })
  });

  const refreshTokenCookie = serialize('refreshToken', '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    expires: new Date(0),
    ...(isProduction && { domain: process.env.COOKIE_DOMAIN })
  });

  const headers = new Headers();
  headers.append('Set-Cookie', accessTokenCookie);
  headers.append('Set-Cookie', refreshTokenCookie);

  return Response.json({ message: 'Logged out successfully' }, { status: 200, headers });
}
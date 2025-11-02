import { users, refreshTokens } from '@pagespace/db';
import { db, eq, sql } from '@pagespace/db';
import { decodeToken, generateAccessToken, generateRefreshToken, checkRateLimit, RATE_LIMIT_CONFIGS } from '@pagespace/lib/server';
import { generateCSRFToken, getSessionIdFromJWT } from '@pagespace/lib/server';
import { createId } from '@paralleldrive/cuid2';
import { loggers } from '@pagespace/lib/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const refreshTokenValue = body.refreshToken;

    if (!refreshTokenValue) {
      return Response.json({ error: 'Refresh token is required.' }, { status: 400 });
    }

    // Rate limiting by IP address for refresh attempts
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] ||
                     req.headers.get('x-real-ip') ||
                     'unknown';

    const rateLimit = checkRateLimit(`refresh:mobile:${clientIP}`, RATE_LIMIT_CONFIGS.REFRESH);

    if (!rateLimit.allowed) {
      return Response.json(
        {
          error: 'Too many refresh attempts. Please try again later.',
          retryAfter: rateLimit.retryAfter
        },
        {
          status: 429,
          headers: {
            'Retry-After': rateLimit.retryAfter?.toString() || '300'
          }
        }
      );
    }

    // Use database transaction to prevent race conditions
    const result = await db.transaction(async (trx) => {
      // Check if the token exists and delete it atomically
      const existingToken = await trx.query.refreshTokens.findFirst({
        where: eq(refreshTokens.token, refreshTokenValue),
        with: {
          user: true,
        },
      });

      // If token doesn't exist, it might have been stolen and used.
      // For added security, we check if the decoded token is valid and if so,
      // invalidate all sessions for that user.
      if (!existingToken) {
        const decoded = await decodeToken(refreshTokenValue);
        if (decoded) {
          // This is a critical security event. A refresh token that is not in the DB was used.
          // It could be a stolen, already-used token. Invalidate all user sessions.
          await trx.update(users)
            .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
            .where(eq(users.id, decoded.userId));

          loggers.auth.warn('Refresh token reuse detected - invalidating all sessions', {
            userId: decoded.userId,
            ip: clientIP,
            platform: 'mobile'
          });
        }
        return { error: 'Invalid refresh token.' };
      }

      // Delete the token atomically to prevent double-use
      await trx.delete(refreshTokens).where(eq(refreshTokens.id, existingToken.id));

      return { existingToken };
    });

    if (result.error || !result.existingToken) {
      return Response.json({ error: result.error || 'Invalid refresh token.' }, { status: 401 });
    }

    const { existingToken } = result;
    const { user } = existingToken;

    // Verify the token version to ensure it's not from an old session
    const decoded = await decodeToken(refreshTokenValue);
    if (!decoded || decoded.tokenVersion !== user.tokenVersion) {
      return Response.json({ error: 'Invalid refresh token version.' }, { status: 401 });
    }

    // Issue a new pair of tokens
    const newAccessToken = await generateAccessToken(user.id, user.tokenVersion, user.role);
    const newRefreshToken = await generateRefreshToken(user.id, user.tokenVersion, user.role);

    // Store the new refresh token
    await db.insert(refreshTokens).values({
      id: createId(),
      token: newRefreshToken,
      userId: user.id,
      device: req.headers.get('user-agent'),
      ip: clientIP,
    });

    // Generate new CSRF token for mobile client
    // Decode the new access token to get its actual iat claim
    const newDecoded = await decodeToken(newAccessToken);
    if (!newDecoded?.iat) {
      loggers.auth.error('Failed to decode access token for CSRF generation');
      return Response.json({ error: 'Failed to generate session' }, { status: 500 });
    }

    const sessionId = getSessionIdFromJWT({
      userId: user.id,
      tokenVersion: user.tokenVersion,
      iat: newDecoded.iat
    });
    const csrfToken = generateCSRFToken(sessionId);

    // Return tokens in JSON body for mobile clients
    return Response.json({
      token: newAccessToken,
      refreshToken: newRefreshToken,
      csrfToken: csrfToken,
    }, { status: 200 });

  } catch (error) {
    loggers.auth.error('Mobile token refresh error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}

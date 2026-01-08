import { users, refreshTokens, deviceTokens } from '@pagespace/db';
import { db, eq, sql, and, isNull } from '@pagespace/db';
import { decodeToken, generateAccessToken, generateRefreshToken, getRefreshTokenMaxAge, loggers } from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { validateDeviceToken, hashToken, getTokenPrefix } from '@pagespace/lib/auth';
import { serialize } from 'cookie';
import { parse } from 'cookie';
import { createId } from '@paralleldrive/cuid2';
import { getClientIP } from '@/lib/auth';

export async function POST(req: Request) {
  const cookieHeader = req.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const refreshTokenValue = cookies.refreshToken;

  if (!refreshTokenValue) {
    return Response.json({ error: 'Refresh token not found.' }, { status: 401 });
  }

  const clientIP = getClientIP(req);

  // Distributed rate limiting - IP only for refresh
  const distributedIpLimit = await checkDistributedRateLimit(
    `refresh:ip:${clientIP}`,
    DISTRIBUTED_RATE_LIMITS.REFRESH
  );

  if (!distributedIpLimit.allowed) {
    return Response.json(
      {
        error: 'Too many refresh attempts. Please try again later.',
        retryAfter: distributedIpLimit.retryAfter,
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(distributedIpLimit.retryAfter || 300),
          'X-RateLimit-Limit': String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts),
          'X-RateLimit-Remaining': '0',
        },
      }
    );
  }

  // SECURITY: Validate device token if provided
  // This prevents revoked devices from continuing to access the account via refresh tokens
  const deviceTokenHeader = req.headers.get('x-device-token');
  let validatedDeviceTokenId: string | undefined;
  if (deviceTokenHeader) {
    const validDevice = await validateDeviceToken(deviceTokenHeader);
    if (!validDevice) {
      // Device token is revoked, expired, or invalid
      // Reject the refresh request to enforce device revocation
      return Response.json(
        { error: 'Device token is invalid or has been revoked.' },
        { status: 401 }
      );
    }
    // Store the device token ID to link with the new refresh token
    validatedDeviceTokenId = validDevice.id;
  }

  // Use database transaction to prevent race conditions
  const result = await db.transaction(async (trx) => {
    // P1-T3: Hash-based token lookup with plaintext fallback for migration
    const tokenHash = hashToken(refreshTokenValue);

    // Try hash lookup first (new tokens)
    let existingToken = await trx.query.refreshTokens.findFirst({
      where: eq(refreshTokens.tokenHash, tokenHash),
      with: {
        user: true,
      },
    });

    // Fall back to plaintext lookup (legacy tokens during migration)
    if (!existingToken) {
      existingToken = await trx.query.refreshTokens.findFirst({
        where: eq(refreshTokens.token, refreshTokenValue),
        with: {
          user: true,
        },
      });
    }

    // If token doesn't exist, it might have been stolen and used.
    // For added security, we can check if the decoded token is valid and if so,
    // invalidate all sessions for that user.
    if (!existingToken) {
      const decoded = await decodeToken(refreshTokenValue);
      if (decoded) {
        // This is a critical security event. A refresh token that is not in the DB was used.
        // It could be a stolen, already-used token. Invalidate all user sessions.
        await trx.update(users)
          .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
          .where(eq(users.id, decoded.userId));

        // SECURITY: Also revoke all device tokens for this user
        // This prevents device tokens from bypassing the tokenVersion bump
        await trx.update(deviceTokens)
          .set({
            revokedAt: new Date(),
            revokedReason: 'token_version_bump_refresh_reuse'
          })
          .where(and(
            eq(deviceTokens.userId, decoded.userId),
            isNull(deviceTokens.revokedAt)
          ));
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

  const refreshPayload = await decodeToken(newRefreshToken);
  const refreshExpiresAt = refreshPayload?.exp
    ? new Date(refreshPayload.exp * 1000)
    : new Date(Date.now() + getRefreshTokenMaxAge() * 1000);

  // Store the new refresh token with hash (P1-T3)
  await db.insert(refreshTokens).values({
    id: createId(),
    token: newRefreshToken,
    tokenHash: hashToken(newRefreshToken),
    tokenPrefix: getTokenPrefix(newRefreshToken),
    userId: user.id,
    device: req.headers.get('user-agent'),
    userAgent: req.headers.get('user-agent'),
    ip: clientIP,
    lastUsedAt: new Date(),
    platform: 'web',
    expiresAt: refreshExpiresAt,
    // Link to device token if validated (enables device-based revocation)
    deviceTokenId: validatedDeviceTokenId,
  });

  const isProduction = process.env.NODE_ENV === 'production';

  const accessTokenCookie = serialize('accessToken', newAccessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: 15 * 60, // 15 minutes
    ...(isProduction && { domain: process.env.COOKIE_DOMAIN })
  });

  const refreshTokenCookie = serialize('refreshToken', newRefreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: getRefreshTokenMaxAge(), // Configurable via REFRESH_TOKEN_TTL env var (default: 30d)
    ...(isProduction && { domain: process.env.COOKIE_DOMAIN })
  });

  // Reset rate limit on successful refresh
  try {
    await resetDistributedRateLimit(`refresh:ip:${clientIP}`);
  } catch (error) {
    loggers.auth.warn('Rate limit reset failed after successful refresh', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const headers = new Headers();
  headers.append('Set-Cookie', accessTokenCookie);
  headers.append('Set-Cookie', refreshTokenCookie);
  headers.set('X-RateLimit-Limit', String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts));
  // After successful refresh and rate limit reset, remaining attempts are back to max
  headers.set('X-RateLimit-Remaining', String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts));

  return Response.json({ message: 'Token refreshed successfully' }, { status: 200, headers });
}
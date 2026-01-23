import { refreshTokens, db } from '@pagespace/db';
import { atomicTokenRefresh } from '@pagespace/db/transactions/auth-transactions';
import { decodeToken, generateAccessToken, generateRefreshToken, getRefreshTokenMaxAge, loggers } from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { validateDeviceToken, hashToken, getTokenPrefix } from '@pagespace/lib/auth';
import { parse } from 'cookie';
import { createId } from '@paralleldrive/cuid2';
import { getClientIP, appendAuthCookies } from '@/lib/auth';

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

  // SECURITY: Decode JWT to get tokenVersion for validation
  // This ensures tokens minted before "logout all devices" are rejected
  const refreshPayloadCheck = await decodeToken(refreshTokenValue);
  if (!refreshPayloadCheck) {
    // JWT is malformed or expired - cannot proceed
    return Response.json({ error: 'Invalid refresh token format.' }, { status: 401 });
  }
  const jwtTokenVersion = refreshPayloadCheck.tokenVersion;

  // SECURITY: Atomic token refresh with FOR UPDATE locking
  // Prevents race conditions and detects token reuse attacks
  const result = await atomicTokenRefresh(refreshTokenValue, hashToken, jwtTokenVersion);

  if (!result.success) {
    return Response.json({ error: result.error || 'Invalid refresh token.' }, { status: 401 });
  }

  const { userId, tokenVersion, role } = result;

  // Defense-in-depth: explicit guard for TypeScript safety
  if (!userId || tokenVersion === undefined) {
    loggers.auth.error('Atomic refresh returned success but missing userId/tokenVersion', { result });
    return Response.json({ error: 'Internal error during token refresh.' }, { status: 500 });
  }

  // Issue a new pair of tokens
  const newAccessToken = await generateAccessToken(userId, tokenVersion, role ?? 'user');
  const newRefreshToken = await generateRefreshToken(userId, tokenVersion, role ?? 'user');

  const refreshPayload = await decodeToken(newRefreshToken);
  const refreshExpiresAt = refreshPayload?.exp
    ? new Date(refreshPayload.exp * 1000)
    : new Date(Date.now() + getRefreshTokenMaxAge() * 1000);

  // Store the new refresh token with hash (P1-T3)
  // SECURITY: Only the hash is stored - plaintext token goes to cookie, never persisted
  const newRefreshTokenHash = hashToken(newRefreshToken);
  await db.insert(refreshTokens).values({
    id: createId(),
    token: newRefreshTokenHash, // Store hash, NOT plaintext
    tokenHash: newRefreshTokenHash,
    tokenPrefix: getTokenPrefix(newRefreshToken),
    userId,
    device: req.headers.get('user-agent'),
    userAgent: req.headers.get('user-agent'),
    ip: clientIP,
    lastUsedAt: new Date(),
    platform: 'web',
    expiresAt: refreshExpiresAt,
    // Link to device token if validated (enables device-based revocation)
    deviceTokenId: validatedDeviceTokenId,
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
  appendAuthCookies(headers, newAccessToken, newRefreshToken);
  headers.set('X-RateLimit-Limit', String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts));
  // After successful refresh and rate limit reset, remaining attempts are back to max
  headers.set('X-RateLimit-Remaining', String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts));

  return Response.json({ message: 'Token refreshed successfully' }, { status: 200, headers });
}
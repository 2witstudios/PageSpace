import { users, db, eq } from '@pagespace/db';
import { atomicDeviceTokenRotation } from '@pagespace/db/transactions/auth-transactions';
import {
  decodeToken,
  generateAccessToken,
  validateDeviceToken,
  updateDeviceTokenActivity,
  generateDeviceToken,
  generateCSRFToken,
  getSessionIdFromJWT,
} from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { hashToken, getTokenPrefix } from '@pagespace/lib/auth';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/server';
import { getClientIP } from '@/lib/auth';

const refreshSchema = z.object({
  deviceToken: z.string().min(1, { message: 'Device token is required' }),
  deviceId: z.string().min(1, { message: 'Device identifier is required' }),
  platform: z.enum(['ios', 'android', 'desktop']).default('ios'),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const validation = refreshSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { deviceToken, deviceId } = validation.data;

    const clientIP = getClientIP(req);

    // Distributed rate limiting by IP address for refresh attempts
    const distributedIpLimit = await checkDistributedRateLimit(
      `refresh:device:ip:${clientIP}`,
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

    // Validate device token
    const deviceRecord = await validateDeviceToken(deviceToken);
    if (!deviceRecord) {
      return Response.json({ error: 'Invalid or expired device token.' }, { status: 401 });
    }

    // Verify device ID match
    if (deviceRecord.deviceId !== deviceId) {
      loggers.auth.warn('Device token mismatch detected', {
        tokenDeviceId: deviceRecord.deviceId,
        providedDeviceId: deviceId,
        userId: deviceRecord.userId,
      });
      return Response.json({ error: 'Device token does not match this device.' }, { status: 401 });
    }

    // Fetch user
    const user = await db.query.users.findFirst({
      where: eq(users.id, deviceRecord.userId),
      columns: { id: true, tokenVersion: true, role: true }, // Only needed fields
    });

    if (!user) {
      return Response.json({ error: 'Invalid or expired device token.' }, { status: 401 });
    }

    // Rotate device token if within 7 days of expiration (reduced from 60 days)
    let activeDeviceToken = deviceToken;
    let activeDeviceTokenId = deviceRecord.id;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    if (deviceRecord.expiresAt && deviceRecord.expiresAt.getTime() - Date.now() < sevenDaysMs) {
      // SECURITY: Atomic device token rotation with FOR UPDATE locking
      // Prevents race conditions in concurrent rotation attempts
      const rotated = await atomicDeviceTokenRotation(
        deviceToken,
        {
          userAgent: req.headers.get('user-agent') ?? undefined,
          ipAddress: clientIP === 'unknown' ? undefined : clientIP,
        },
        hashToken,
        getTokenPrefix,
        generateDeviceToken
      );

      if (rotated.success && rotated.newToken) {
        activeDeviceToken = rotated.newToken;
        activeDeviceTokenId = rotated.deviceTokenId!;
      } else {
        // Rotation failed - continue with old token (resilient fallback)
        // This can happen if token was already rotated by concurrent request
        loggers.auth.warn('Mobile device token rotation failed, using original token', {
          userId: deviceRecord.userId,
          deviceId: deviceRecord.deviceId,
          error: rotated.error,
        });
      }
    }

    // Update device token activity
    const normalizedIP = clientIP === 'unknown' ? undefined : clientIP;
    await updateDeviceTokenActivity(activeDeviceTokenId, normalizedIP);

    // Generate new access token
    const accessToken = await generateAccessToken(user.id, user.tokenVersion, user.role);

    // Decode access token for CSRF generation (do this once, not three times)
    const decodedAccess = await decodeToken(accessToken);
    if (!decodedAccess?.iat) {
      loggers.auth.error('Failed to decode access token for CSRF generation');
      return Response.json({ error: 'Failed to generate session.' }, { status: 500 });
    }

    const sessionId = getSessionIdFromJWT({
      userId: user.id,
      tokenVersion: user.tokenVersion,
      iat: decodedAccess.iat,
    });
    const csrfToken = generateCSRFToken(sessionId);

    // Reset rate limit on successful refresh
    try {
      await resetDistributedRateLimit(`refresh:device:ip:${clientIP}`);
    } catch (error) {
      loggers.auth.warn('Rate limit reset failed after successful mobile refresh', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Return tokens (device-token-only pattern - no refreshToken)
    return Response.json({
      token: accessToken,
      csrfToken,
      deviceToken: activeDeviceToken,
    }, {
      status: 200,
      headers: {
        'X-RateLimit-Limit': String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts),
        'X-RateLimit-Remaining': String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts),
      },
    });

  } catch (error) {
    loggers.auth.error('Mobile token refresh error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}

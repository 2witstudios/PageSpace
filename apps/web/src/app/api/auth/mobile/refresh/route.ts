import { users } from '@pagespace/db';
import { db, eq } from '@pagespace/db';
import {
  decodeToken,
  generateAccessToken,
  validateDeviceToken,
  rotateDeviceToken,
  updateDeviceTokenActivity,
  generateCSRFToken,
  getSessionIdFromJWT,
} from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/server';

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

    const clientIP =
      req.headers.get('x-forwarded-for')?.split(',')[0] ||
      req.headers.get('x-real-ip') ||
      'unknown';

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
      const rotated = await rotateDeviceToken(
        deviceToken,
        {
          userAgent: req.headers.get('user-agent') ?? undefined,
          ipAddress: clientIP === 'unknown' ? undefined : clientIP,
        },
        user.tokenVersion,
      );

      if (rotated) {
        activeDeviceToken = rotated.token;
        activeDeviceTokenId = rotated.deviceToken.id;
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
    await resetDistributedRateLimit(`refresh:device:ip:${clientIP}`);

    // Return tokens (device-token-only pattern - no refreshToken)
    return Response.json({
      token: accessToken,
      csrfToken,
      deviceToken: activeDeviceToken,
    }, { status: 200 });

  } catch (error) {
    loggers.auth.error('Mobile token refresh error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}

import { z } from 'zod/v4';
import { users, refreshTokens, deviceTokens, atomicDeviceTokenRotation } from '@pagespace/db';
import { db, eq } from '@pagespace/db';
import {
  validateDeviceToken,
  updateDeviceTokenActivity,
  generateAccessToken,
  generateRefreshToken,
  generateDeviceToken,
  decodeToken,
  getRefreshTokenMaxAge,
  generateCSRFToken,
  getSessionIdFromJWT,
} from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { createId } from '@paralleldrive/cuid2';
import { hashToken, getTokenPrefix } from '@pagespace/lib/auth';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { getClientIP, appendAuthCookies } from '@/lib/auth';

const deviceRefreshSchema = z.object({
  deviceToken: z.string().min(1, { message: 'Device token is required' }),
  deviceId: z.string().min(1, { message: 'Device identifier is required' }),
  userAgent: z.string().optional(),
  appVersion: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const validation = deviceRefreshSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { deviceToken, deviceId, userAgent, appVersion } = validation.data;

    const clientIP = getClientIP(req);

    // Distributed rate limiting by IP address for device refresh attempts
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

    const deviceRecord = await validateDeviceToken(deviceToken);
    if (!deviceRecord) {
      return Response.json({ error: 'Invalid or expired device token.' }, { status: 401 });
    }

    if (deviceRecord.deviceId !== deviceId) {
      // Check if this is a legacy device from OAuth with 'unknown' deviceId
      // Allow one-time correction if the device token is otherwise valid
      if (deviceRecord.deviceId === 'unknown' || !deviceRecord.deviceId) {
        loggers.auth.warn('Correcting device token deviceId from OAuth migration', {
          deviceTokenId: deviceRecord.id,
          oldDeviceId: deviceRecord.deviceId,
          newDeviceId: deviceId,
          userId: deviceRecord.userId,
        });

        // Update device record with correct deviceId (one-time migration)
        try {
          const [updatedDevice] = await db
            .update(deviceTokens)
            .set({
              deviceId: deviceId,
            })
            .where(eq(deviceTokens.id, deviceRecord.id))
            .returning();

          if (!updatedDevice) {
            loggers.auth.error('Failed to update device token deviceId', {
              deviceTokenId: deviceRecord.id,
            });
            return Response.json({ error: 'Failed to update device.' }, { status: 500 });
          }

          // Update local deviceRecord for continued processing
          deviceRecord.deviceId = deviceId;
        } catch (error) {
          loggers.auth.error('Error correcting device token deviceId', { error: error as Error });
          return Response.json({ error: 'Failed to update device.' }, { status: 500 });
        }

        // Continue with refresh using corrected device
      } else {
        // Strict mismatch - different device attempting to use this token
        loggers.auth.warn('Device token mismatch detected - possible stolen token', {
          tokenDeviceId: deviceRecord.deviceId,
          providedDeviceId: deviceId,
          userId: deviceRecord.userId,
        });
        return Response.json({ error: 'Device token does not match this device.' }, { status: 401 });
      }
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, deviceRecord.userId),
    });

    if (!user) {
      return Response.json({ error: 'User not found for device token.' }, { status: 404 });
    }

    // Rotate device token if it is within 60 days of expiration
    // Increased from 30 to 60 days to ensure proactive rotation with overlap
    let activeDeviceToken = deviceToken;
    let activeDeviceTokenId = deviceRecord.id;
    const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;

    if (deviceRecord.expiresAt && deviceRecord.expiresAt.getTime() - Date.now() < sixtyDaysMs) {
      // SECURITY: Atomic device token rotation with FOR UPDATE locking
      // Prevents race conditions in concurrent rotation attempts
      const rotated = await atomicDeviceTokenRotation(
        deviceToken,
        {
          userAgent: userAgent ?? req.headers.get('user-agent') ?? undefined,
          ipAddress: clientIP === 'unknown' ? undefined : clientIP,
        },
        hashToken,
        getTokenPrefix,
        generateDeviceToken
      );

      if (rotated.success && rotated.newToken) {
        activeDeviceToken = rotated.newToken;
        activeDeviceTokenId = rotated.deviceTokenId!;
      }
    }

    const normalizedIP = clientIP === 'unknown' ? undefined : clientIP;

    await updateDeviceTokenActivity(activeDeviceTokenId, normalizedIP);

    const accessToken = await generateAccessToken(user.id, user.tokenVersion, user.role);
    const refreshToken = await generateRefreshToken(user.id, user.tokenVersion, user.role);

    const refreshPayload = await decodeToken(refreshToken);
    const refreshExpiresAt = refreshPayload?.exp
      ? new Date(refreshPayload.exp * 1000)
      : new Date(Date.now() + getRefreshTokenMaxAge() * 1000);

    // SECURITY: Only hash stored, never plaintext
    const refreshTokenHash = hashToken(refreshToken);
    await db.insert(refreshTokens).values({
      id: createId(),
      token: refreshTokenHash, // Store hash, NOT plaintext
      tokenHash: refreshTokenHash,
      tokenPrefix: getTokenPrefix(refreshToken),
      userId: user.id,
      device: userAgent ?? deviceRecord.deviceName,
      userAgent: userAgent ?? deviceRecord.userAgent,
      ip: normalizedIP ?? null,
      lastUsedAt: new Date(),
      platform: deviceRecord.platform,
      deviceTokenId: activeDeviceTokenId,
      expiresAt: refreshExpiresAt,
    });

    const decodedAccess = await decodeToken(accessToken);
    if (!decodedAccess?.iat) {
      loggers.auth.error('Failed to decode access token for CSRF generation during device refresh');
      return Response.json({ error: 'Failed to generate session.' }, { status: 500 });
    }

    const sessionId = getSessionIdFromJWT({
      userId: user.id,
      tokenVersion: user.tokenVersion,
      iat: decodedAccess.iat,
    });
    const csrfToken = generateCSRFToken(sessionId);

    logAuthEvent('login', user.id, user.email, normalizedIP ?? 'unknown', 'Device token refresh');
    trackAuthEvent(user.id, 'refresh', {
      platform: deviceRecord.platform,
      ip: normalizedIP ?? 'unknown',
      userAgent: userAgent ?? req.headers.get('user-agent'),
      appVersion,
    });

    // Reset rate limit on successful refresh
    try {
      await resetDistributedRateLimit(`refresh:device:ip:${clientIP}`);
    } catch (error) {
      loggers.auth.warn('Rate limit reset failed after successful device refresh', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // For web platform, set httpOnly cookies instead of returning tokens in JSON
    // Detect web by platform === 'web' in device record
    const isWebPlatform = deviceRecord.platform === 'web';

    if (isWebPlatform) {
      const headers = new Headers();
      appendAuthCookies(headers, accessToken, refreshToken);
      headers.set('X-RateLimit-Limit', String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts));
      headers.set('X-RateLimit-Remaining', String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts));

      return Response.json(
        {
          message: 'Session refreshed successfully',
          csrfToken,
          deviceToken: activeDeviceToken,
        },
        { status: 200, headers }
      );
    }

    // For mobile/desktop, return tokens in JSON (existing behavior)
    return Response.json({
      token: accessToken,
      refreshToken,
      csrfToken,
      deviceToken: activeDeviceToken,
    }, {
      headers: {
        'X-RateLimit-Limit': String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts),
        'X-RateLimit-Remaining': String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts),
      },
    });
  } catch (error) {
    loggers.auth.error('Device token refresh error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}

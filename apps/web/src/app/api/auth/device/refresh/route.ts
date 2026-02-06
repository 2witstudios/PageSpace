import { z } from 'zod/v4';
import { users, deviceTokens, db, eq } from '@pagespace/db';
import { atomicDeviceTokenRotation } from '@pagespace/db/transactions/auth-transactions';
import {
  validateDeviceToken,
  updateDeviceTokenActivity,
  generateDeviceToken,
  generateCSRFToken,
} from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { hashToken, getTokenPrefix, sessionService } from '@pagespace/lib/auth';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { getClientIP, appendSessionCookie } from '@/lib/auth';

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

      if (!rotated.success) {
        // SECURITY: Rotation failed - do not continue with potentially revoked token
        // Token may have been revoked, expired, or already rotated by concurrent request
        loggers.auth.warn('Device token rotation failed - aborting refresh', {
          userId: deviceRecord.userId,
          deviceId: deviceRecord.deviceId,
          error: rotated.error,
        });
        return Response.json(
          { error: rotated.error ?? 'Device token rotation failed. Please re-authenticate.' },
          { status: 401 }
        );
      }

      if (rotated.newToken && rotated.deviceTokenId) {
        activeDeviceToken = rotated.newToken;
        activeDeviceTokenId = rotated.deviceTokenId;
      }
    }

    const normalizedIP = clientIP === 'unknown' ? undefined : clientIP;

    await updateDeviceTokenActivity(activeDeviceTokenId, normalizedIP);

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

    // Web platform: Create session and set cookie (no JWT tokens in response)
    if (deviceRecord.platform === 'web') {
      const sessionToken = await sessionService.createSession({
        userId: user.id,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 7 * 24 * 60 * 60 * 1000, // 7 days
        createdByService: 'device-refresh',
        createdByIp: normalizedIP,
      });

      const sessionClaims = await sessionService.validateSession(sessionToken);
      if (!sessionClaims) {
        loggers.auth.error('Failed to validate newly created session during web device refresh');
        return Response.json({ error: 'Failed to generate session.' }, { status: 500 });
      }
      const csrfToken = generateCSRFToken(sessionClaims.sessionId);

      const headers = new Headers();
      appendSessionCookie(headers, sessionToken);
      headers.set('X-RateLimit-Limit', String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts));
      headers.set('X-RateLimit-Remaining', String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts));

      return Response.json({
        csrfToken,
        deviceToken: activeDeviceToken,
        // No accessToken/refreshToken for web - session cookie is set
      }, { headers });
    }

    // Mobile/desktop: Return session token in JSON (no refresh token - devices use device tokens)
    const sessionToken = await sessionService.createSession({
      userId: user.id,
      type: 'user',
      scopes: ['*'],
      expiresInMs: 90 * 24 * 60 * 60 * 1000, // 90 days for mobile/desktop
      createdByService: 'device-refresh',
      createdByIp: normalizedIP,
    });

    const sessionClaims = await sessionService.validateSession(sessionToken);
    if (!sessionClaims) {
      loggers.auth.error('Failed to validate newly created session during device refresh');
      return Response.json({ error: 'Failed to generate session.' }, { status: 500 });
    }

    const csrfToken = generateCSRFToken(sessionClaims.sessionId);

    const headers = new Headers();
    headers.set('X-RateLimit-Limit', String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts));
    headers.set('X-RateLimit-Remaining', String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts));

    // Desktop needs a session cookie so Next.js middleware allows page route requests.
    // Desktop primarily uses Bearer tokens for API calls, but middleware checks cookies.
    if (deviceRecord.platform === 'desktop') {
      appendSessionCookie(headers, sessionToken);
    }

    return Response.json({
      sessionToken,
      csrfToken,
      deviceToken: activeDeviceToken,
    }, { headers });
  } catch (error) {
    loggers.auth.error('Device token refresh error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}

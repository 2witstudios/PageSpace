import { users, db, eq } from '@pagespace/db';
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
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/server';
import { getClientIP, appendSessionCookie } from '@/lib/auth';

const refreshSchema = z.object({
  deviceToken: z.string().min(1, 'Device token is required'),
  deviceId: z.string().min(1, 'Device identifier is required'),
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

      if (!rotated.success) {
        // SECURITY: Rotation failed - do not continue with potentially revoked token
        // Token may have been revoked, expired, or already rotated by concurrent request
        loggers.auth.warn('Mobile device token rotation failed - aborting refresh', {
          userId: deviceRecord.userId,
          deviceId: deviceRecord.deviceId,
          error: rotated.error,
        });
        return Response.json(
          { error: rotated.error ?? 'Device token rotation failed. Please re-authenticate.' },
          { status: 401 }
        );
      }

      if (rotated.gracePeriodRetry && rotated.deviceTokenId) {
        // Grace period retry - use replacement token ID for activity tracking
        // Client should already have the new token from the first successful request
        activeDeviceTokenId = rotated.deviceTokenId;
        // Keep activeDeviceToken as original - return same token to client
      } else if (rotated.newToken && rotated.deviceTokenId) {
        activeDeviceToken = rotated.newToken;
        activeDeviceTokenId = rotated.deviceTokenId;
      }
    }

    // Update device token activity
    const normalizedIP = clientIP === 'unknown' ? undefined : clientIP;
    await updateDeviceTokenActivity(activeDeviceTokenId, normalizedIP);

    // Create new session token (opaque, stored in DB)
    const sessionToken = await sessionService.createSession({
      userId: user.id,
      type: 'user',
      scopes: ['*'],
      expiresInMs: 90 * 24 * 60 * 60 * 1000, // 90 days for mobile
      createdByService: 'mobile-refresh',
      createdByIp: normalizedIP,
    });

    // Get session claims for CSRF generation
    const sessionClaims = await sessionService.validateSession(sessionToken);
    if (!sessionClaims) {
      loggers.auth.error('Failed to validate newly created session');
      return Response.json({ error: 'Failed to generate session.' }, { status: 500 });
    }

    const csrfToken = generateCSRFToken(sessionClaims.sessionId);

    // Reset rate limit on successful refresh
    try {
      await resetDistributedRateLimit(`refresh:device:ip:${clientIP}`);
    } catch (error) {
      loggers.auth.warn('Rate limit reset failed after successful mobile refresh', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Return session token (device-token-only pattern - no refreshToken)
    const headers = new Headers();
    headers.set('X-RateLimit-Limit', String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts));
    headers.set('X-RateLimit-Remaining', String(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts));
    appendSessionCookie(headers, sessionToken);

    return Response.json({
      sessionToken,
      csrfToken,
      deviceToken: activeDeviceToken,
    }, { status: 200, headers });

  } catch (error) {
    loggers.auth.error('Mobile token refresh error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}

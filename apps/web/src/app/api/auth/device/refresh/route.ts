import { z } from 'zod/v4';
import { users, refreshTokens } from '@pagespace/db';
import { db, eq } from '@pagespace/db';
import {
  validateDeviceToken,
  rotateDeviceToken,
  updateDeviceTokenActivity,
  generateAccessToken,
  generateRefreshToken,
  decodeToken,
  getRefreshTokenMaxAge,
  generateCSRFToken,
  getSessionIdFromJWT,
} from '@pagespace/lib/server';
import { createId } from '@paralleldrive/cuid2';
import { loggers, logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

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

    const clientIP =
      req.headers.get('x-forwarded-for')?.split(',')[0] ||
      req.headers.get('x-real-ip') ||
      'unknown';

    const deviceRecord = await validateDeviceToken(deviceToken);
    if (!deviceRecord) {
      return Response.json({ error: 'Invalid or expired device token.' }, { status: 401 });
    }

    if (deviceRecord.deviceId !== deviceId) {
      loggers.auth.warn('Device token mismatch detected', {
        tokenDeviceId: deviceRecord.deviceId,
        providedDeviceId: deviceId,
      });
      return Response.json({ error: 'Device token does not match this device.' }, { status: 401 });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, deviceRecord.userId),
    });

    if (!user) {
      return Response.json({ error: 'User not found for device token.' }, { status: 404 });
    }

    // Rotate device token if it is within 30 days of expiration
    let activeDeviceToken = deviceToken;
    let activeDeviceTokenId = deviceRecord.id;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    if (deviceRecord.expiresAt && deviceRecord.expiresAt.getTime() - Date.now() < thirtyDaysMs) {
      const rotated = await rotateDeviceToken(
        deviceToken,
        {
          userAgent: userAgent ?? req.headers.get('user-agent') ?? undefined,
          ipAddress: clientIP === 'unknown' ? undefined : clientIP,
        },
        user.tokenVersion,
      );

      if (rotated) {
        activeDeviceToken = rotated.token;
        activeDeviceTokenId = rotated.deviceToken.id;
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

    await db.insert(refreshTokens).values({
      id: createId(),
      token: refreshToken,
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

    return Response.json({
      token: accessToken,
      refreshToken,
      csrfToken,
      deviceToken: activeDeviceToken,
    });
  } catch (error) {
    loggers.auth.error('Device token refresh error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}

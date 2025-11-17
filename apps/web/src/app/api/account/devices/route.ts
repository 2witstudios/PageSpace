import { users, db, eq, deviceTokens, sql, and, isNull } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getUserDeviceTokens, revokeAllUserDeviceTokens, decodeDeviceToken, createDeviceTokenRecord } from '@pagespace/lib/device-auth-utils';
import bcrypt from 'bcryptjs';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

interface DeviceResponse {
  id: string;
  platform: 'web' | 'desktop' | 'ios' | 'android';
  deviceName: string | null;
  deviceId: string;
  lastUsedAt: string;
  trustScore: number;
  suspiciousActivityCount: number;
  ipAddress: string | null;
  lastIpAddress: string | null;
  location: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Get all active device tokens for the user
    const devices = await getUserDeviceTokens(userId);

    // Determine current device from request headers
    const currentDeviceToken = req.headers.get('x-device-token');

    // Format response with isCurrent flag
    const response: DeviceResponse[] = devices.map((device) => ({
      id: device.id,
      platform: device.platform,
      deviceName: device.deviceName,
      deviceId: device.deviceId,
      lastUsedAt: (device.lastUsedAt || device.createdAt).toISOString(),
      trustScore: device.trustScore,
      suspiciousActivityCount: device.suspiciousActivityCount,
      ipAddress: device.ipAddress,
      lastIpAddress: device.lastIpAddress,
      location: device.location,
      userAgent: device.userAgent,
      createdAt: device.createdAt.toISOString(),
      expiresAt: device.expiresAt.toISOString(),
      isCurrent: device.token === currentDeviceToken,
    }));

    return Response.json(response);
  } catch (error) {
    loggers.auth.error('Failed to fetch devices:', error as Error);
    return Response.json({ error: 'Failed to fetch devices' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const body = await req.json();
    const { password } = body;

    // Validate password is provided
    if (!password) {
      return Response.json({ error: 'Password is required' }, { status: 400 });
    }

    // Get user to verify password
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        password: true,
        tokenVersion: true,
      },
    });

    if (!user) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    if (!user.password) {
      return Response.json({ error: 'No password set for this account' }, { status: 400 });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return Response.json({ error: 'Invalid password' }, { status: 401 });
    }

    // Get current device token to preserve it
    const currentDeviceToken = req.headers.get('x-device-token');

    // Extract device info from current token BEFORE incrementing tokenVersion
    // This is critical: we need to decode the token while it's still valid
    let currentDeviceInfo: { deviceId: string; platform: 'web' | 'desktop' | 'ios' | 'android'; deviceName: string | null } | null = null;
    if (currentDeviceToken) {
      const payload = await decodeDeviceToken(currentDeviceToken);
      if (payload) {
        // Get device metadata from database
        const oldDeviceRecord = await db.query.deviceTokens.findFirst({
          where: eq(deviceTokens.token, currentDeviceToken),
          columns: { deviceId: true, platform: true, deviceName: true },
        });
        if (oldDeviceRecord) {
          currentDeviceInfo = {
            deviceId: oldDeviceRecord.deviceId,
            platform: oldDeviceRecord.platform,
            deviceName: oldDeviceRecord.deviceName,
          };
        }
      }
    }

    // Get the new tokenVersion value
    const newTokenVersion = user.tokenVersion + 1;

    // Bump tokenVersion to invalidate all access/refresh tokens
    await db
      .update(users)
      .set({
        tokenVersion: newTokenVersion,
      })
      .where(eq(users.id, userId));

    // Create new device token with incremented tokenVersion (if current device was valid)
    let newDeviceToken: string | undefined;
    if (currentDeviceInfo) {
      // Revoke the old device token
      await db
        .update(deviceTokens)
        .set({
          revokedAt: new Date(),
          revokedReason: 'user_action',
        })
        .where(eq(deviceTokens.token, currentDeviceToken!));

      // Create new token with the incremented tokenVersion
      const newTokenData = await createDeviceTokenRecord(
        userId,
        currentDeviceInfo.deviceId,
        currentDeviceInfo.platform,
        newTokenVersion,
        {
          deviceName: currentDeviceInfo.deviceName || undefined,
          userAgent: req.headers.get('user-agent') ?? undefined,
          ipAddress: req.headers.get('x-forwarded-for')?.split(',')[0] || req.headers.get('x-real-ip') || undefined,
        }
      );

      newDeviceToken = newTokenData.token;
      loggers.auth.info(`Created new device token for user ${userId} with new tokenVersion ${newTokenVersion}`);
    }

    // Revoke all device tokens except the current one (which was already rotated)
    if (currentDeviceToken) {
      // Revoke all except current (old token already revoked by rotation)
      await db
        .update(deviceTokens)
        .set({
          revokedAt: new Date(),
          revokedReason: 'user_action',
        })
        .where(
          and(
            eq(deviceTokens.userId, userId),
            isNull(deviceTokens.revokedAt),
            sql`${deviceTokens.token} != ${currentDeviceToken}`,
            // Also exclude the new rotated token
            ...(newDeviceToken ? [sql`${deviceTokens.token} != ${newDeviceToken}`] : [])
          )
        );
    } else {
      // No current device token, revoke all
      await revokeAllUserDeviceTokens(userId, 'user_action');
    }

    loggers.auth.info(`User ${userId} revoked all other devices`);

    return Response.json({
      message: 'All other devices have been logged out',
      ...(newDeviceToken && { deviceToken: newDeviceToken }),
    });
  } catch (error) {
    loggers.auth.error('Failed to revoke all devices:', error as Error);
    return Response.json({ error: 'Failed to revoke devices' }, { status: 500 });
  }
}

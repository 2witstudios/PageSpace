import { users, db, eq, deviceTokens, sql, and, isNull } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { hashToken } from '@pagespace/lib/auth';
import { secureCompare } from '@pagespace/lib/secure-compare';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getUserDeviceTokens, revokeAllUserDeviceTokens, createDeviceTokenRecord, revokeExpiredDeviceTokens } from '@pagespace/lib/device-auth-utils';
import { isValidTokenFormat, getTokenType } from '@pagespace/lib/auth';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

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
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Get all active device tokens for the user
    const devices = await getUserDeviceTokens(userId);

    // Determine current device from request headers
    // Hash the token for comparison against stored tokenHash
    const currentDeviceToken = req.headers.get('x-device-token');
    const currentDeviceTokenHash = currentDeviceToken ? hashToken(currentDeviceToken) : null;

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
      // Compare hash to hash (device.tokenHash stores the hash, currentDeviceTokenHash is hashed request token)
      isCurrent: currentDeviceTokenHash && device.tokenHash ? secureCompare(device.tokenHash, currentDeviceTokenHash) : false,
    }));

    return Response.json(response);
  } catch (error) {
    loggers.auth.error('Failed to fetch devices:', error as Error);
    return Response.json({ error: 'Failed to fetch devices' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Get user to retrieve tokenVersion
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        tokenVersion: true,
      },
    });

    if (!user) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    // Get current device token to preserve it
    // Hash the token for database lookups
    const currentDeviceToken = req.headers.get('x-device-token');
    const currentDeviceTokenHash = currentDeviceToken ? hashToken(currentDeviceToken) : null;

    // Extract device info from current token BEFORE incrementing tokenVersion
    // With opaque tokens, we look up the device record by tokenHash (not JWT decode)
    let currentDeviceInfo: { deviceId: string; platform: 'web' | 'desktop' | 'ios' | 'android'; deviceName: string | null } | null = null;
    if (currentDeviceToken && currentDeviceTokenHash) {
      // Validate opaque token format
      if (isValidTokenFormat(currentDeviceToken) && getTokenType(currentDeviceToken) === 'dev') {
        // Get device metadata from database using tokenHash
        const oldDeviceRecord = await db.query.deviceTokens.findFirst({
          where: eq(deviceTokens.tokenHash, currentDeviceTokenHash),
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
    let newDeviceTokenHash: string | undefined;
    if (currentDeviceInfo) {
      // Revoke the old device token using tokenHash for lookup
      await db
        .update(deviceTokens)
        .set({
          revokedAt: new Date(),
          revokedReason: 'user_action',
        })
        .where(eq(deviceTokens.tokenHash, currentDeviceTokenHash!));

      // Revoke any expired tokens that would block creation
      await revokeExpiredDeviceTokens(userId, currentDeviceInfo.deviceId, currentDeviceInfo.platform);

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
      newDeviceTokenHash = hashToken(newDeviceToken);
      loggers.auth.info(`Created new device token for user ${userId} with new tokenVersion ${newTokenVersion}`);
    }

    // Revoke all device tokens except the current one (which was already rotated)
    if (currentDeviceTokenHash) {
      // Revoke all except current (old token already revoked by rotation)
      // Use tokenHash for comparisons since that's what's stored in DB
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
            sql`${deviceTokens.tokenHash} != ${currentDeviceTokenHash}`,
            // Also exclude the new rotated token
            ...(newDeviceTokenHash ? [sql`${deviceTokens.tokenHash} != ${newDeviceTokenHash}`] : [])
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

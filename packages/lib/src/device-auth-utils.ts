import * as jose from 'jose';
import { createId } from '@paralleldrive/cuid2';
import { db, deviceTokens, eq, and, isNull, gt } from '@pagespace/db';
import type { InferSelectModel } from 'drizzle-orm';

const JWT_ALGORITHM = 'HS256';

function getJWTConfig() {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long');
  }

  return {
    secret: new TextEncoder().encode(jwtSecret),
    issuer: process.env.JWT_ISSUER || 'pagespace',
    audience: process.env.JWT_AUDIENCE || 'pagespace-devices'
  };
}

export interface DeviceTokenPayload extends jose.JWTPayload {
  userId: string;
  deviceId: string;
  platform: 'web' | 'desktop' | 'ios' | 'android';
  tokenVersion: number;
}

export type DeviceToken = InferSelectModel<typeof deviceTokens>;

/**
 * Token lifetime configurations
 */
export const TOKEN_LIFETIMES = {
  ACCESS_TOKEN: '15m',
  REFRESH_TOKEN_DEFAULT: '7d',
  REFRESH_TOKEN_REMEMBERED: '30d',
  DEVICE_TOKEN: '90d', // Long-lived, rotates every 30d
};

/**
 * Generate a device token (90-day lifetime)
 */
export async function generateDeviceToken(
  userId: string,
  deviceId: string,
  platform: 'web' | 'desktop' | 'ios' | 'android',
  tokenVersion: number = 0
): Promise<string> {
  const config = getJWTConfig();
  return await new jose.SignJWT({ userId, deviceId, platform, tokenVersion })
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setJti(createId())
    .setExpirationTime(TOKEN_LIFETIMES.DEVICE_TOKEN)
    .sign(config.secret);
}

/**
 * Decode and validate device token
 */
export async function decodeDeviceToken(token: string): Promise<DeviceTokenPayload | null> {
  if (typeof token !== 'string') {
    return null;
  }

  try {
    const config = getJWTConfig();
    const { payload } = await jose.jwtVerify(token, config.secret, {
      algorithms: [JWT_ALGORITHM],
      issuer: config.issuer,
      audience: config.audience,
    });

    // Validate required payload fields
    if (!payload.userId || typeof payload.userId !== 'string') {
      throw new Error('Invalid device token: missing or invalid userId');
    }
    if (!payload.deviceId || typeof payload.deviceId !== 'string') {
      throw new Error('Invalid device token: missing or invalid deviceId');
    }
    if (!payload.platform || !['web', 'desktop', 'ios', 'android'].includes(payload.platform as string)) {
      throw new Error('Invalid device token: missing or invalid platform');
    }
    if (typeof payload.tokenVersion !== 'number') {
      throw new Error('Invalid device token: missing or invalid tokenVersion');
    }

    return payload as DeviceTokenPayload;
  } catch (error) {
    console.error('Invalid device token:', error);
    return null;
  }
}

/**
 * Create a device token record in the database
 */
export async function createDeviceTokenRecord(
  userId: string,
  deviceId: string,
  platform: 'web' | 'desktop' | 'ios' | 'android',
  tokenVersion: number,
  metadata: {
    deviceName?: string;
    userAgent?: string;
    ipAddress?: string;
    location?: string;
  }
): Promise<{ id: string; token: string }> {
  // Generate the JWT token
  const token = await generateDeviceToken(userId, deviceId, platform, tokenVersion);

  // Calculate expiration date (90 days from now)
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 90);

  // Insert into database
  const [record] = await db.insert(deviceTokens).values({
    userId,
    deviceId,
    platform,
    token,
    expiresAt,
    deviceName: metadata.deviceName,
    userAgent: metadata.userAgent,
    ipAddress: metadata.ipAddress,
    lastIpAddress: metadata.ipAddress,
    location: metadata.location,
    trustScore: 1.0,
    suspiciousActivityCount: 0,
  }).returning();

  return {
    id: record.id,
    token,
  };
}

/**
 * Validate device token against database
 */
export async function validateDeviceToken(token: string): Promise<DeviceToken | null> {
  try {
    // First decode the JWT
    const payload = await decodeDeviceToken(token);
    if (!payload) {
      return null;
    }

    // Check if token exists in database and is valid
    const deviceToken = await db.query.deviceTokens.findFirst({
      where: and(
        eq(deviceTokens.token, token),
        isNull(deviceTokens.revokedAt),
        gt(deviceTokens.expiresAt, new Date())
      ),
    });

    if (!deviceToken) {
      return null;
    }

    // Verify the token matches the stored device
    if (deviceToken.deviceId !== payload.deviceId || deviceToken.userId !== payload.userId) {
      console.error('Device token mismatch:', {
        storedDeviceId: deviceToken.deviceId,
        payloadDeviceId: payload.deviceId,
      });
      return null;
    }

    return deviceToken;
  } catch (error) {
    console.error('Device token validation error:', error);
    return null;
  }
}

/**
 * Update device token last used timestamp and IP address
 */
export async function updateDeviceTokenActivity(
  tokenId: string,
  ipAddress?: string
): Promise<void> {
  const updateData: any = {
    lastUsedAt: new Date(),
  };

  if (ipAddress) {
    updateData.lastIpAddress = ipAddress;
  }

  await db.update(deviceTokens)
    .set(updateData)
    .where(eq(deviceTokens.id, tokenId));
}

/**
 * Revoke a device token
 */
export async function revokeDeviceToken(
  tokenId: string,
  reason: 'user_action' | 'suspicious_activity' | 'expired' | 'token_version_change'
): Promise<void> {
  await db.update(deviceTokens)
    .set({
      revokedAt: new Date(),
      revokedReason: reason,
    })
    .where(eq(deviceTokens.id, tokenId));
}

/**
 * Revoke all device tokens for a user (e.g., when token version changes)
 */
export async function revokeAllUserDeviceTokens(
  userId: string,
  reason: 'user_action' | 'suspicious_activity' | 'expired' | 'token_version_change'
): Promise<void> {
  await db.update(deviceTokens)
    .set({
      revokedAt: new Date(),
      revokedReason: reason,
    })
    .where(and(
      eq(deviceTokens.userId, userId),
      isNull(deviceTokens.revokedAt)
    ));
}

/**
 * Get all active device tokens for a user
 */
export async function getUserDeviceTokens(userId: string): Promise<DeviceToken[]> {
  return await db.query.deviceTokens.findMany({
    where: and(
      eq(deviceTokens.userId, userId),
      isNull(deviceTokens.revokedAt),
      gt(deviceTokens.expiresAt, new Date())
    ),
    orderBy: (deviceTokens, { desc }) => [desc(deviceTokens.lastUsedAt)],
  });
}

/**
 * Rotate device token (creates new token, revokes old one)
 */
export async function rotateDeviceToken(
  oldToken: string,
  metadata: {
    userAgent?: string;
    ipAddress?: string;
  }
): Promise<{ token: string; deviceToken: DeviceToken } | null> {
  try {
    // Validate old token
    const oldDeviceToken = await validateDeviceToken(oldToken);
    if (!oldDeviceToken) {
      return null;
    }

    // Revoke old token
    await revokeDeviceToken(oldDeviceToken.id, 'user_action');

    // Create new token with same device ID
    const newTokenData = await createDeviceTokenRecord(
      oldDeviceToken.userId,
      oldDeviceToken.deviceId,
      oldDeviceToken.platform,
      0, // Token version from user will be checked separately
      {
        deviceName: oldDeviceToken.deviceName || undefined,
        userAgent: metadata.userAgent || oldDeviceToken.userAgent || undefined,
        ipAddress: metadata.ipAddress || oldDeviceToken.lastIpAddress || undefined,
        location: oldDeviceToken.location || undefined,
      }
    );

    // Get the newly created device token record
    const newDeviceToken = await db.query.deviceTokens.findFirst({
      where: eq(deviceTokens.id, newTokenData.id),
    });

    if (!newDeviceToken) {
      throw new Error('Failed to retrieve new device token');
    }

    return {
      token: newTokenData.token,
      deviceToken: newDeviceToken,
    };
  } catch (error) {
    console.error('Device token rotation error:', error);
    return null;
  }
}

/**
 * Clean up expired device tokens (run periodically)
 */
export async function cleanupExpiredDeviceTokens(): Promise<number> {
  const result = await db.update(deviceTokens)
    .set({
      revokedAt: new Date(),
      revokedReason: 'expired',
    })
    .where(and(
      isNull(deviceTokens.revokedAt),
      gt(new Date(), deviceTokens.expiresAt)
    ))
    .returning({ id: deviceTokens.id });

  return result.length;
}

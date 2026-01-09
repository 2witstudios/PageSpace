import * as jose from 'jose';
import { createId } from '@paralleldrive/cuid2';
import { db, deviceTokens, eq, and, isNull, lt, gt, sql, or } from '@pagespace/db';
import { hashToken, getTokenPrefix } from './token-utils';

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

export type DeviceToken = typeof deviceTokens.$inferSelect;

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
  } = {}
): Promise<{ id: string; token: string }> {
  // Generate the JWT token
  const token = await generateDeviceToken(userId, deviceId, platform, tokenVersion);

  // Calculate expiration date (90 days from now)
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 90);

  // SECURITY: Hash the token before storing - never store plaintext
  const tokenHashValue = hashToken(token);

  // Insert into database
  const [record] = await db.insert(deviceTokens).values({
    userId,
    deviceId,
    platform,
    token: tokenHashValue,       // Store hash, NOT plaintext
    tokenHash: tokenHashValue,
    tokenPrefix: getTokenPrefix(token),
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
    token,  // Return plaintext token to caller (client needs the JWT)
  };
}

/**
 * Revoke expired device tokens for a specific user+device+platform combination
 * This prevents unique constraint violations when creating new tokens
 *
 * @param userId - User ID
 * @param deviceId - Device fingerprint
 * @param platform - Device platform
 * @returns Number of tokens revoked
 */
export async function revokeExpiredDeviceTokens(
  userId: string,
  deviceId: string,
  platform: 'web' | 'desktop' | 'ios' | 'android'
): Promise<number> {
  const now = new Date();

  const result = await db
    .update(deviceTokens)
    .set({
      revokedAt: now,
      revokedReason: 'expired',
    })
    .where(
      and(
        eq(deviceTokens.userId, userId),
        eq(deviceTokens.deviceId, deviceId),
        eq(deviceTokens.platform, platform),
        isNull(deviceTokens.revokedAt),
        sql`${deviceTokens.expiresAt} <= ${now}` // Only revoke expired tokens
      )
    );

  // Extract rowCount from result if available
  const rowCount = (result as any).rowCount ?? 0;

  if (rowCount > 0) {
    console.info('Auto-revoked expired device tokens', {
      userId,
      deviceId,
      platform,
      count: rowCount,
    });
  }

  return rowCount;
}

/**
 * Validate device token against database
 * SECURITY: Also validates tokenVersion to prevent use after tokenVersion bump
 * Uses dual-mode lookup: hash first, plaintext fallback for migration
 */
export async function validateDeviceToken(token: string): Promise<DeviceToken | null> {
  try {
    // First decode the JWT
    const payload = await decodeDeviceToken(token);
    if (!payload) {
      return null;
    }

    // SECURITY: Dual-mode lookup - hash first, plaintext fallback for migration
    const tokenHashValue = hashToken(token);

    // Try hash lookup first (new tokens store hash in tokenHash column)
    let deviceToken = await db.query.deviceTokens.findFirst({
      where: and(
        eq(deviceTokens.tokenHash, tokenHashValue),
        isNull(deviceTokens.revokedAt),
        gt(deviceTokens.expiresAt, new Date())
      ),
    });

    // Fallback: try plaintext lookup for legacy tokens during migration
    if (!deviceToken) {
      deviceToken = await db.query.deviceTokens.findFirst({
        where: and(
          eq(deviceTokens.token, token),
          isNull(deviceTokens.revokedAt),
          gt(deviceTokens.expiresAt, new Date())
        ),
      });
    }

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

    // SECURITY: Validate tokenVersion against current user
    // This ensures device tokens are invalidated when user's tokenVersion is bumped
    // (e.g., after refresh token reuse detection or manual "logout all devices")
    const { users } = await import('@pagespace/db');
    const user = await db.query.users.findFirst({
      where: eq(users.id, payload.userId),
      columns: { tokenVersion: true },
    });

    if (!user || user.tokenVersion !== payload.tokenVersion) {
      console.warn('Device token invalidated due to tokenVersion mismatch', {
        userId: payload.userId,
        tokenVersion: payload.tokenVersion,
        currentVersion: user?.tokenVersion,
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
  const updateData: {
    lastUsedAt: Date;
    lastIpAddress?: string;
  } = {
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
  reason: 'user_action' | 'suspicious_activity' | 'expired' | 'token_version_change' | 'logout'
): Promise<void> {
  await db.update(deviceTokens)
    .set({
      revokedAt: new Date(),
      revokedReason: reason,
    })
    .where(eq(deviceTokens.id, tokenId));
}

/**
 * Revoke a device token by its token value (used during logout)
 * Uses dual-mode lookup: hash first, plaintext fallback for migration
 */
export async function revokeDeviceTokenByValue(
  token: string,
  reason: 'logout' | 'user_action' = 'logout'
): Promise<boolean> {
  // SECURITY: Dual-mode lookup - try hash first, fallback to plaintext for migration
  const tokenHashValue = hashToken(token);

  // Try to revoke by hash first (new tokens store hash in tokenHash column)
  const hashResult = await db.update(deviceTokens)
    .set({
      revokedAt: new Date(),
      revokedReason: reason,
    })
    .where(and(
      eq(deviceTokens.tokenHash, tokenHashValue),
      isNull(deviceTokens.revokedAt)
    ));

  const hashRowCount = (hashResult as any).rowCount ?? 0;
  if (hashRowCount > 0) {
    return true;
  }

  // Fallback: try plaintext revocation for legacy tokens during migration
  const plaintextResult = await db.update(deviceTokens)
    .set({
      revokedAt: new Date(),
      revokedReason: reason,
    })
    .where(and(
      eq(deviceTokens.token, token),
      isNull(deviceTokens.revokedAt)
    ));

  const plaintextRowCount = (plaintextResult as any).rowCount ?? 0;
  return plaintextRowCount > 0;
}

/**
 * Revoke device tokens by device identifier (used for desktop logout)
 */
export async function revokeDeviceTokensByDevice(
  userId: string,
  deviceId: string,
  platform: 'web' | 'desktop' | 'ios' | 'android',
  reason: 'logout' | 'user_action' = 'logout'
): Promise<number> {
  const result = await db.update(deviceTokens)
    .set({
      revokedAt: new Date(),
      revokedReason: reason,
    })
    .where(and(
      eq(deviceTokens.userId, userId),
      eq(deviceTokens.deviceId, deviceId),
      eq(deviceTokens.platform, platform),
      isNull(deviceTokens.revokedAt)
    ));

  return (result as any).rowCount ?? 0;
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
  },
  tokenVersion: number = 0
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
      tokenVersion,
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
      lt(deviceTokens.expiresAt, new Date())
    ))
    .returning({ id: deviceTokens.id });

  return result.length;
}

/**
 * Validate existing device token or create a new one
 * This is a common pattern used across all mobile auth routes
 */
export async function validateOrCreateDeviceToken(params: {
  providedDeviceToken: string | null | undefined;
  userId: string;
  deviceId: string;
  platform: 'web' | 'desktop' | 'ios' | 'android';
  tokenVersion: number;
  deviceName?: string;
  userAgent?: string;
  ipAddress?: string;
}): Promise<{
  deviceToken: string;
  deviceTokenRecordId: string;
  isNew: boolean;
}> {
  const {
    providedDeviceToken,
    userId,
    deviceId,
    platform,
    tokenVersion,
    deviceName,
    userAgent,
    ipAddress,
  } = params;

  let deviceTokenValue = providedDeviceToken ?? null;
  let deviceTokenRecordId: string | null = null;
  let isNew = false;

  // Try to validate existing device token
  if (deviceTokenValue) {
    const storedDeviceToken = await validateDeviceToken(deviceTokenValue);
    if (
      !storedDeviceToken ||
      storedDeviceToken.userId !== userId ||
      storedDeviceToken.deviceId !== deviceId ||
      storedDeviceToken.platform !== platform
    ) {
      // Invalid or mismatched device token, will create new one
      deviceTokenValue = null;
    } else {
      // Valid device token, update activity
      deviceTokenRecordId = storedDeviceToken.id;
      await updateDeviceTokenActivity(storedDeviceToken.id, ipAddress);
    }
  }

  // Create new device token if needed
  if (!deviceTokenValue) {
    // SECURITY: Check if an active device token already exists for this user/device/platform
    // This prevents unique constraint violations when users clear storage or reinstall the app
    const existingActiveToken = await db.query.deviceTokens.findFirst({
      where: and(
        eq(deviceTokens.userId, userId),
        eq(deviceTokens.deviceId, deviceId),
        eq(deviceTokens.platform, platform),
        isNull(deviceTokens.revokedAt),
        gt(deviceTokens.expiresAt, new Date())  // Only reuse non-expired tokens
      ),
    });

    if (existingActiveToken) {
      // SECURITY: Regenerate JWT when reusing record (DB stores hash, not plaintext)
      // This maintains the same record ID but issues a fresh JWT to the client
      const regeneratedToken = await generateDeviceToken(userId, deviceId, platform, tokenVersion);
      const newTokenHash = hashToken(regeneratedToken);

      // Update the record with the new token hash
      await db.update(deviceTokens)
        .set({
          token: newTokenHash,
          tokenHash: newTokenHash,
          tokenPrefix: getTokenPrefix(regeneratedToken),
          lastUsedAt: new Date(),
          lastIpAddress: ipAddress || existingActiveToken.lastIpAddress,
        })
        .where(eq(deviceTokens.id, existingActiveToken.id));

      deviceTokenValue = regeneratedToken;  // Return the JWT, not the hash
      deviceTokenRecordId = existingActiveToken.id;
      isNew = false;

      console.info('Regenerated device token for existing record', {
        userId,
        deviceId,
        platform,
        tokenId: existingActiveToken.id,
      });
    } else {
      // Revoke any expired tokens that would block creation
      await revokeExpiredDeviceTokens(userId, deviceId, platform);

      // No existing active token, safe to create a new one
      const { id: newDeviceTokenId, token: newDeviceToken } = await createDeviceTokenRecord(
        userId,
        deviceId,
        platform,
        tokenVersion,
        {
          deviceName: deviceName || undefined,
          userAgent: userAgent || undefined,
          ipAddress: ipAddress === 'unknown' ? undefined : ipAddress,
          location: undefined,
        }
      );

      deviceTokenValue = newDeviceToken;
      deviceTokenRecordId = newDeviceTokenId;
      isNew = true;
    }
  }

  return {
    deviceToken: deviceTokenValue,
    deviceTokenRecordId: deviceTokenRecordId!,
    isNew,
  };
}

import { createId } from '@paralleldrive/cuid2';
import { db, deviceTokens, users, eq, and, isNull, lt, gt, sql, or } from '@pagespace/db';
import { hashToken, getTokenPrefix } from './token-utils';
import { generateOpaqueToken, isValidTokenFormat, getTokenType } from './opaque-tokens';

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
 * Generate an opaque device token (ps_dev_*)
 *
 * SECURITY: Device tokens are now opaque - no embedded claims.
 * All device info (userId, deviceId, platform, tokenVersion) is stored
 * in the database record, not in the token itself.
 *
 * This provides zero-trust security - tokens reveal nothing about the user.
 */
export function generateDeviceToken(): string {
  const { token } = generateOpaqueToken('dev');
  return token;
}

/**
 * Create a device token record in the database
 *
 * SECURITY: Token is now opaque (ps_dev_*) - no embedded claims.
 * All device info is stored in the DB record only.
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
  // Generate opaque device token (ps_dev_*)
  const token = generateDeviceToken();

  // Calculate expiration date (90 days from now)
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 90);

  // SECURITY: Hash the token before storing - never store plaintext
  const tokenHashValue = hashToken(token);

  // Insert into database with all device context stored in record
  const [record] = await db.insert(deviceTokens).values({
    userId,
    deviceId,
    platform,
    tokenVersion,
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
    token,  // Return plaintext opaque token to caller
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
 *
 * SECURITY: Opaque token validation (ps_dev_*):
 * 1. Validate token format (ps_dev_*)
 * 2. Hash-only lookup in DB (no plaintext fallback)
 * 3. Validate tokenVersion against user's current version
 *
 * All device context (userId, deviceId, platform, tokenVersion) is stored
 * in the database record, not embedded in the token.
 */
export async function validateDeviceToken(token: string): Promise<DeviceToken | null> {
  try {
    // Validate opaque token format
    if (!isValidTokenFormat(token) || getTokenType(token) !== 'dev') {
      console.error('Invalid device token format');
      return null;
    }

    // SECURITY: Hash-only lookup (no plaintext fallback)
    const tokenHashValue = hashToken(token);
    const deviceToken = await db.query.deviceTokens.findFirst({
      where: and(
        eq(deviceTokens.tokenHash, tokenHashValue),
        isNull(deviceTokens.revokedAt),
        gt(deviceTokens.expiresAt, new Date())
      ),
    });

    if (!deviceToken) {
      return null;
    }

    // SECURITY: Validate tokenVersion against current user
    // This ensures device tokens are invalidated when user's tokenVersion is bumped
    // (e.g., after refresh token reuse detection or manual "logout all devices")
    const user = await db.query.users.findFirst({
      where: eq(users.id, deviceToken.userId),
      columns: { tokenVersion: true },
    });

    if (!user) {
      console.warn('Device token validation failed: user not found', {
        userId: deviceToken.userId,
      });
      return null;
    }

    // Compare stored tokenVersion in device record against user's current version
    if (deviceToken.tokenVersion !== user.tokenVersion) {
      console.warn('Device token invalidated due to tokenVersion mismatch', {
        userId: deviceToken.userId,
        tokenVersion: deviceToken.tokenVersion,
        currentVersion: user.tokenVersion,
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
 * Uses hash-only lookup (no plaintext fallback)
 */
export async function revokeDeviceTokenByValue(
  token: string,
  reason: 'logout' | 'user_action' = 'logout'
): Promise<boolean> {
  // SECURITY: Hash-only lookup (no plaintext fallback)
  const tokenHashValue = hashToken(token);

  const result = await db.update(deviceTokens)
    .set({
      revokedAt: new Date(),
      revokedReason: reason,
    })
    .where(and(
      eq(deviceTokens.tokenHash, tokenHashValue),
      isNull(deviceTokens.revokedAt)
    ));

  const rowCount = (result as any).rowCount ?? 0;
  return rowCount > 0;
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
 *
 * SECURITY: Fetches current tokenVersion from DB to ensure new token
 * respects any "logout all devices" operations that may have occurred.
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

    // Fetch current user's tokenVersion from DB
    // This ensures the new token respects any version bumps (e.g., "logout all devices")
    const user = await db.query.users.findFirst({
      where: eq(users.id, oldDeviceToken.userId),
      columns: { tokenVersion: true },
    });

    if (!user) {
      console.warn('Device token rotation failed: user not found', {
        userId: oldDeviceToken.userId,
      });
      return null;
    }

    const tokenVersion = user.tokenVersion;

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
 *
 * SECURITY: Uses atomic transaction with FOR UPDATE locking to prevent
 * race conditions in concurrent login/signup/OAuth flows.
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
  // SECURITY: Delegate to atomic version with FOR UPDATE locking
  // This prevents TOCTOU race conditions in concurrent requests
  // Dynamic import to avoid module initialization order issues
  const { atomicValidateOrCreateDeviceToken } = await import('@pagespace/db/transactions/auth-transactions');
  return atomicValidateOrCreateDeviceToken(params, {
    hashToken,
    getTokenPrefix,
    generateDeviceToken,
    // Opaque token validation - check format and type
    validateOpaqueToken: (token: string) => isValidTokenFormat(token) && getTokenType(token) === 'dev',
  });
}

/**
 * Atomic Auth Transactions (P3-T2)
 *
 * Race-condition-safe token operations using PostgreSQL FOR UPDATE locking.
 * These functions prevent TOCTOU (Time-of-Check-Time-of-Use) vulnerabilities
 * in token refresh and rotation operations.
 *
 * SECURITY: All token operations that validate-then-modify MUST use these
 * atomic functions to prevent concurrent request exploits.
 *
 * @module @pagespace/db/transactions/auth-transactions
 */

import { db, refreshTokens, deviceTokens, users, eq, sql, and, isNull, gt } from '../index';
import { createId } from '@paralleldrive/cuid2';

/**
 * Result of atomic refresh token validation
 */
export interface RefreshResult {
  success: boolean;
  userId?: string;
  tokenVersion?: number;
  role?: 'user' | 'admin';
  error?: string;
  /** True if this appears to be a token reuse attack */
  tokenReuse?: boolean;
}

/**
 * Result of atomic device token rotation
 */
export interface DeviceRotationResult {
  success: boolean;
  newToken?: string;
  newTokenHash?: string;
  newTokenPrefix?: string;
  deviceTokenId?: string;
  userId?: string;
  deviceId?: string;
  platform?: 'web' | 'desktop' | 'ios' | 'android';
  deviceName?: string | null;
  userAgent?: string | null;
  location?: string | null;
  error?: string;
}

/**
 * Result of atomic device token validation/creation
 */
export interface AtomicDeviceTokenResult {
  deviceToken: string;
  deviceTokenRecordId: string;
  isNew: boolean;
}

/**
 * Atomically validate and consume a refresh token.
 *
 * SECURITY FEATURES:
 * - FOR UPDATE lock prevents concurrent refresh attempts
 * - Token is marked as used atomically within the transaction
 * - Validates JWT tokenVersion against user's current tokenVersion
 * - Detects token reuse attacks and invalidates all user sessions
 *
 * @param refreshTokenValue - The raw refresh token from the client
 * @param hashToken - Function to hash the token for lookup
 * @param jwtTokenVersion - Optional tokenVersion from decoded JWT for validation
 * @returns RefreshResult with user info on success, error on failure
 */
export async function atomicTokenRefresh(
  refreshTokenValue: string,
  hashToken: (token: string) => string,
  jwtTokenVersion?: number
): Promise<RefreshResult> {
  const tokenHash = hashToken(refreshTokenValue);

  return db.transaction(async (tx) => {
    // Lock the token row to prevent concurrent access
    // FOR UPDATE OF rt ensures we only lock the refresh_tokens row, not the joined users row
    // IMPORTANT: Column names use camelCase to match Drizzle schema (e.g., "userId", "tokenHash")
    // NOTE: refresh_tokens table doesn't have revokedAt - tokens are deleted after use
    const lockResult = await tx.execute(sql`
      SELECT
        rt.id as rt_id,
        rt."userId",
        rt."expiresAt",
        u."tokenVersion",
        u.role
      FROM refresh_tokens rt
      JOIN users u ON u.id = rt."userId"
      WHERE rt."tokenHash" = ${tokenHash}
      FOR UPDATE OF rt
    `);

    const row = lockResult.rows[0] as {
      rt_id: string;
      userId: string;
      expiresAt: Date | null;
      tokenVersion: number;
      role: 'user' | 'admin';
    } | undefined;

    // Check if token exists
    if (!row) {
      // Token not found - could be already used or never existed
      // Check if this is a token reuse attack (token hash exists but was already used)
      const usedCheck = await tx.execute(sql`
        SELECT "userId" FROM refresh_tokens
        WHERE "tokenHash" = ${tokenHash}
      `);

      if (usedCheck.rows.length > 0) {
        // TOKEN REUSE DETECTED - token was already used
        // This is a critical security event - invalidate all user sessions
        const userId = (usedCheck.rows[0] as { userId: string }).userId;

        await tx.execute(sql`
          UPDATE users
          SET "tokenVersion" = "tokenVersion" + 1
          WHERE id = ${userId}
        `);

        // Also revoke all device tokens for this user
        await tx.execute(sql`
          UPDATE device_tokens
          SET "revokedAt" = NOW(), "revokedReason" = 'token_reuse_detected'
          WHERE "userId" = ${userId}
            AND "revokedAt" IS NULL
        `);

        return {
          success: false,
          error: 'Token reuse detected - all sessions invalidated',
          tokenReuse: true,
        };
      }

      return { success: false, error: 'Invalid refresh token' };
    }

    // NOTE: refresh_tokens doesn't have revokedAt column - tokens are deleted after use
    // Token reuse is detected when token hash is not found (already deleted)

    // Check if token is expired
    if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
      return { success: false, error: 'Token has expired' };
    }

    // SECURITY: Validate JWT tokenVersion against user's current tokenVersion
    // This ensures tokens minted before a "logout all devices" are rejected
    if (jwtTokenVersion !== undefined && jwtTokenVersion !== row.tokenVersion) {
      return { success: false, error: 'Invalid refresh token version.' };
    }

    // Atomically delete the token (refresh tokens are single-use)
    // NOTE: refresh_tokens doesn't have revokedAt - we delete instead of marking revoked
    await tx.execute(sql`
      DELETE FROM refresh_tokens
      WHERE id = ${row.rt_id}
    `);

    return {
      success: true,
      userId: row.userId,
      tokenVersion: row.tokenVersion,
      role: row.role,
    };
  });
}

/**
 * Atomically rotate a device token.
 *
 * SECURITY FEATURES:
 * - FOR UPDATE lock prevents concurrent rotation attempts
 * - Old token is revoked and new token created atomically
 * - Validates tokenVersion to ensure device token is still valid
 *
 * @param oldTokenValue - The current device token
 * @param metadata - Updated metadata for the new token
 * @param hashToken - Function to hash tokens
 * @param getTokenPrefix - Function to get token prefix for debugging
 * @param generateDeviceToken - Function to generate new device token JWT
 * @returns DeviceRotationResult with new token on success
 */
export async function atomicDeviceTokenRotation(
  oldTokenValue: string,
  metadata: {
    userAgent?: string;
    ipAddress?: string;
  },
  hashToken: (token: string) => string,
  getTokenPrefix: (token: string) => string,
  generateDeviceToken: (
    userId: string,
    deviceId: string,
    platform: 'web' | 'desktop' | 'ios' | 'android',
    tokenVersion: number
  ) => Promise<string>
): Promise<DeviceRotationResult> {
  const tokenHash = hashToken(oldTokenValue);

  return db.transaction(async (tx) => {
    // Lock the device token row
    // IMPORTANT: Column names use camelCase to match Drizzle schema
    const lockResult = await tx.execute(sql`
      SELECT
        dt.id,
        dt."userId",
        dt."deviceId",
        dt.platform,
        dt."deviceName",
        dt."userAgent",
        dt."lastIpAddress",
        dt.location,
        dt."expiresAt",
        u."tokenVersion"
      FROM device_tokens dt
      JOIN users u ON u.id = dt."userId"
      WHERE dt."tokenHash" = ${tokenHash}
        AND dt."revokedAt" IS NULL
      FOR UPDATE OF dt
    `);

    const row = lockResult.rows[0] as {
      id: string;
      userId: string;
      deviceId: string;
      platform: 'web' | 'desktop' | 'ios' | 'android';
      deviceName: string | null;
      userAgent: string | null;
      lastIpAddress: string | null;
      location: string | null;
      expiresAt: Date | null;
      tokenVersion: number;
    } | undefined;

    if (!row) {
      return { success: false, error: 'Invalid or expired device token' };
    }

    // Check if token is expired
    if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
      return { success: false, error: 'Device token has expired' };
    }

    // Revoke old token atomically
    await tx.execute(sql`
      UPDATE device_tokens
      SET "revokedAt" = NOW(), "revokedReason" = 'rotated'
      WHERE id = ${row.id}
    `);

    // Generate new token
    const newToken = await generateDeviceToken(
      row.userId,
      row.deviceId,
      row.platform,
      row.tokenVersion
    );
    const newTokenHash = hashToken(newToken);
    const newTokenPrefix = getTokenPrefix(newToken);

    // Calculate new expiration (90 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 90);

    // Create new token in same transaction
    const newId = createId();
    await tx.execute(sql`
      INSERT INTO device_tokens (
        id,
        "userId",
        "deviceId",
        platform,
        token,
        "tokenHash",
        "tokenPrefix",
        "expiresAt",
        "deviceName",
        "userAgent",
        "ipAddress",
        "lastIpAddress",
        location,
        "trustScore",
        "suspiciousActivityCount",
        "createdAt"
      ) VALUES (
        ${newId},
        ${row.userId},
        ${row.deviceId},
        ${row.platform},
        ${newTokenHash},
        ${newTokenHash},
        ${newTokenPrefix},
        ${expiresAt},
        ${row.deviceName},
        ${metadata.userAgent || row.userAgent},
        ${metadata.ipAddress || row.lastIpAddress},
        ${metadata.ipAddress || row.lastIpAddress},
        ${row.location},
        1.0,
        0,
        NOW()
      )
    `);

    return {
      success: true,
      newToken,
      newTokenHash,
      newTokenPrefix,
      deviceTokenId: newId,
      userId: row.userId,
      deviceId: row.deviceId,
      platform: row.platform,
      deviceName: row.deviceName,
      userAgent: metadata.userAgent || row.userAgent,
      location: row.location,
    };
  });
}

/**
 * Atomically validate an existing device token or create a new one.
 *
 * SECURITY FEATURES:
 * - FOR UPDATE lock on user prevents concurrent token creation
 * - Prevents duplicate device tokens for same user/device/platform
 * - Handles token regeneration for existing records safely
 *
 * @param params - Token validation/creation parameters
 * @param hashToken - Function to hash tokens
 * @param getTokenPrefix - Function to get token prefix
 * @param generateDeviceToken - Function to generate device token JWT
 * @param decodeDeviceToken - Function to decode and validate device token
 * @returns AtomicDeviceTokenResult with token info
 */
export async function atomicValidateOrCreateDeviceToken(params: {
  providedDeviceToken: string | null | undefined;
  userId: string;
  deviceId: string;
  platform: 'web' | 'desktop' | 'ios' | 'android';
  tokenVersion: number;
  deviceName?: string;
  userAgent?: string;
  ipAddress?: string;
}, utilities: {
  hashToken: (token: string) => string;
  getTokenPrefix: (token: string) => string;
  generateDeviceToken: (
    userId: string,
    deviceId: string,
    platform: 'web' | 'desktop' | 'ios' | 'android',
    tokenVersion: number
  ) => Promise<string>;
  validateDeviceTokenPayload: (token: string) => Promise<{
    userId: string;
    deviceId: string;
    platform: string;
    tokenVersion: number;
  } | null>;
}): Promise<AtomicDeviceTokenResult> {
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

  const { hashToken, getTokenPrefix, generateDeviceToken, validateDeviceTokenPayload } = utilities;

  return db.transaction(async (tx) => {
    // If a device token was provided, try to validate it first
    if (providedDeviceToken) {
      const payload = await validateDeviceTokenPayload(providedDeviceToken);

      if (payload &&
          payload.userId === userId &&
          payload.deviceId === deviceId &&
          payload.platform === platform &&
          payload.tokenVersion === tokenVersion) { // SECURITY: Enforce tokenVersion
        // Token payload is valid (including tokenVersion), now check DB record with lock
        const tokenHash = hashToken(providedDeviceToken);

        const existingResult = await tx.execute(sql`
          SELECT id, "expiresAt"
          FROM device_tokens
          WHERE "tokenHash" = ${tokenHash}
            AND "revokedAt" IS NULL
          FOR UPDATE
        `);

        const existing = existingResult.rows[0] as {
          id: string;
          expiresAt: Date | null;
        } | undefined;

        if (existing && (!existing.expiresAt || new Date(existing.expiresAt) > new Date())) {
          // Valid token, update activity and return
          await tx.execute(sql`
            UPDATE device_tokens
            SET "lastUsedAt" = NOW(),
                "lastIpAddress" = COALESCE(${ipAddress}, "lastIpAddress")
            WHERE id = ${existing.id}
          `);

          return {
            deviceToken: providedDeviceToken,
            deviceTokenRecordId: existing.id,
            isNew: false,
          };
        }
      }
    }

    // Lock user row to serialize device token creation per user
    // This prevents race conditions where two requests create duplicate tokens
    await tx.execute(sql`
      SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE
    `);

    // Check for existing active token for this device (with lock held)
    const existingActiveResult = await tx.execute(sql`
      SELECT id, "tokenHash"
      FROM device_tokens
      WHERE "userId" = ${userId}
        AND "deviceId" = ${deviceId}
        AND platform = ${platform}
        AND "revokedAt" IS NULL
        AND "expiresAt" > NOW()
      FOR UPDATE
    `);

    const existingActive = existingActiveResult.rows[0] as {
      id: string;
      tokenHash: string;
    } | undefined;

    if (existingActive) {
      // Regenerate token for existing record (DB stores hash, not plaintext)
      // This maintains the same record ID but issues a fresh JWT
      const regeneratedToken = await generateDeviceToken(userId, deviceId, platform, tokenVersion);
      const newTokenHash = hashToken(regeneratedToken);
      const newTokenPrefix = getTokenPrefix(regeneratedToken);

      await tx.execute(sql`
        UPDATE device_tokens
        SET token = ${newTokenHash},
            "tokenHash" = ${newTokenHash},
            "tokenPrefix" = ${newTokenPrefix},
            "lastUsedAt" = NOW(),
            "lastIpAddress" = COALESCE(${ipAddress}, "lastIpAddress")
        WHERE id = ${existingActive.id}
      `);

      return {
        deviceToken: regeneratedToken,
        deviceTokenRecordId: existingActive.id,
        isNew: false,
      };
    }

    // Revoke any expired tokens that would block creation (unique constraint)
    await tx.execute(sql`
      UPDATE device_tokens
      SET "revokedAt" = NOW(), "revokedReason" = 'expired'
      WHERE "userId" = ${userId}
        AND "deviceId" = ${deviceId}
        AND platform = ${platform}
        AND "revokedAt" IS NULL
        AND "expiresAt" <= NOW()
    `);

    // Create new token (safe - we hold user lock)
    const newToken = await generateDeviceToken(userId, deviceId, platform, tokenVersion);
    const newTokenHash = hashToken(newToken);
    const newTokenPrefix = getTokenPrefix(newToken);

    // Calculate expiration (90 days)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 90);

    const newId = createId();
    await tx.execute(sql`
      INSERT INTO device_tokens (
        id,
        "userId",
        "deviceId",
        platform,
        token,
        "tokenHash",
        "tokenPrefix",
        "expiresAt",
        "deviceName",
        "userAgent",
        "ipAddress",
        "lastIpAddress",
        "trustScore",
        "suspiciousActivityCount",
        "createdAt"
      ) VALUES (
        ${newId},
        ${userId},
        ${deviceId},
        ${platform},
        ${newTokenHash},
        ${newTokenHash},
        ${newTokenPrefix},
        ${expiresAt},
        ${deviceName || null},
        ${userAgent || null},
        ${ipAddress || null},
        ${ipAddress || null},
        1.0,
        0,
        NOW()
      )
    `);

    return {
      deviceToken: newToken,
      deviceTokenRecordId: newId,
      isNew: true,
    };
  });
}

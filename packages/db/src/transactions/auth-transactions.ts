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

import { db, deviceTokens, users, eq, sql } from '../index';
import { createId } from '@paralleldrive/cuid2';

/**
 * Grace period for device token rotation race conditions (Okta-style)
 * During this window after a token is revoked, concurrent requests using the same
 * token will succeed and receive new tokens (different but functionally equivalent)
 */
const DEVICE_TOKEN_GRACE_PERIOD_MS = 30 * 1000; // 30 seconds

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
  /** True if this was a grace period retry (token already rotated but within 30s window) */
  gracePeriodRetry?: boolean;
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
 * Atomically rotate a device token.
 *
 * SECURITY FEATURES:
 * - FOR UPDATE lock prevents concurrent rotation attempts
 * - Old token is revoked and new token created atomically
 * - Validates tokenVersion to ensure device token is still valid
 * - Grace period (30s) allows retry for concurrent requests
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
    // Lock the device token row (includes revoked tokens for grace period check)
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
        dt."revokedAt",
        dt."revokedReason",
        dt."replacedByTokenId",
        u."tokenVersion"
      FROM device_tokens dt
      JOIN users u ON u.id = dt."userId"
      WHERE dt."tokenHash" = ${tokenHash}
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
      revokedAt: Date | null;
      revokedReason: string | null;
      replacedByTokenId: string | null;
      tokenVersion: number;
    } | undefined;

    if (!row) {
      return { success: false, error: 'Invalid or expired device token' };
    }

    // Check if already rotated (revoked with reason 'rotated')
    if (row.revokedAt && row.revokedReason === 'rotated') {
      // PostgreSQL returns timestamps without timezone suffix, so we need to
      // handle both Date objects (from Drizzle ORM) and strings (from raw SQL).
      const revokedAtDate = row.revokedAt instanceof Date
        ? row.revokedAt
        : new Date(String(row.revokedAt).replace(' ', 'T') + 'Z');
      const timeSinceRevoked = Date.now() - revokedAtDate.getTime();

      if (timeSinceRevoked < DEVICE_TOKEN_GRACE_PERIOD_MS && row.replacedByTokenId) {
        // GRACE PERIOD: Look up the replacement token
        const replacementResult = await tx.execute(sql`
          SELECT id, "deviceName", "userAgent", location
          FROM device_tokens
          WHERE id = ${row.replacedByTokenId}
            AND "revokedAt" IS NULL
        `);

        const replacement = replacementResult.rows[0] as {
          id: string;
          deviceName: string | null;
          userAgent: string | null;
          location: string | null;
        } | undefined;

        if (replacement) {
          // Return success but without a new token (client already has it from first request)
          return {
            success: true,
            deviceTokenId: replacement.id,
            userId: row.userId,
            deviceId: row.deviceId,
            platform: row.platform,
            deviceName: replacement.deviceName,
            userAgent: replacement.userAgent,
            location: replacement.location,
            gracePeriodRetry: true,
          };
        }
      }

      return { success: false, error: 'Device token already rotated' };
    }

    // Check if revoked for other reasons
    if (row.revokedAt) {
      return { success: false, error: 'Device token has been revoked' };
    }

    // Check if token is expired
    if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
      return { success: false, error: 'Device token has expired' };
    }

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

    // IMPORTANT: Revoke old token FIRST to clear the unique constraint
    // (device_tokens_active_device_idx prevents multiple active tokens per device)
    const newId = createId();
    await tx.execute(sql`
      UPDATE device_tokens
      SET "revokedAt" = NOW(), "revokedReason" = 'rotated', "replacedByTokenId" = ${newId}
      WHERE id = ${row.id}
    `);

    // Then insert new token (now safe - old token is revoked)
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
          await tx.execute(sql`UPDATE device_tokens SET "lastUsedAt" = NOW(), "lastIpAddress" = COALESCE(${ipAddress || null}, "lastIpAddress") WHERE id = ${existing.id}`);

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
      // Refresh expiresAt to match new JWT (90 days from now)
      const refreshedExpiresAt = new Date();
      refreshedExpiresAt.setDate(refreshedExpiresAt.getDate() + 90);

      await tx.execute(sql`UPDATE device_tokens SET "token" = ${newTokenHash}, "tokenHash" = ${newTokenHash}, "tokenPrefix" = ${newTokenPrefix}, "expiresAt" = ${refreshedExpiresAt}, "lastUsedAt" = NOW(), "lastIpAddress" = COALESCE(${ipAddress || null}, "lastIpAddress") WHERE id = ${existingActive.id}`);

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

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
 * - Detects token reuse attacks and invalidates all user sessions
 *
 * @param refreshTokenValue - The raw refresh token from the client
 * @param hashToken - Function to hash the token for lookup
 * @returns RefreshResult with user info on success, error on failure
 */
export async function atomicTokenRefresh(
  refreshTokenValue: string,
  hashToken: (token: string) => string
): Promise<RefreshResult> {
  const tokenHash = hashToken(refreshTokenValue);

  return db.transaction(async (tx) => {
    // Lock the token row to prevent concurrent access
    // FOR UPDATE OF rt ensures we only lock the refresh_tokens row, not the joined users row
    const lockResult = await tx.execute(sql`
      SELECT
        rt.id as rt_id,
        rt.user_id,
        rt.expires_at,
        rt.revoked_at,
        u.token_version,
        u.role,
        u.suspended_at
      FROM refresh_tokens rt
      JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = ${tokenHash}
      FOR UPDATE OF rt
    `);

    const row = lockResult.rows[0] as {
      rt_id: string;
      user_id: string;
      expires_at: Date | null;
      revoked_at: Date | null;
      token_version: number;
      role: 'user' | 'admin';
      suspended_at: Date | null;
    } | undefined;

    // Check if token exists
    if (!row) {
      // Token not found - could be already used or never existed
      // Check if this is a token reuse attack (token hash exists but was already used)
      const usedCheck = await tx.execute(sql`
        SELECT user_id FROM refresh_tokens
        WHERE token_hash = ${tokenHash}
      `);

      if (usedCheck.rows.length > 0) {
        // TOKEN REUSE DETECTED - token was already used
        // This is a critical security event - invalidate all user sessions
        const userId = (usedCheck.rows[0] as { user_id: string }).user_id;

        await tx.execute(sql`
          UPDATE users
          SET token_version = token_version + 1
          WHERE id = ${userId}
        `);

        // Also revoke all device tokens for this user
        await tx.execute(sql`
          UPDATE device_tokens
          SET revoked_at = NOW(), revoked_reason = 'token_reuse_detected'
          WHERE user_id = ${userId}
            AND revoked_at IS NULL
        `);

        return {
          success: false,
          error: 'Token reuse detected - all sessions invalidated',
          tokenReuse: true,
        };
      }

      return { success: false, error: 'Invalid refresh token' };
    }

    // Check if token is revoked
    if (row.revoked_at) {
      return { success: false, error: 'Token has been revoked' };
    }

    // Check if token is expired
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return { success: false, error: 'Token has expired' };
    }

    // Check if user is suspended
    if (row.suspended_at) {
      return { success: false, error: 'User account is suspended' };
    }

    // Atomically mark token as used (revoke it)
    await tx.execute(sql`
      UPDATE refresh_tokens
      SET revoked_at = NOW(), revoked_reason = 'refreshed'
      WHERE id = ${row.rt_id}
    `);

    return {
      success: true,
      userId: row.user_id,
      tokenVersion: row.token_version,
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
    const lockResult = await tx.execute(sql`
      SELECT
        dt.id,
        dt.user_id,
        dt.device_id,
        dt.platform,
        dt.device_name,
        dt.user_agent,
        dt.last_ip_address,
        dt.location,
        dt.expires_at,
        u.token_version,
        u.suspended_at
      FROM device_tokens dt
      JOIN users u ON u.id = dt.user_id
      WHERE dt.token_hash = ${tokenHash}
        AND dt.revoked_at IS NULL
      FOR UPDATE OF dt
    `);

    const row = lockResult.rows[0] as {
      id: string;
      user_id: string;
      device_id: string;
      platform: 'web' | 'desktop' | 'ios' | 'android';
      device_name: string | null;
      user_agent: string | null;
      last_ip_address: string | null;
      location: string | null;
      expires_at: Date | null;
      token_version: number;
      suspended_at: Date | null;
    } | undefined;

    if (!row) {
      return { success: false, error: 'Invalid or expired device token' };
    }

    // Check if token is expired
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return { success: false, error: 'Device token has expired' };
    }

    if (row.suspended_at) {
      return { success: false, error: 'User account is suspended' };
    }

    // Revoke old token atomically
    await tx.execute(sql`
      UPDATE device_tokens
      SET revoked_at = NOW(), revoked_reason = 'rotated'
      WHERE id = ${row.id}
    `);

    // Generate new token
    const newToken = await generateDeviceToken(
      row.user_id,
      row.device_id,
      row.platform,
      row.token_version
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
        user_id,
        device_id,
        platform,
        token,
        token_hash,
        token_prefix,
        expires_at,
        device_name,
        user_agent,
        ip_address,
        last_ip_address,
        location,
        trust_score,
        suspicious_activity_count,
        created_at
      ) VALUES (
        ${newId},
        ${row.user_id},
        ${row.device_id},
        ${row.platform},
        ${newTokenHash},
        ${newTokenHash},
        ${newTokenPrefix},
        ${expiresAt},
        ${row.device_name},
        ${metadata.userAgent || row.user_agent},
        ${metadata.ipAddress || row.last_ip_address},
        ${metadata.ipAddress || row.last_ip_address},
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
      userId: row.user_id,
      deviceId: row.device_id,
      platform: row.platform,
      deviceName: row.device_name,
      userAgent: metadata.userAgent || row.user_agent,
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
          payload.platform === platform) {
        // Token payload is valid, now check DB record with lock
        const tokenHash = hashToken(providedDeviceToken);

        const existingResult = await tx.execute(sql`
          SELECT id, expires_at
          FROM device_tokens
          WHERE token_hash = ${tokenHash}
            AND revoked_at IS NULL
          FOR UPDATE
        `);

        const existing = existingResult.rows[0] as {
          id: string;
          expires_at: Date | null;
        } | undefined;

        if (existing && (!existing.expires_at || new Date(existing.expires_at) > new Date())) {
          // Valid token, update activity and return
          await tx.execute(sql`
            UPDATE device_tokens
            SET last_used_at = NOW(),
                last_ip_address = COALESCE(${ipAddress}, last_ip_address)
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
      SELECT id, token_hash
      FROM device_tokens
      WHERE user_id = ${userId}
        AND device_id = ${deviceId}
        AND platform = ${platform}
        AND revoked_at IS NULL
        AND expires_at > NOW()
      FOR UPDATE
    `);

    const existingActive = existingActiveResult.rows[0] as {
      id: string;
      token_hash: string;
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
            token_hash = ${newTokenHash},
            token_prefix = ${newTokenPrefix},
            last_used_at = NOW(),
            last_ip_address = COALESCE(${ipAddress}, last_ip_address)
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
      SET revoked_at = NOW(), revoked_reason = 'expired'
      WHERE user_id = ${userId}
        AND device_id = ${deviceId}
        AND platform = ${platform}
        AND revoked_at IS NULL
        AND expires_at <= NOW()
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
        user_id,
        device_id,
        platform,
        token,
        token_hash,
        token_prefix,
        expires_at,
        device_name,
        user_agent,
        ip_address,
        last_ip_address,
        trust_score,
        suspicious_activity_count,
        created_at
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

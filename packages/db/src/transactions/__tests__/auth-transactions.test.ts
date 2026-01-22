/**
 * Auth Transactions Integration Tests
 *
 * These tests verify the atomic token operations with PostgreSQL FOR UPDATE locking.
 * Requires a running test database.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { db, refreshTokens, deviceTokens, users, eq } from '../../index';
import { createHash } from 'crypto';
import { createId } from '@paralleldrive/cuid2';
import {
  atomicTokenRefresh,
  atomicDeviceTokenRotation,
  atomicValidateOrCreateDeviceToken,
} from '../auth-transactions';

// Token utilities
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function getTokenPrefix(token: string): string {
  return token.substring(0, 12);
}

async function generateDeviceToken(
  userId: string,
  deviceId: string,
  platform: 'web' | 'desktop' | 'ios' | 'android',
  tokenVersion: number
): Promise<string> {
  return `dev_${createId()}_${userId}_${deviceId}_${platform}_${tokenVersion}`;
}

async function validateDeviceTokenPayload(token: string): Promise<{
  userId: string;
  deviceId: string;
  platform: string;
  tokenVersion: number;
} | null> {
  if (!token.startsWith('dev_')) return null;
  const parts = token.split('_');
  if (parts.length < 6) return null;
  return {
    userId: parts[2],
    deviceId: parts[3],
    platform: parts[4],
    tokenVersion: parseInt(parts[5], 10),
  };
}

describe('auth-transactions', () => {
  let testUserId: string;

  // Create test user before each test
  beforeEach(async () => {
    testUserId = createId();
    await db.insert(users).values({
      id: testUserId,
      name: 'Test User',
      email: `test-${testUserId}@example.com`,
      password: 'hashed_password',
      provider: 'email',
      tokenVersion: 1,
    });
  });

  // Clean up after each test
  afterEach(async () => {
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, testUserId));
    await db.delete(deviceTokens).where(eq(deviceTokens.userId, testUserId));
    await db.delete(users).where(eq(users.id, testUserId));
  });

  describe('atomicTokenRefresh', () => {
    it('should return success with user info for valid token', async () => {
      // Create a valid refresh token
      const rawToken = `ps_refresh_${createId()}`;
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + 86400000); // 1 day from now

      await db.insert(refreshTokens).values({
        id: createId(),
        userId: testUserId,
        token: tokenHash,
        tokenHash,
        tokenPrefix: getTokenPrefix(rawToken),
        expiresAt,
      });

      const result = await atomicTokenRefresh(rawToken, hashToken);

      expect(result.success).toBe(true);
      expect(result.userId).toBe(testUserId);
      expect(result.tokenVersion).toBe(1);
      expect(result.role).toBe('user');
    });

    it('should return error for non-existent token', async () => {
      const result = await atomicTokenRefresh('invalid-token', hashToken);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid refresh token');
      expect(result.tokenReuse).toBeUndefined();
    });

    it('should prevent token reuse by deleting after use', async () => {
      // NOTE: refresh_tokens table doesn't have revokedAt column.
      // Tokens are deleted after successful use, so reuse attempts
      // will just fail to find the token (returned as "Invalid refresh token")
      const rawToken = `ps_refresh_${createId()}`;
      const tokenHash = hashToken(rawToken);

      await db.insert(refreshTokens).values({
        id: createId(),
        userId: testUserId,
        token: tokenHash,
        tokenHash,
        tokenPrefix: getTokenPrefix(rawToken),
        expiresAt: new Date(Date.now() + 86400000),
      });

      // First refresh should succeed
      const result1 = await atomicTokenRefresh(rawToken, hashToken);
      expect(result1.success).toBe(true);

      // Token should be deleted after use
      // Second refresh attempt should fail (token not found)
      const result2 = await atomicTokenRefresh(rawToken, hashToken);
      expect(result2.success).toBe(false);
      expect(result2.error).toBe('Invalid refresh token');
      // Note: tokenReuse flag is not set because we can't distinguish
      // between "never existed" and "already used" without revokedAt column
    });

    it('should return error for expired token', async () => {
      const rawToken = `ps_refresh_${createId()}`;
      const tokenHash = hashToken(rawToken);

      await db.insert(refreshTokens).values({
        id: createId(),
        userId: testUserId,
        token: tokenHash,
        tokenHash,
        tokenPrefix: getTokenPrefix(rawToken),
        expiresAt: new Date(Date.now() - 86400000), // Expired 1 day ago
      });

      const result = await atomicTokenRefresh(rawToken, hashToken);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Token has expired');
    });

    it('should atomically prevent concurrent refresh attempts', async () => {
      // Create a valid refresh token
      const rawToken = `ps_refresh_${createId()}`;
      const tokenHash = hashToken(rawToken);

      await db.insert(refreshTokens).values({
        id: createId(),
        userId: testUserId,
        token: tokenHash,
        tokenHash,
        tokenPrefix: getTokenPrefix(rawToken),
        expiresAt: new Date(Date.now() + 86400000),
      });

      // Simulate concurrent refresh attempts
      const results = await Promise.all([
        atomicTokenRefresh(rawToken, hashToken),
        atomicTokenRefresh(rawToken, hashToken),
        atomicTokenRefresh(rawToken, hashToken),
      ]);

      // Only one should succeed
      const successes = results.filter((r) => r.success);
      const failures = results.filter((r) => !r.success);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(2);

      // The failures should fail with "Invalid refresh token" (token was deleted)
      failures.forEach((f) => {
        expect(f.error).toBe('Invalid refresh token');
      });
    });
  });

  describe('atomicDeviceTokenRotation', () => {
    it('should successfully rotate device token', async () => {
      // Create a device token
      const rawToken = await generateDeviceToken(testUserId, 'device-1', 'web', 1);
      const tokenHash = hashToken(rawToken);

      await db.insert(deviceTokens).values({
        id: createId(),
        userId: testUserId,
        deviceId: 'device-1',
        platform: 'web',
        token: tokenHash,
        tokenHash,
        tokenPrefix: getTokenPrefix(rawToken),
        expiresAt: new Date(Date.now() + 86400000),
        deviceName: 'Test Device',
        trustScore: 1.0,
        suspiciousActivityCount: 0,
      });

      const result = await atomicDeviceTokenRotation(
        rawToken,
        { userAgent: 'New User Agent', ipAddress: '10.0.0.1' },
        hashToken,
        getTokenPrefix,
        generateDeviceToken
      );

      expect(result.success).toBe(true);
      expect(result.newToken).toBeDefined();
      expect(result.userId).toBe(testUserId);
      expect(result.deviceId).toBe('device-1');
      expect(result.platform).toBe('web');
    });

    it('should return error for invalid device token', async () => {
      const result = await atomicDeviceTokenRotation(
        'invalid-device-token',
        {},
        hashToken,
        getTokenPrefix,
        generateDeviceToken
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid or expired device token');
    });

    it('should atomically prevent concurrent rotation attempts', async () => {
      const rawToken = await generateDeviceToken(testUserId, 'device-1', 'web', 1);
      const tokenHash = hashToken(rawToken);

      await db.insert(deviceTokens).values({
        id: createId(),
        userId: testUserId,
        deviceId: 'device-1',
        platform: 'web',
        token: tokenHash,
        tokenHash,
        tokenPrefix: getTokenPrefix(rawToken),
        expiresAt: new Date(Date.now() + 86400000),
        trustScore: 1.0,
        suspiciousActivityCount: 0,
      });

      // Simulate concurrent rotation attempts
      const results = await Promise.all([
        atomicDeviceTokenRotation(rawToken, {}, hashToken, getTokenPrefix, generateDeviceToken),
        atomicDeviceTokenRotation(rawToken, {}, hashToken, getTokenPrefix, generateDeviceToken),
        atomicDeviceTokenRotation(rawToken, {}, hashToken, getTokenPrefix, generateDeviceToken),
      ]);

      // Only one should succeed
      const successes = results.filter((r) => r.success);
      expect(successes).toHaveLength(1);
    });
  });

  describe('atomicValidateOrCreateDeviceToken', () => {
    const utilities = {
      hashToken,
      getTokenPrefix,
      generateDeviceToken,
      validateDeviceTokenPayload,
    };

    it('should create new token when no existing record', async () => {
      const result = await atomicValidateOrCreateDeviceToken(
        {
          providedDeviceToken: null,
          userId: testUserId,
          deviceId: 'new-device',
          platform: 'web',
          tokenVersion: 1,
          deviceName: 'New Device',
          userAgent: 'Test Agent',
          ipAddress: '192.168.1.1',
        },
        utilities
      );

      expect(result.deviceToken).toBeDefined();
      expect(result.deviceTokenRecordId).toBeDefined();
      expect(result.isNew).toBe(true);
    });

    it('should regenerate token for existing device record', async () => {
      // First create a device token
      const firstResult = await atomicValidateOrCreateDeviceToken(
        {
          providedDeviceToken: null,
          userId: testUserId,
          deviceId: 'existing-device',
          platform: 'web',
          tokenVersion: 1,
        },
        utilities
      );

      expect(firstResult.isNew).toBe(true);
      const firstRecordId = firstResult.deviceTokenRecordId;

      // Now try again without providing the token (e.g., user cleared storage)
      const secondResult = await atomicValidateOrCreateDeviceToken(
        {
          providedDeviceToken: null,
          userId: testUserId,
          deviceId: 'existing-device',
          platform: 'web',
          tokenVersion: 1,
        },
        utilities
      );

      // Should reuse existing record but generate new token
      expect(secondResult.isNew).toBe(false);
      expect(secondResult.deviceTokenRecordId).toBe(firstRecordId);
      expect(secondResult.deviceToken).not.toBe(firstResult.deviceToken);
    });

    it('should atomically prevent duplicate token creation', async () => {
      // Simulate concurrent login attempts from same device
      const results = await Promise.all([
        atomicValidateOrCreateDeviceToken(
          {
            providedDeviceToken: null,
            userId: testUserId,
            deviceId: 'concurrent-device',
            platform: 'web',
            tokenVersion: 1,
          },
          utilities
        ),
        atomicValidateOrCreateDeviceToken(
          {
            providedDeviceToken: null,
            userId: testUserId,
            deviceId: 'concurrent-device',
            platform: 'web',
            tokenVersion: 1,
          },
          utilities
        ),
        atomicValidateOrCreateDeviceToken(
          {
            providedDeviceToken: null,
            userId: testUserId,
            deviceId: 'concurrent-device',
            platform: 'web',
            tokenVersion: 1,
          },
          utilities
        ),
      ]);

      // All should succeed
      results.forEach((r) => expect(r.deviceToken).toBeDefined());

      // But only ONE device token record should exist
      const records = await db.query.deviceTokens.findMany({
        where: eq(deviceTokens.userId, testUserId),
      });

      // Should have exactly 1 non-revoked record for this device
      const activeRecords = records.filter((r) => r.revokedAt === null);
      expect(activeRecords).toHaveLength(1);
    });
  });
});

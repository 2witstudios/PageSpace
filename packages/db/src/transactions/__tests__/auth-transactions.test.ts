/**
 * Auth Transactions Integration Tests
 *
 * These tests verify the atomic token operations with PostgreSQL FOR UPDATE locking.
 * Requires a running test database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db, deviceTokens, users, eq } from '../../index';
import { createHash } from 'crypto';
import { createId } from '@paralleldrive/cuid2';
import {
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

// Opaque token generator (matches new signature)
function generateDeviceToken(): string {
  return `ps_dev_${createId()}${createId()}`;
}

// Opaque token validator (replaces JWT payload decoder)
function validateOpaqueToken(token: string): boolean {
  return typeof token === 'string' && token.startsWith('ps_dev_') && token.length > 10;
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
    await db.delete(deviceTokens).where(eq(deviceTokens.userId, testUserId));
    await db.delete(users).where(eq(users.id, testUserId));
  });

  describe('atomicDeviceTokenRotation', () => {
    it('should successfully rotate device token', async () => {
      // Create a device token (now opaque format)
      const rawToken = generateDeviceToken();
      const tokenHash = hashToken(rawToken);

      await db.insert(deviceTokens).values({
        id: createId(),
        userId: testUserId,
        deviceId: 'device-1',
        platform: 'web',
        tokenHash,
        tokenPrefix: getTokenPrefix(rawToken),
        tokenVersion: 1, // Store tokenVersion in record (opaque tokens)
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
      expect(result.newToken?.startsWith('ps_dev_')).toBe(true);
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
      const rawToken = generateDeviceToken();
      const tokenHash = hashToken(rawToken);

      await db.insert(deviceTokens).values({
        id: createId(),
        userId: testUserId,
        deviceId: 'device-1',
        platform: 'web',
        tokenHash,
        tokenPrefix: getTokenPrefix(rawToken),
        tokenVersion: 1,
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

      // All should succeed due to grace period
      const successes = results.filter((r) => r.success);
      expect(successes.length).toBeGreaterThanOrEqual(1);

      // First use gets a new token, grace period retries don't
      const firstUse = successes.filter((r) => !r.gracePeriodRetry && r.newToken);
      const gracePeriodRetries = successes.filter((r) => r.gracePeriodRetry);
      expect(firstUse).toHaveLength(1);
      // Grace period retries should not have a new token
      gracePeriodRetries.forEach((r) => {
        expect(r.newToken).toBeUndefined();
        expect(r.gracePeriodRetry).toBe(true);
      });
    });

    describe('grace period handling', () => {
      it('should allow retry within 30 second grace period', async () => {
        const rawToken = generateDeviceToken();
        const tokenHash = hashToken(rawToken);

        await db.insert(deviceTokens).values({
          id: createId(),
          userId: testUserId,
          deviceId: 'device-1',
          platform: 'web',
          tokenHash,
          tokenPrefix: getTokenPrefix(rawToken),
          tokenVersion: 1,
          expiresAt: new Date(Date.now() + 86400000),
          deviceName: 'Test Device',
          trustScore: 1.0,
          suspiciousActivityCount: 0,
        });

        // First rotation - succeeds, revokes token
        const result1 = await atomicDeviceTokenRotation(
          rawToken,
          { userAgent: 'Test Agent' },
          hashToken,
          getTokenPrefix,
          generateDeviceToken
        );
        expect(result1.success).toBe(true);
        expect(result1.newToken).toBeDefined();
        expect(result1.gracePeriodRetry).toBeFalsy();

        // Immediate retry - should succeed (within grace period)
        const result2 = await atomicDeviceTokenRotation(
          rawToken,
          { userAgent: 'Test Agent' },
          hashToken,
          getTokenPrefix,
          generateDeviceToken
        );
        expect(result2.success).toBe(true);
        expect(result2.gracePeriodRetry).toBe(true);
        expect(result2.newToken).toBeUndefined(); // Client already has token from first request
        expect(result2.userId).toBe(testUserId);
        expect(result2.deviceId).toBe('device-1');
      });

      it('should reject retry after grace period expires', async () => {
        const rawToken = generateDeviceToken();
        const tokenHash = hashToken(rawToken);
        const tokenId = createId();
        const newTokenId = createId();

        // Create the original token (already revoked 60 seconds ago - well outside 30s grace period)
        const revokedAt = new Date(Date.now() - 60000);
        await db.insert(deviceTokens).values({
          id: tokenId,
          userId: testUserId,
          deviceId: 'device-1',
          platform: 'web',
          tokenHash,
          tokenPrefix: getTokenPrefix(rawToken),
          tokenVersion: 1,
          expiresAt: new Date(Date.now() + 86400000),
          trustScore: 1.0,
          suspiciousActivityCount: 0,
          revokedAt,
          revokedReason: 'rotated',
          replacedByTokenId: newTokenId,
        });

        // Create the replacement token (this is the active one)
        const newToken = generateDeviceToken();
        const newTokenHash = hashToken(newToken);
        await db.insert(deviceTokens).values({
          id: newTokenId,
          userId: testUserId,
          deviceId: 'device-1',
          platform: 'web',
          tokenHash: newTokenHash,
          tokenPrefix: getTokenPrefix(newToken),
          tokenVersion: 1,
          expiresAt: new Date(Date.now() + 86400000),
          trustScore: 1.0,
          suspiciousActivityCount: 0,
        });

        // Retry should fail - outside grace period
        const result = await atomicDeviceTokenRotation(
          rawToken,
          {},
          hashToken,
          getTokenPrefix,
          generateDeviceToken
        );
        expect(result.success).toBe(false);
        expect(result.error).toBe('Device token already rotated');
      });

      it('should reject retry when revoked for other reasons', async () => {
        const rawToken = generateDeviceToken();
        const tokenHash = hashToken(rawToken);
        const tokenId = createId();

        await db.insert(deviceTokens).values({
          id: tokenId,
          userId: testUserId,
          deviceId: 'device-1',
          platform: 'web',
          tokenHash,
          tokenPrefix: getTokenPrefix(rawToken),
          tokenVersion: 1,
          expiresAt: new Date(Date.now() + 86400000),
          trustScore: 1.0,
          suspiciousActivityCount: 0,
        });

        // Token revoked for logout - no grace period
        await db.update(deviceTokens)
          .set({ revokedAt: new Date(), revokedReason: 'logout' })
          .where(eq(deviceTokens.id, tokenId));

        const result = await atomicDeviceTokenRotation(
          rawToken,
          {},
          hashToken,
          getTokenPrefix,
          generateDeviceToken
        );
        expect(result.success).toBe(false);
        expect(result.error).toBe('Device token has been revoked');
      });

      it('should reject token when tokenVersion mismatch (logout all devices)', async () => {
        const rawToken = generateDeviceToken();
        const tokenHash = hashToken(rawToken);

        // Create token with tokenVersion 0
        await db.insert(deviceTokens).values({
          id: createId(),
          userId: testUserId,
          deviceId: 'device-1',
          platform: 'web',
          tokenHash,
          tokenPrefix: getTokenPrefix(rawToken),
          tokenVersion: 0, // Old tokenVersion
          expiresAt: new Date(Date.now() + 86400000),
          trustScore: 1.0,
          suspiciousActivityCount: 0,
        });

        // User's tokenVersion is 1 (set in beforeEach)
        // Token was created with tokenVersion 0
        // Should be rejected due to mismatch

        const result = await atomicDeviceTokenRotation(
          rawToken,
          {},
          hashToken,
          getTokenPrefix,
          generateDeviceToken
        );
        expect(result.success).toBe(false);
        expect(result.error).toBe('Device token invalidated by security policy');
      });
    });
  });

  describe('atomicValidateOrCreateDeviceToken', () => {
    const utilities = {
      hashToken,
      getTokenPrefix,
      generateDeviceToken,
      validateOpaqueToken,
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

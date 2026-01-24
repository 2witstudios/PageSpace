import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateDeviceToken,
  validateDeviceToken,
  createDeviceTokenRecord,
  updateDeviceTokenActivity,
  revokeDeviceToken,
  validateOrCreateDeviceToken,
} from '../auth/device-auth-utils';
import { isValidTokenFormat, getTokenType } from '../auth/opaque-tokens';
import { db, deviceTokens, eq } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';

describe('device-auth-utils', () => {
  const testUserId = 'user_test123';
  const testDeviceId = 'device_test456';
  const testPlatform = 'ios' as const;
  const testTokenVersion = 0;

  // Create test user before each test (required for foreign key constraint)
  beforeEach(async () => {
    const { users } = await import('@pagespace/db');
    await db.insert(users).values({
      id: testUserId,
      name: 'Test User',
      email: 'test@example.com',
      tokenVersion: 0,
      role: 'user',
    });
  });

  // Clean up test data after each test
  afterEach(async () => {
    await db.delete(deviceTokens).where(eq(deviceTokens.userId, testUserId));
    // Also clean up test user
    const { users } = await import('@pagespace/db');
    await db.delete(users).where(eq(users.id, testUserId));
  });

  describe('generateDeviceToken', () => {
    it('creates valid opaque device token (ps_dev_*)', () => {
      const token = generateDeviceToken();

      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(token.startsWith('ps_dev_')).toBe(true);
    });

    it('generates tokens with valid format', () => {
      const token = generateDeviceToken();

      expect(isValidTokenFormat(token)).toBe(true);
      expect(getTokenType(token)).toBe('dev');
    });

    it('generates unique tokens on each call', () => {
      const token1 = generateDeviceToken();
      const token2 = generateDeviceToken();
      const token3 = generateDeviceToken();

      expect(token1).not.toBe(token2);
      expect(token2).not.toBe(token3);
      expect(token1).not.toBe(token3);
    });
  });

  describe('createDeviceTokenRecord', () => {
    it('creates database record and returns opaque token', async () => {
      const result = await createDeviceTokenRecord(
        testUserId,
        testDeviceId,
        testPlatform,
        testTokenVersion,
        {
          deviceName: 'Test iPhone',
          userAgent: 'PageSpace/1.0 iOS/17.0',
          ipAddress: '192.168.1.1',
        }
      );

      expect(result.id).toBeTruthy();
      expect(result.token).toBeTruthy();
      expect(result.token.startsWith('ps_dev_')).toBe(true);

      // Verify database record
      const records = await db
        .select()
        .from(deviceTokens)
        .where(eq(deviceTokens.id, result.id));

      expect(records).toHaveLength(1);
      expect(records[0].userId).toBe(testUserId);
      expect(records[0].deviceId).toBe(testDeviceId);
      expect(records[0].platform).toBe(testPlatform);
      expect(records[0].deviceName).toBe('Test iPhone');
      expect(records[0].trustScore).toBe(1.0); // Initial trust score
      expect(records[0].tokenVersion).toBe(testTokenVersion); // tokenVersion stored in record
    });

    it('sets default trust score to 1.0', async () => {
      const result = await createDeviceTokenRecord(
        testUserId,
        testDeviceId,
        testPlatform,
        testTokenVersion
      );

      const records = await db
        .select()
        .from(deviceTokens)
        .where(eq(deviceTokens.id, result.id));

      expect(records[0].trustScore).toBe(1.0);
    });
  });

  describe('validateDeviceToken', () => {
    it('validates valid token and returns record', async () => {
      const { token } = await createDeviceTokenRecord(
        testUserId,
        testDeviceId,
        testPlatform,
        testTokenVersion
      );

      const validated = await validateDeviceToken(token);
      expect(validated).toBeTruthy();
      expect(validated?.userId).toBe(testUserId);
      expect(validated?.deviceId).toBe(testDeviceId);
    });

    it('rejects expired token', async () => {
      // Create token that's already expired (manually set expiration in past)
      const { id, token } = await createDeviceTokenRecord(
        testUserId,
        testDeviceId,
        testPlatform,
        testTokenVersion
      );

      // Manually update expiration to past
      const pastDate = new Date(Date.now() - 1000); // 1 second ago
      await db
        .update(deviceTokens)
        .set({ expiresAt: pastDate })
        .where(eq(deviceTokens.id, id));

      const validated = await validateDeviceToken(token);
      expect(validated).toBeNull();
    });

    it('rejects revoked token', async () => {
      const { id, token } = await createDeviceTokenRecord(
        testUserId,
        testDeviceId,
        testPlatform,
        testTokenVersion
      );

      // Revoke the token
      await revokeDeviceToken(id, 'user_action');

      const validated = await validateDeviceToken(token);
      expect(validated).toBeNull();
    });

    it('rejects token when user tokenVersion has been bumped', async () => {
      // Create a device token with tokenVersion 0 (user already created in beforeEach)
      const { token } = await createDeviceTokenRecord(
        testUserId,
        testDeviceId,
        testPlatform,
        0 // version 0
      );

      // Initially should validate successfully
      const initialValidation = await validateDeviceToken(token);
      expect(initialValidation).toBeTruthy();
      expect(initialValidation?.userId).toBe(testUserId);

      // Simulate user's tokenVersion being bumped to 1
      // (e.g., after password change or refresh token reuse detection)
      const { users } = await import('@pagespace/db');
      await db
        .update(users)
        .set({ tokenVersion: 1 })
        .where(eq(users.id, testUserId));

      // Now the device token should be rejected due to tokenVersion mismatch
      const validationAfterBump = await validateDeviceToken(token);
      expect(validationAfterBump).toBeNull();
    });

    it('rejects malformed token', async () => {
      const validated = await validateDeviceToken('invalid.token.here');
      expect(validated).toBeNull();
    });

    it('rejects JWT-format tokens (migration check)', async () => {
      // Old JWT tokens should be rejected since we now use opaque tokens
      const jwtLikeToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const validated = await validateDeviceToken(jwtLikeToken);
      expect(validated).toBeNull();
    });
  });

  describe('updateDeviceTokenActivity', () => {
    it('updates lastUsedAt timestamp', async () => {
      const { id } = await createDeviceTokenRecord(
        testUserId,
        testDeviceId,
        testPlatform,
        testTokenVersion
      );

      // Wait a moment to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      await updateDeviceTokenActivity(id, '192.168.1.2');

      const records = await db
        .select()
        .from(deviceTokens)
        .where(eq(deviceTokens.id, id));

      expect(records[0].lastUsedAt).toBeTruthy();
      expect(records[0].lastIpAddress).toBe('192.168.1.2');
    });

    it('handles missing IP address gracefully', async () => {
      const { id } = await createDeviceTokenRecord(
        testUserId,
        testDeviceId,
        testPlatform,
        testTokenVersion
      );

      await updateDeviceTokenActivity(id);

      const records = await db
        .select()
        .from(deviceTokens)
        .where(eq(deviceTokens.id, id));

      expect(records[0].lastUsedAt).toBeTruthy();
      expect(records[0].lastIpAddress).toBeNull();
    });
  });

  describe('validateOrCreateDeviceToken', () => {
    it('creates new token when none provided', async () => {
      const result = await validateOrCreateDeviceToken({
        providedDeviceToken: null,
        userId: testUserId,
        deviceId: testDeviceId,
        platform: testPlatform,
        tokenVersion: testTokenVersion,
        deviceName: 'Test Device',
        ipAddress: '192.168.1.1',
      });

      expect(result.deviceToken).toBeTruthy();
      expect(result.deviceTokenRecordId).toBeTruthy();
      expect(result.isNew).toBe(true);
    });

    it('validates and reuses existing valid token', async () => {
      const { token: existingToken } = await createDeviceTokenRecord(
        testUserId,
        testDeviceId,
        testPlatform,
        testTokenVersion
      );

      const result = await validateOrCreateDeviceToken({
        providedDeviceToken: existingToken,
        userId: testUserId,
        deviceId: testDeviceId,
        platform: testPlatform,
        tokenVersion: testTokenVersion,
      });

      expect(result.deviceToken).toBe(existingToken);
      expect(result.isNew).toBe(false);
    });

    it('creates new token when provided token is invalid', async () => {
      const result = await validateOrCreateDeviceToken({
        providedDeviceToken: 'invalid.token.value',
        userId: testUserId,
        deviceId: testDeviceId,
        platform: testPlatform,
        tokenVersion: testTokenVersion,
      });

      expect(result.deviceToken).toBeTruthy();
      expect(result.deviceToken).not.toBe('invalid.token.value');
      expect(result.isNew).toBe(true);
    });

    it('creates new token when userId mismatch', async () => {
      const { token: existingToken } = await createDeviceTokenRecord(
        testUserId,
        testDeviceId,
        testPlatform,
        testTokenVersion
      );

      // Create the different user that we're testing with
      const { users } = await import('@pagespace/db');
      await db.insert(users).values({
        id: 'different_user',
        name: 'Different User',
        email: 'different@example.com',
        tokenVersion: 0,
        role: 'user',
      });

      const result = await validateOrCreateDeviceToken({
        providedDeviceToken: existingToken,
        userId: 'different_user',
        deviceId: testDeviceId,
        platform: testPlatform,
        tokenVersion: testTokenVersion,
      });

      expect(result.deviceToken).not.toBe(existingToken);
      expect(result.isNew).toBe(true);

      // Clean up the different user
      await db.delete(users).where(eq(users.id, 'different_user'));
    });

    it('creates new token when deviceId mismatch', async () => {
      const { token: existingToken } = await createDeviceTokenRecord(
        testUserId,
        testDeviceId,
        testPlatform,
        testTokenVersion
      );

      const result = await validateOrCreateDeviceToken({
        providedDeviceToken: existingToken,
        userId: testUserId,
        deviceId: 'different_device',
        platform: testPlatform,
        tokenVersion: testTokenVersion,
      });

      expect(result.deviceToken).not.toBe(existingToken);
      expect(result.isNew).toBe(true);
    });

    it('creates new token when platform mismatch', async () => {
      const { token: existingToken } = await createDeviceTokenRecord(
        testUserId,
        testDeviceId,
        'ios' as const,
        testTokenVersion
      );

      const result = await validateOrCreateDeviceToken({
        providedDeviceToken: existingToken,
        userId: testUserId,
        deviceId: testDeviceId,
        platform: 'android' as const,
        tokenVersion: testTokenVersion,
      });

      expect(result.deviceToken).not.toBe(existingToken);
      expect(result.isNew).toBe(true);
    });

    it('updates activity when reusing valid token', async () => {
      const { id, token: existingToken } = await createDeviceTokenRecord(
        testUserId,
        testDeviceId,
        testPlatform,
        testTokenVersion,
        { ipAddress: '192.168.1.1' }
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      await validateOrCreateDeviceToken({
        providedDeviceToken: existingToken,
        userId: testUserId,
        deviceId: testDeviceId,
        platform: testPlatform,
        tokenVersion: testTokenVersion,
        ipAddress: '192.168.1.2',
      });

      const records = await db
        .select()
        .from(deviceTokens)
        .where(eq(deviceTokens.id, id));

      expect(records[0].lastIpAddress).toBe('192.168.1.2');
      expect(records[0].lastUsedAt).toBeTruthy();
    });
  });

  describe('revokeDeviceToken', () => {
    it('marks token as revoked with reason', async () => {
      const { id } = await createDeviceTokenRecord(
        testUserId,
        testDeviceId,
        testPlatform,
        testTokenVersion
      );

      await revokeDeviceToken(id, 'user_action');

      const records = await db
        .select()
        .from(deviceTokens)
        .where(eq(deviceTokens.id, id));

      expect(records[0].revokedAt).toBeTruthy();
      expect(records[0].revokedReason).toBe('user_action');
    });

    it('prevents further validation after revocation', async () => {
      const { id, token } = await createDeviceTokenRecord(
        testUserId,
        testDeviceId,
        testPlatform,
        testTokenVersion
      );

      await revokeDeviceToken(id, 'user_action');

      const validated = await validateDeviceToken(token);
      expect(validated).toBeNull();
    });
  });
});

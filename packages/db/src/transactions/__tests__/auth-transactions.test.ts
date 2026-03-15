/**
 * Auth Transactions Unit Tests (mocked DB)
 *
 * Tests atomic token operations without a real database connection.
 * All DB calls are mocked via vi.mock.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted mock for db.transaction
const mockExecute = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../../index', () => {
  // Build minimal sql tagged-template that captures call args
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values });
  return {
    db: { transaction: (...args: unknown[]) => mockTransaction(...args) },
    deviceTokens: {},
    users: {},
    eq: vi.fn(),
    sql,
  };
});

vi.mock('@paralleldrive/cuid2', () => ({
  createId: () => 'mock-cuid-id',
}));

import {
  atomicDeviceTokenRotation,
  atomicValidateOrCreateDeviceToken,
  type DeviceRotationResult,
  type AtomicDeviceTokenResult,
} from '../auth-transactions';

// Utility stubs
const hashToken = (t: string) => `hashed_${t}`;
const getTokenPrefix = (t: string) => t.substring(0, 12);
const generateDeviceToken = () => 'ps_dev_newtoken12345';
const validateOpaqueToken = (t: string) => t.startsWith('ps_dev_') && t.length > 10;

/**
 * Helper: make mockTransaction invoke the callback with a mock tx.
 * Returns the tx so individual tests can customise mockExecute per call.
 */
function setupTransaction() {
  const tx = { execute: mockExecute };
  mockTransaction.mockImplementation(async (cb: (t: { execute: typeof mockExecute }) => Promise<unknown>) => cb(tx));
  return tx;
}

describe('atomicDeviceTokenRotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupTransaction();
  });

  it('should return error when token not found in DB', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await atomicDeviceTokenRotation(
      'ps_dev_oldtoken',
      {},
      hashToken,
      getTokenPrefix,
      generateDeviceToken,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid or expired device token');
  });

  it('should return error when tokenVersion mismatch', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-1',
        userId: 'user-1',
        deviceId: 'dev-1',
        platform: 'web',
        deviceName: null,
        userAgent: null,
        lastIpAddress: null,
        location: null,
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: null,
        revokedReason: null,
        replacedByTokenId: null,
        deviceTokenVersion: 0,
        userTokenVersion: 1,
      }],
    });

    const result = await atomicDeviceTokenRotation(
      'ps_dev_oldtoken',
      {},
      hashToken,
      getTokenPrefix,
      generateDeviceToken,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Device token invalidated by security policy');
  });

  it('should allow grace period retry when token recently rotated', async () => {
    const revokedAt = new Date(Date.now() - 5000); // 5 seconds ago (within 30s grace)

    // First call: lock query returns rotated token
    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-1',
        userId: 'user-1',
        deviceId: 'dev-1',
        platform: 'web',
        deviceName: 'My Device',
        userAgent: 'Mozilla',
        lastIpAddress: '10.0.0.1',
        location: 'US',
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt,
        revokedReason: 'rotated',
        replacedByTokenId: 'dt-2',
        deviceTokenVersion: 1,
        userTokenVersion: 1,
      }],
    });

    // Second call: lookup replacement token
    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-2',
        deviceName: 'My Device',
        userAgent: 'Mozilla',
        location: 'US',
      }],
    });

    const result = await atomicDeviceTokenRotation(
      'ps_dev_oldtoken',
      {},
      hashToken,
      getTokenPrefix,
      generateDeviceToken,
    );

    expect(result.success).toBe(true);
    expect(result.gracePeriodRetry).toBe(true);
    expect(result.newToken).toBeUndefined();
    expect(result.userId).toBe('user-1');
    expect(result.deviceId).toBe('dev-1');
  });

  it('should reject when grace period expired', async () => {
    const revokedAt = new Date(Date.now() - 60000); // 60 seconds ago

    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-1',
        userId: 'user-1',
        deviceId: 'dev-1',
        platform: 'web',
        deviceName: null,
        userAgent: null,
        lastIpAddress: null,
        location: null,
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt,
        revokedReason: 'rotated',
        replacedByTokenId: 'dt-2',
        deviceTokenVersion: 1,
        userTokenVersion: 1,
      }],
    });

    const result = await atomicDeviceTokenRotation(
      'ps_dev_oldtoken',
      {},
      hashToken,
      getTokenPrefix,
      generateDeviceToken,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Device token already rotated');
  });

  it('should reject when replacement token not found within grace period', async () => {
    const revokedAt = new Date(Date.now() - 5000);

    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-1',
        userId: 'user-1',
        deviceId: 'dev-1',
        platform: 'web',
        deviceName: null,
        userAgent: null,
        lastIpAddress: null,
        location: null,
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt,
        revokedReason: 'rotated',
        replacedByTokenId: 'dt-2',
        deviceTokenVersion: 1,
        userTokenVersion: 1,
      }],
    });

    // Replacement token not found
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await atomicDeviceTokenRotation(
      'ps_dev_oldtoken',
      {},
      hashToken,
      getTokenPrefix,
      generateDeviceToken,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Device token already rotated');
  });

  it('should reject when token revoked for non-rotation reason', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-1',
        userId: 'user-1',
        deviceId: 'dev-1',
        platform: 'web',
        deviceName: null,
        userAgent: null,
        lastIpAddress: null,
        location: null,
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: new Date(),
        revokedReason: 'logout',
        replacedByTokenId: null,
        deviceTokenVersion: 1,
        userTokenVersion: 1,
      }],
    });

    const result = await atomicDeviceTokenRotation(
      'ps_dev_oldtoken',
      {},
      hashToken,
      getTokenPrefix,
      generateDeviceToken,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Device token has been revoked');
  });

  it('should reject when token expired', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-1',
        userId: 'user-1',
        deviceId: 'dev-1',
        platform: 'web',
        deviceName: null,
        userAgent: null,
        lastIpAddress: null,
        location: null,
        expiresAt: new Date(Date.now() - 86400000), // expired
        revokedAt: null,
        revokedReason: null,
        replacedByTokenId: null,
        deviceTokenVersion: 1,
        userTokenVersion: 1,
      }],
    });

    const result = await atomicDeviceTokenRotation(
      'ps_dev_oldtoken',
      {},
      hashToken,
      getTokenPrefix,
      generateDeviceToken,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Device token has expired');
  });

  it('should successfully rotate a valid token', async () => {
    // Lock query returns valid active token
    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-1',
        userId: 'user-1',
        deviceId: 'dev-1',
        platform: 'desktop',
        deviceName: 'My Laptop',
        userAgent: 'PageSpace Desktop',
        lastIpAddress: '10.0.0.1',
        location: 'New York',
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: null,
        revokedReason: null,
        replacedByTokenId: null,
        deviceTokenVersion: 1,
        userTokenVersion: 1,
      }],
    });

    // Revoke old token
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Insert new token
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await atomicDeviceTokenRotation(
      'ps_dev_oldtoken',
      { userAgent: 'New Agent', ipAddress: '10.0.0.2' },
      hashToken,
      getTokenPrefix,
      generateDeviceToken,
    );

    expect(result.success).toBe(true);
    expect(result.newToken).toBe('ps_dev_newtoken12345');
    expect(result.newTokenHash).toBe('hashed_ps_dev_newtoken12345');
    expect(result.userId).toBe('user-1');
    expect(result.deviceId).toBe('dev-1');
    expect(result.platform).toBe('desktop');
    expect(result.userAgent).toBe('New Agent');
    expect(result.location).toBe('New York');
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it('should use existing userAgent when metadata not provided', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-1',
        userId: 'user-1',
        deviceId: 'dev-1',
        platform: 'web',
        deviceName: null,
        userAgent: 'Old Agent',
        lastIpAddress: '1.2.3.4',
        location: null,
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: null,
        revokedReason: null,
        replacedByTokenId: null,
        deviceTokenVersion: 1,
        userTokenVersion: 1,
      }],
    });
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await atomicDeviceTokenRotation(
      'ps_dev_oldtoken',
      {}, // no metadata
      hashToken,
      getTokenPrefix,
      generateDeviceToken,
    );

    expect(result.success).toBe(true);
    expect(result.userAgent).toBe('Old Agent');
  });

  it('should handle revokedAt as string (raw SQL returns string timestamps)', async () => {
    // When using raw SQL, PostgreSQL may return timestamps as strings
    const revokedAtString = '2026-03-14 12:00:00' as unknown as Date;

    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-1',
        userId: 'user-1',
        deviceId: 'dev-1',
        platform: 'web',
        deviceName: null,
        userAgent: null,
        lastIpAddress: null,
        location: null,
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: revokedAtString,
        revokedReason: 'rotated',
        replacedByTokenId: 'dt-2',
        deviceTokenVersion: 1,
        userTokenVersion: 1,
      }],
    });

    const result = await atomicDeviceTokenRotation(
      'ps_dev_oldtoken',
      {},
      hashToken,
      getTokenPrefix,
      generateDeviceToken,
    );

    // The string timestamp from the past should be outside grace period
    expect(result.success).toBe(false);
    expect(result.error).toBe('Device token already rotated');
  });
});

describe('atomicValidateOrCreateDeviceToken', () => {
  const utilities = {
    hashToken,
    getTokenPrefix,
    generateDeviceToken,
    validateOpaqueToken,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setupTransaction();
  });

  it('should validate and return existing valid token', async () => {
    // Token lookup
    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-1',
        expiresAt: new Date(Date.now() + 86400000),
        userId: 'user-1',
        deviceId: 'dev-1',
        platform: 'web',
        tokenVersion: 1,
      }],
    });
    // Update lastUsedAt
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await atomicValidateOrCreateDeviceToken({
      providedDeviceToken: 'ps_dev_validtoken123',
      userId: 'user-1',
      deviceId: 'dev-1',
      platform: 'web',
      tokenVersion: 1,
    }, utilities);

    expect(result.isNew).toBe(false);
    expect(result.deviceToken).toBe('ps_dev_validtoken123');
    expect(result.deviceTokenRecordId).toBe('dt-1');
  });

  it('should skip validation for invalid token format and create new', async () => {
    // Lock user row
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    // Check existing active tokens
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Revoke expired tokens
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Insert new token
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await atomicValidateOrCreateDeviceToken({
      providedDeviceToken: 'invalid-format',
      userId: 'user-1',
      deviceId: 'dev-1',
      platform: 'web',
      tokenVersion: 1,
      deviceName: 'Test Device',
      userAgent: 'Test Agent',
      ipAddress: '10.0.0.1',
    }, utilities);

    expect(result.isNew).toBe(true);
    expect(result.deviceToken).toBe('ps_dev_newtoken12345');
  });

  it('should create new token when no providedDeviceToken', async () => {
    // Lock user row
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    // Check existing active
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Revoke expired
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Insert
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await atomicValidateOrCreateDeviceToken({
      providedDeviceToken: null,
      userId: 'user-1',
      deviceId: 'new-device',
      platform: 'desktop',
      tokenVersion: 1,
    }, utilities);

    expect(result.isNew).toBe(true);
    expect(result.deviceToken).toBe('ps_dev_newtoken12345');
    expect(result.deviceTokenRecordId).toBe('mock-cuid-id');
  });

  it('should regenerate token for existing active device record', async () => {
    // Lock user row
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    // Find existing active token
    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-existing',
        tokenHash: 'old-hash',
      }],
    });
    // Update token hash
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await atomicValidateOrCreateDeviceToken({
      providedDeviceToken: null,
      userId: 'user-1',
      deviceId: 'existing-device',
      platform: 'web',
      tokenVersion: 1,
      ipAddress: '10.0.0.1',
    }, utilities);

    expect(result.isNew).toBe(false);
    expect(result.deviceTokenRecordId).toBe('dt-existing');
    expect(result.deviceToken).toBe('ps_dev_newtoken12345');
  });

  it('should regenerate token for existing active device record when ipAddress is absent', async () => {
    // This exercises the `ipAddress || null` branch on line 385 where ipAddress is falsy.
    // Lock user row
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    // Find existing active token
    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-existing-no-ip',
        tokenHash: 'old-hash',
      }],
    });
    // Update token hash (COALESCE(null, "lastIpAddress") keeps the existing IP)
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await atomicValidateOrCreateDeviceToken({
      providedDeviceToken: null,
      userId: 'user-1',
      deviceId: 'existing-device-no-ip',
      platform: 'web',
      tokenVersion: 1,
      // intentionally no ipAddress - exercises the falsy branch of `ipAddress || null`
    }, utilities);

    expect(result.isNew).toBe(false);
    expect(result.deviceTokenRecordId).toBe('dt-existing-no-ip');
    expect(result.deviceToken).toBe('ps_dev_newtoken12345');
  });

  it('should fall through when DB record does not match expected claims', async () => {
    // Token lookup returns record with mismatched userId
    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-1',
        expiresAt: new Date(Date.now() + 86400000),
        userId: 'different-user',
        deviceId: 'dev-1',
        platform: 'web',
        tokenVersion: 1,
      }],
    });
    // Lock user row
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    // Check existing active
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Revoke expired
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Insert new
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await atomicValidateOrCreateDeviceToken({
      providedDeviceToken: 'ps_dev_validtoken123',
      userId: 'user-1',
      deviceId: 'dev-1',
      platform: 'web',
      tokenVersion: 1,
    }, utilities);

    expect(result.isNew).toBe(true);
  });

  it('should fall through when token is expired', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-1',
        expiresAt: new Date(Date.now() - 86400000), // expired
        userId: 'user-1',
        deviceId: 'dev-1',
        platform: 'web',
        tokenVersion: 1,
      }],
    });
    // Lock user
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Existing active
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Revoke expired
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Insert
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await atomicValidateOrCreateDeviceToken({
      providedDeviceToken: 'ps_dev_expiredtoken123',
      userId: 'user-1',
      deviceId: 'dev-1',
      platform: 'web',
      tokenVersion: 1,
    }, utilities);

    expect(result.isNew).toBe(true);
  });

  it('should fall through when tokenVersion mismatch', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        id: 'dt-1',
        expiresAt: new Date(Date.now() + 86400000),
        userId: 'user-1',
        deviceId: 'dev-1',
        platform: 'web',
        tokenVersion: 0, // mismatch
      }],
    });
    // Lock user
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Existing active
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Revoke expired
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Insert
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await atomicValidateOrCreateDeviceToken({
      providedDeviceToken: 'ps_dev_oldversiontoken',
      userId: 'user-1',
      deviceId: 'dev-1',
      platform: 'web',
      tokenVersion: 1,
    }, utilities);

    expect(result.isNew).toBe(true);
  });

  it('should create token without optional metadata', async () => {
    // Lock user
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // No existing active
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Revoke expired
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Insert
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await atomicValidateOrCreateDeviceToken({
      providedDeviceToken: null,
      userId: 'user-1',
      deviceId: 'dev-1',
      platform: 'ios',
      tokenVersion: 1,
      // No deviceName, userAgent, ipAddress
    }, utilities);

    expect(result.isNew).toBe(true);
    expect(result.deviceToken).toBe('ps_dev_newtoken12345');
  });

  it('should fall through when token not found in DB', async () => {
    // Token lookup returns no rows
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Lock user
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // No existing active
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Revoke expired
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // Insert
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await atomicValidateOrCreateDeviceToken({
      providedDeviceToken: 'ps_dev_notfoundtoken123',
      userId: 'user-1',
      deviceId: 'dev-1',
      platform: 'web',
      tokenVersion: 1,
    }, utilities);

    expect(result.isNew).toBe(true);
  });
});

describe('type exports', () => {
  it('should export DeviceRotationResult type', () => {
    const result: DeviceRotationResult = { success: true };
    expect(result.success).toBe(true);
  });

  it('should export AtomicDeviceTokenResult type', () => {
    const result: AtomicDeviceTokenResult = {
      deviceToken: 'test',
      deviceTokenRecordId: 'id',
      isNew: true,
    };
    expect(result.isNew).toBe(true);
  });
});

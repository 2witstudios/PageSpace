import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock security-redis before importing module under test
vi.mock('../../security/security-redis', () => ({
  recordJTI: vi.fn(),
  isJTIRevoked: vi.fn(),
  tryGetSecurityRedisClient: vi.fn(),
}));

// Mock cuid2 for predictable JTI values
const DEFAULT_JTI = 'test-jti-predictable-123';
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => DEFAULT_JTI),
}));

import {
  createServiceToken,
  verifyServiceToken,
  type ServiceTokenOptions,
} from '../service-auth';
import { recordJTI, isJTIRevoked, tryGetSecurityRedisClient } from '../../security/security-redis';
import { createId } from '@paralleldrive/cuid2';

/**
 * Service Auth JTI Integration Tests (P1-T1)
 *
 * Tests the integration of JTI (JWT ID) tracking into the service token lifecycle:
 * - JTI recording on token creation
 * - JTI validation on token verification
 * - Graceful degradation when Redis unavailable
 */
describe('service-auth JTI integration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Set required environment variables
    process.env.SERVICE_JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
    process.env.JWT_ISSUER = 'test-issuer';
    process.env.NODE_ENV = 'test';
    vi.clearAllMocks();
    // Reset createId mock to default behavior
    vi.mocked(createId).mockReturnValue(DEFAULT_JTI);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const validOptions: ServiceTokenOptions = {
    service: 'test-service',
    subject: 'user-123',
    scopes: ['files:read'],
  };

  describe('createServiceToken JTI recording', () => {
    it('records JTI when Redis available', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue({} as never);

      await createServiceToken(validOptions);

      expect(recordJTI).toHaveBeenCalledWith(
        'test-jti-predictable-123',
        'user-123',
        300 // 5 minutes default expiry
      );
    });

    it('JTI expiration matches token expiration (5m default = 300s)', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue({} as never);

      await createServiceToken(validOptions);

      expect(recordJTI).toHaveBeenCalledWith(
        expect.any(String),
        'user-123',
        300
      );
    });

    it('JTI expiration matches custom token expiration (1h = 3600s)', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue({} as never);

      await createServiceToken({ ...validOptions, expiresIn: '1h' });

      expect(recordJTI).toHaveBeenCalledWith(
        expect.any(String),
        'user-123',
        3600
      );
    });

    it('JTI expiration matches custom token expiration (30s)', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue({} as never);

      await createServiceToken({ ...validOptions, expiresIn: '30s' });

      expect(recordJTI).toHaveBeenCalledWith(
        expect.any(String),
        'user-123',
        30
      );
    });

    it('JTI expiration matches custom token expiration (7d)', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue({} as never);

      await createServiceToken({ ...validOptions, expiresIn: '7d' });

      expect(recordJTI).toHaveBeenCalledWith(
        expect.any(String),
        'user-123',
        7 * 24 * 60 * 60 // 7 days in seconds
      );
    });

    it('token creation succeeds when Redis unavailable (graceful degradation)', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null);

      const token = await createServiceToken(validOptions);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(recordJTI).not.toHaveBeenCalled();
    });

    it('token creation succeeds when recordJTI throws (graceful degradation)', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue({} as never);
      vi.mocked(recordJTI).mockRejectedValue(new Error('Redis error'));

      const token = await createServiceToken(validOptions);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
    });

    it('each token gets a unique JTI', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue({} as never);
      let callCount = 0;
      vi.mocked(createId).mockImplementation(() => `jti-${++callCount}`);

      await createServiceToken(validOptions);
      await createServiceToken(validOptions);

      expect(recordJTI).toHaveBeenNthCalledWith(1, 'jti-1', 'user-123', 300);
      expect(recordJTI).toHaveBeenNthCalledWith(2, 'jti-2', 'user-123', 300);
    });
  });

  describe('verifyServiceToken JTI validation', () => {
    let validToken: string;

    beforeEach(async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue({} as never);
      vi.mocked(isJTIRevoked).mockResolvedValue(false);
      validToken = await createServiceToken(validOptions);
      vi.clearAllMocks();
    });

    it('checks JTI revocation status when Redis available', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue({} as never);
      vi.mocked(isJTIRevoked).mockResolvedValue(false);

      await verifyServiceToken(validToken);

      expect(isJTIRevoked).toHaveBeenCalledWith('test-jti-predictable-123');
    });

    it('verification succeeds when JTI is valid (not revoked)', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue({} as never);
      vi.mocked(isJTIRevoked).mockResolvedValue(false);

      const claims = await verifyServiceToken(validToken);

      expect(claims).toBeDefined();
      expect(claims.sub).toBe('user-123');
      expect(claims.service).toBe('test-service');
    });

    it('verification fails when JTI is revoked', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue({} as never);
      vi.mocked(isJTIRevoked).mockResolvedValue(true);

      await expect(verifyServiceToken(validToken)).rejects.toThrow(
        /Token revoked or invalid/
      );
    });

    it('verification fails when JTI not in Redis (fail-closed)', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue({} as never);
      // isJTIRevoked returns true when JTI is not found (fail-closed behavior)
      vi.mocked(isJTIRevoked).mockResolvedValue(true);

      await expect(verifyServiceToken(validToken)).rejects.toThrow(
        /Token revoked or invalid/
      );
    });

    it('verification succeeds when Redis unavailable in development', async () => {
      process.env.NODE_ENV = 'development';
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null);

      const claims = await verifyServiceToken(validToken);

      expect(claims).toBeDefined();
      expect(isJTIRevoked).not.toHaveBeenCalled();
    });

    it('verification succeeds when Redis unavailable in test environment', async () => {
      process.env.NODE_ENV = 'test';
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null);

      const claims = await verifyServiceToken(validToken);

      expect(claims).toBeDefined();
      expect(isJTIRevoked).not.toHaveBeenCalled();
    });

    it('verification FAILS when Redis unavailable in production', async () => {
      process.env.NODE_ENV = 'production';
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null);

      await expect(verifyServiceToken(validToken)).rejects.toThrow(
        /Security infrastructure unavailable/
      );
    });

    it('verification fails when isJTIRevoked throws (fail-closed)', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue({} as never);
      vi.mocked(isJTIRevoked).mockRejectedValue(new Error('Redis error'));

      await expect(verifyServiceToken(validToken)).rejects.toThrow();
    });
  });

  describe('end-to-end token lifecycle', () => {
    it('create then verify - JTI flows through correctly', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue({} as never);
      vi.mocked(isJTIRevoked).mockResolvedValue(false);

      const token = await createServiceToken(validOptions);

      expect(recordJTI).toHaveBeenCalledTimes(1);

      const claims = await verifyServiceToken(token);

      expect(isJTIRevoked).toHaveBeenCalledTimes(1);
      expect(claims.jti).toBe('test-jti-predictable-123');
    });

    it('revoked token cannot be verified', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue({} as never);

      // Token creation - JTI recorded
      vi.mocked(isJTIRevoked).mockResolvedValue(false);
      const token = await createServiceToken(validOptions);

      // Token revoked in Redis
      vi.mocked(isJTIRevoked).mockResolvedValue(true);

      // Verification should fail
      await expect(verifyServiceToken(token)).rejects.toThrow(
        /Token revoked or invalid/
      );
    });
  });

  describe('backward compatibility', () => {
    it('token format unchanged (still valid JWT)', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null); // No Redis

      const token = await createServiceToken(validOptions);

      // Should be a valid JWT format: header.payload.signature
      const parts = token.split('.');
      expect(parts).toHaveLength(3);

      // Decode payload (base64url)
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString()
      );
      expect(payload.sub).toBe('user-123');
      expect(payload.service).toBe('test-service');
      expect(payload.jti).toBeDefined();
      expect(payload.tokenType).toBe('service');
    });

    it('existing token validation still works without JTI check when Redis unavailable', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null);

      const token = await createServiceToken(validOptions);
      const claims = await verifyServiceToken(token);

      expect(claims.sub).toBe('user-123');
      expect(claims.service).toBe('test-service');
    });
  });
});

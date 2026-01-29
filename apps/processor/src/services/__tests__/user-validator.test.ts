import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * User Validator Unit Tests (P1-T2)
 *
 * Validates that service tokens are only accepted for users who still exist
 * in the database.
 *
 * Note: Token version validation is not performed because service tokens are
 * short-lived and use JTI for security.
 */

// Mock the database module
vi.mock('@pagespace/db', () => {
  const mockDb = {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
  };
  return {
    db: mockDb,
    users: { id: 'id' },
    eq: vi.fn((field, value) => ({ field, value, op: 'eq' })),
  };
});

// Import after mocking
import { db } from '@pagespace/db';
import { validateServiceUser, type ServiceUserValidationResult } from '../user-validator';

describe('validateServiceUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('given a valid userId', () => {
    it('should return validated user object', async () => {
      const mockUser = {
        id: 'user-123',
        name: 'Test User',
        email: 'test@example.com',
        role: 'user' as const,
        provider: 'email' as const,
        subscriptionTier: 'free',
        createdAt: new Date(),
        updatedAt: new Date(),
        emailVerified: null,
        image: null,
        password: null,
        googleId: null,
        appleId: null,
        tokenVersion: 0,
        adminRoleVersion: 0,
        storageUsedBytes: 0,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        tosAcceptedAt: null,
        currentAiProvider: 'pagespace',
        currentAiModel: 'glm-4.5-air',
        activeUploads: 0,
        lastStorageCalculated: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      };

      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser);

      const result = await validateServiceUser('user-123');

      expect(result).toEqual({
        valid: true,
        userId: 'user-123',
        role: 'user',
      } satisfies ServiceUserValidationResult);
      expect(db.query.users.findFirst).toHaveBeenCalledTimes(1);
    });
  });

  describe('given a non-existent userId', () => {
    it('should return invalid result with reason', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

      const result = await validateServiceUser('nonexistent-user');

      expect(result).toEqual({
        valid: false,
        reason: 'user_not_found',
      } satisfies ServiceUserValidationResult);
    });
  });

  describe('given empty userId', () => {
    it('should return invalid without database query', async () => {
      const result = await validateServiceUser('');

      expect(result).toEqual({
        valid: false,
        reason: 'invalid_input',
      } satisfies ServiceUserValidationResult);
      expect(db.query.users.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('given whitespace userId', () => {
    it('should return invalid without database query', async () => {
      const result = await validateServiceUser('   ');

      expect(result).toEqual({
        valid: false,
        reason: 'invalid_input',
      } satisfies ServiceUserValidationResult);
      expect(db.query.users.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('given database error', () => {
    it('should return invalid result with error reason', async () => {
      vi.mocked(db.query.users.findFirst).mockRejectedValue(new Error('Connection failed'));

      const result = await validateServiceUser('user-123');

      expect(result).toEqual({
        valid: false,
        reason: 'database_error',
      } satisfies ServiceUserValidationResult);
    });
  });

  describe('given admin user', () => {
    it('should return validated user with admin role', async () => {
      const mockUser = {
        id: 'admin-123',
        name: 'Admin User',
        email: 'admin@example.com',
        role: 'admin' as const,
        provider: 'email' as const,
        subscriptionTier: 'pro',
        createdAt: new Date(),
        updatedAt: new Date(),
        emailVerified: new Date(),
        image: null,
        password: null,
        googleId: null,
        appleId: null,
        tokenVersion: 0,
        adminRoleVersion: 0,
        storageUsedBytes: 0,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        tosAcceptedAt: null,
        currentAiProvider: 'pagespace',
        currentAiModel: 'glm-4.5-air',
        activeUploads: 0,
        lastStorageCalculated: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      };

      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser);

      const result = await validateServiceUser('admin-123');

      expect(result).toEqual({
        valid: true,
        userId: 'admin-123',
        role: 'admin',
      } satisfies ServiceUserValidationResult);
    });
  });
});

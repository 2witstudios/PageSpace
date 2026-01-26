import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(),
        })),
      })),
    })),
  },
  users: {
    id: 'id',
    email: 'email',
    failedLoginAttempts: 'failedLoginAttempts',
    lockedUntil: 'lockedUntil',
  },
  eq: vi.fn((field, value) => ({ field, value })),
}));

// Mock the logger
vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

import { db } from '@pagespace/db';
import {
  getAccountLockoutStatus,
  isAccountLockedByEmail,
  recordFailedLoginAttempt,
  recordFailedLoginAttemptByEmail,
  resetFailedLoginAttempts,
  unlockAccount,
  LOCKOUT_CONFIG,
} from '../account-lockout';

describe('account-lockout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('LOCKOUT_CONFIG', () => {
    it('has 10 max failed attempts', () => {
      expect(LOCKOUT_CONFIG.MAX_FAILED_ATTEMPTS).toBe(10);
    });

    it('has 15 minute lockout duration', () => {
      expect(LOCKOUT_CONFIG.LOCKOUT_DURATION_MS).toBe(15 * 60 * 1000);
    });
  });

  describe('getAccountLockoutStatus', () => {
    it('returns not locked for non-existent user', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

      const status = await getAccountLockoutStatus('non-existent-user');

      expect(status.isLocked).toBe(false);
      expect(status.failedAttempts).toBe(0);
      expect(status.remainingAttempts).toBe(10);
    });

    it('returns not locked when lockedUntil is null', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        failedLoginAttempts: 3,
        lockedUntil: null,
      });

      const status = await getAccountLockoutStatus('user-123');

      expect(status.isLocked).toBe(false);
      expect(status.failedAttempts).toBe(3);
      expect(status.remainingAttempts).toBe(7);
    });

    it('returns not locked when lockedUntil is in the past', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        failedLoginAttempts: 10,
        lockedUntil: new Date(Date.now() - 1000), // 1 second ago
      });

      const status = await getAccountLockoutStatus('user-123');

      expect(status.isLocked).toBe(false);
    });

    it('returns locked when lockedUntil is in the future', async () => {
      const futureDate = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        failedLoginAttempts: 10,
        lockedUntil: futureDate,
      });

      const status = await getAccountLockoutStatus('user-123');

      expect(status.isLocked).toBe(true);
      expect(status.lockedUntil).toEqual(futureDate);
      expect(status.remainingAttempts).toBe(0);
    });
  });

  describe('isAccountLockedByEmail', () => {
    it('returns not locked for non-existent user', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

      const result = await isAccountLockedByEmail('nonexistent@example.com');

      expect(result.isLocked).toBe(false);
      expect(result.lockedUntil).toBeNull();
    });

    it('returns locked status based on lockedUntil', async () => {
      const futureDate = new Date(Date.now() + 10 * 60 * 1000);
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        lockedUntil: futureDate,
      });

      const result = await isAccountLockedByEmail('locked@example.com');

      expect(result.isLocked).toBe(true);
      expect(result.lockedUntil).toEqual(futureDate);
    });
  });

  describe('recordFailedLoginAttempt', () => {
    it('increments failed attempts', async () => {
      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              failedLoginAttempts: 5,
              email: 'test@example.com',
            }]),
          }),
        }),
      });
      vi.mocked(db.update).mockImplementation(mockUpdate);

      const result = await recordFailedLoginAttempt('user-123');

      expect(result.success).toBe(true);
      expect(result.lockedUntil).toBeUndefined();
    });

    it('returns error for non-existent user', async () => {
      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });
      vi.mocked(db.update).mockImplementation(mockUpdate);

      const result = await recordFailedLoginAttempt('non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('User not found');
    });

    it('locks account when reaching threshold', async () => {
      const mockSetForLock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      const mockUpdate = vi.fn()
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{
                failedLoginAttempts: 10, // At threshold
                email: 'test@example.com',
              }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          set: mockSetForLock,
        });
      vi.mocked(db.update).mockImplementation(mockUpdate);

      const result = await recordFailedLoginAttempt('user-123');

      expect(result.success).toBe(true);
      expect(result.lockedUntil).toBeDefined();
      expect(result.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('recordFailedLoginAttemptByEmail', () => {
    it('returns success for non-existent user (no information leak)', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

      const result = await recordFailedLoginAttemptByEmail('nonexistent@example.com');

      expect(result.success).toBe(true);
    });

    it('records attempt for existing user', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({ id: 'user-123' });
      const mockUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              failedLoginAttempts: 1,
              email: 'test@example.com',
            }]),
          }),
        }),
      });
      vi.mocked(db.update).mockImplementation(mockUpdate);

      const result = await recordFailedLoginAttemptByEmail('test@example.com');

      expect(result.success).toBe(true);
    });
  });

  describe('resetFailedLoginAttempts', () => {
    it('resets attempts and clears lockedUntil', async () => {
      const mockSet = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      vi.mocked(db.update).mockReturnValue({
        set: mockSet,
      } as never);

      await resetFailedLoginAttempts('user-123');

      expect(mockSet).toHaveBeenCalledWith({
        failedLoginAttempts: 0,
        lockedUntil: null,
      });
    });
  });

  describe('unlockAccount', () => {
    it('returns true on success', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as never);

      const result = await unlockAccount('user-123');

      expect(result).toBe(true);
    });

    it('returns false on error', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      } as never);

      const result = await unlockAccount('user-123');

      expect(result).toBe(false);
    });
  });
});

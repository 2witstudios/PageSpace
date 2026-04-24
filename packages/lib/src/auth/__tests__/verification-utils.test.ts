/**
 * @scaffold - ORM chain mocks present (insert().values(), delete().where(),
 * update().set().where(), select().from().where().limit()).
 * Pending verification-repository seam extraction for full rubric compliance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @pagespace/db
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      verificationTokens: { findFirst: vi.fn() },
    },
    insert: vi.fn(() => ({ values: vi.fn() })),
    delete: vi.fn(() => ({ where: vi.fn() })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(),
        })),
      })),
    })),
  },
  verificationTokens: {
    userId: 'userId',
    tokenHash: 'tokenHash',
    type: 'type',
    usedAt: 'usedAt',
    id: 'id',
  },
  users: {
    id: 'id',
    emailVerified: 'emailVerified',
  },
  eq: vi.fn((_f, _v) => ({ _f, _v })),
  and: vi.fn((...args: unknown[]) => args),
  isNull: vi.fn((f) => ({ isNull: f })),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));

import {
  createVerificationToken,
  verifyToken,
  markEmailVerified,
  isEmailVerified,
} from '../verification-utils';
import { db, verificationTokens, users } from '@pagespace/db';

describe('verification-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createVerificationToken', () => {
    it('should generate a token and store its hash', async () => {
      const mockDelete = vi.fn();
      const mockInsertValues = vi.fn();
      vi.mocked(db.delete).mockReturnValue({ where: mockDelete } as never);
      vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);

      const token = await createVerificationToken({
        userId: 'user-1',
        type: 'email_verification',
      });

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.length).toBe(64); // 32 bytes hex
      expect(db.delete).toHaveBeenCalledWith(verificationTokens);
      expect(db.insert).toHaveBeenCalledWith(verificationTokens);
    });

    it('should use 1440 minutes expiry for email_verification', async () => {
      const mockDelete = vi.fn();
      const mockInsertValues = vi.fn();
      vi.mocked(db.delete).mockReturnValue({ where: mockDelete } as never);
      vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);

      await createVerificationToken({
        userId: 'user-1',
        type: 'email_verification',
      });

      const insertCall = mockInsertValues.mock.calls[0][0];
      const expiresAt = insertCall.expiresAt as Date;
      const expectedExpiry = Date.now() + 1440 * 60 * 1000;
      expect(Math.abs(expiresAt.getTime() - expectedExpiry)).toBeLessThan(5000);
    });

    it('should use custom expiresInMinutes when provided', async () => {
      const mockDelete = vi.fn();
      const mockInsertValues = vi.fn();
      vi.mocked(db.delete).mockReturnValue({ where: mockDelete } as never);
      vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);

      await createVerificationToken({
        userId: 'user-1',
        type: 'email_verification',
        expiresInMinutes: 30,
      });

      const insertCall = mockInsertValues.mock.calls[0][0];
      const expiresAt = insertCall.expiresAt as Date;
      const expectedExpiry = Date.now() + 30 * 60 * 1000;
      expect(Math.abs(expiresAt.getTime() - expectedExpiry)).toBeLessThan(5000);
    });
  });

  describe('verifyToken', () => {
    it('should return null when token not found', async () => {
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue(undefined as never);
      const result = await verifyToken('nonexistent', 'email_verification');
      expect(result).toBeNull();
    });

    it('should return null when token already used', async () => {
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue({
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
        type: 'email_verification',
        userId: 'user-1',
        id: 'token-1',
        tokenHash: 'hash',
      } as never);

      const result = await verifyToken('some-token', 'email_verification');
      expect(result).toBeNull();
    });

    it('should return null when token expired', async () => {
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue({
        usedAt: null,
        expiresAt: new Date(Date.now() - 60000), // expired
        type: 'email_verification',
        userId: 'user-1',
        id: 'token-1',
        tokenHash: 'hash',
      } as never);

      const result = await verifyToken('some-token', 'email_verification');
      expect(result).toBeNull();
    });

    it('should return null when token type does not match', async () => {
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue({
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        type: 'magic_link',
        userId: 'user-1',
        id: 'token-1',
        tokenHash: 'hash',
      } as never);

      const result = await verifyToken('some-token', 'email_verification');
      expect(result).toBeNull();
    });

    it('should return userId and mark token as used when valid', async () => {
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue({
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        type: 'email_verification',
        userId: 'user-1',
        id: 'token-1',
        tokenHash: 'hash',
      } as never);

      const mockSet = vi.fn(() => ({ where: vi.fn() }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

      const result = await verifyToken('some-token', 'email_verification');
      expect(result).toBe('user-1');
      expect(db.update).toHaveBeenCalledWith(verificationTokens);
    });
  });

  describe('markEmailVerified', () => {
    it('should update user emailVerified field', async () => {
      const mockWhere = vi.fn();
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

      await markEmailVerified('user-1');
      expect(db.update).toHaveBeenCalledWith(users);
      const setArg = (mockSet.mock.calls as unknown[][])[0][0] as { emailVerified: unknown };
      expect(setArg.emailVerified).toBeInstanceOf(Date);
      expect(Object.keys(setArg)).toEqual(['emailVerified']);
    });
  });

  describe('isEmailVerified', () => {
    it('should return true when emailVerified is set', async () => {
      const mockLimit = vi.fn().mockResolvedValue([{ emailVerified: new Date() }]);
      const mockWhere = vi.fn(() => ({ limit: mockLimit }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const result = await isEmailVerified('user-1');
      expect(result).toBe(true);
    });

    it('should return false when emailVerified is null', async () => {
      const mockLimit = vi.fn().mockResolvedValue([{ emailVerified: null }]);
      const mockWhere = vi.fn(() => ({ limit: mockLimit }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const result = await isEmailVerified('user-1');
      expect(result).toBe(false);
    });

    it('should return false when user not found', async () => {
      const mockLimit = vi.fn().mockResolvedValue([]);
      const mockWhere = vi.fn(() => ({ limit: mockLimit }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      const result = await isEmailVerified('nonexistent');
      expect(result).toBe(false);
    });
  });
});

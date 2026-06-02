/**
 * @scaffold - ORM chain mocks present (insert().values(), delete().where(),
 * update().set().where(), select().from().where().limit()).
 * Pending verification-repository seam extraction for full rubric compliance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
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
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  verificationTokens: {
    userId: 'userId',
    tokenHash: 'tokenHash',
    type: 'type',
    usedAt: 'usedAt',
    id: 'id',
  },
  users: {
    id: 'id',
    email: 'email',
    emailVerified: 'emailVerified',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
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
  markEmailVerifiedForAddress,
  isEmailVerified,
} from '../verification-utils';
import { db } from '@pagespace/db/db';
import { verificationTokens, users } from '@pagespace/db/schema/auth';

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

    it('binds the token to a normalized email in metadata when provided', async () => {
      const mockDelete = vi.fn();
      const mockInsertValues = vi.fn();
      vi.mocked(db.delete).mockReturnValue({ where: mockDelete } as never);
      vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);

      await createVerificationToken({
        userId: 'user-1',
        type: 'email_verification',
        email: 'User@Example.COM',
      });

      const insertCall = mockInsertValues.mock.calls[0][0];
      expect(insertCall.metadata).toBe(JSON.stringify({ email: 'user@example.com' }));
    });

    it('stores null metadata when no email is bound', async () => {
      const mockDelete = vi.fn();
      const mockInsertValues = vi.fn();
      vi.mocked(db.delete).mockReturnValue({ where: mockDelete } as never);
      vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);

      await createVerificationToken({ userId: 'user-1', type: 'email_verification' });

      const insertCall = mockInsertValues.mock.calls[0][0];
      expect(insertCall.metadata).toBeNull();
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

    it('should return userId + metadata and mark token as used when valid', async () => {
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue({
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        type: 'email_verification',
        userId: 'user-1',
        id: 'token-1',
        tokenHash: 'hash',
        metadata: JSON.stringify({ email: 'user@example.com' }),
      } as never);

      // Atomic claim: update().set().where().returning() -> [{ id }]
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'token-1' }]);
      const mockWhere = vi.fn(() => ({ returning: mockReturning }));
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

      const result = await verifyToken('some-token', 'email_verification');
      expect(result).toEqual({ userId: 'user-1', metadata: JSON.stringify({ email: 'user@example.com' }) });
      expect(db.update).toHaveBeenCalledWith(verificationTokens);
    });

    it('should return null when the atomic claim is lost (already consumed)', async () => {
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue({
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        type: 'email_verification',
        userId: 'user-1',
        id: 'token-1',
        tokenHash: 'hash',
        metadata: null,
      } as never);

      // returning() resolves empty -> another request won the race
      const mockReturning = vi.fn().mockResolvedValue([]);
      const mockWhere = vi.fn(() => ({ returning: mockReturning }));
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

      const result = await verifyToken('some-token', 'email_verification');
      expect(result).toBeNull();
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

  describe('markEmailVerifiedForAddress', () => {
    it('returns true and marks verified when the address still matches', async () => {
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'user-1' }]);
      const mockWhere = vi.fn(() => ({ returning: mockReturning }));
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

      const result = await markEmailVerifiedForAddress('user-1', 'User@Example.com');

      expect(result).toBe(true);
      expect(db.update).toHaveBeenCalledWith(users);
      const setArg = (mockSet.mock.calls as unknown[][])[0][0] as { emailVerified: unknown };
      expect(setArg.emailVerified).toBeInstanceOf(Date);
    });

    it('returns false when the address no longer matches (no row updated)', async () => {
      const mockReturning = vi.fn().mockResolvedValue([]);
      const mockWhere = vi.fn(() => ({ returning: mockReturning }));
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

      const result = await markEmailVerifiedForAddress('user-1', 'changed@example.com');

      expect(result).toBe(false);
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

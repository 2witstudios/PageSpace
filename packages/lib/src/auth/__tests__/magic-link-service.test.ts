import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      verificationTokens: { findFirst: vi.fn() },
      users: { findFirst: vi.fn() },
    },
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
    delete: vi.fn(() => ({ where: vi.fn() })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(),
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(),
      })),
    })),
  },
  users: { id: 'id', email: 'email' },
  verificationTokens: { userId: 'userId', tokenHash: 'tokenHash', type: 'type', usedAt: 'usedAt', id: 'id' },
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid'),
}));

vi.mock('../token-utils', () => ({
  generateToken: vi.fn(() => ({
    token: 'ps_magic_testtoken123',
    hash: 'hashed_token',
    tokenPrefix: 'ps_magic_te',
  })),
  hashToken: vi.fn((t: string) => `hashed_${t}`),
  getTokenPrefix: vi.fn(() => 'prefix'),
}));

vi.mock('../secure-compare', () => ({
  secureCompare: vi.fn(() => true),
}));

import { createMagicLinkToken, verifyMagicLinkToken, MAGIC_LINK_EXPIRY_MINUTES } from '../magic-link-service';
import { db } from '@pagespace/db';
import { secureCompare } from '../secure-compare';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export MAGIC_LINK_EXPIRY_MINUTES as 5', () => {
    expect(MAGIC_LINK_EXPIRY_MINUTES).toBe(5);
  });

  describe('createMagicLinkToken', () => {
    it('should return validation error for invalid email', async () => {
      const result = await createMagicLinkToken({ email: 'not-an-email' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('should return validation error for missing email', async () => {
      const result = await createMagicLinkToken({});
      expect(result.ok).toBe(false);
    });

    it('should return USER_SUSPENDED for suspended user', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        suspendedAt: new Date(),
      } as never);

      const result = await createMagicLinkToken({ email: 'user@test.com' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('USER_SUSPENDED');
      }
    });

    it('should create token for existing user', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        suspendedAt: null,
      } as never);
      const mockDelete = vi.fn();
      vi.mocked(db.delete).mockReturnValue({ where: mockDelete } as never);
      const mockValues = vi.fn();
      vi.mocked(db.insert).mockReturnValue({ values: mockValues } as never);

      const result = await createMagicLinkToken({ email: 'user@test.com' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.token).toBe('ps_magic_testtoken123');
        expect(result.data.userId).toBe('user-1');
        expect(result.data.isNewUser).toBe(false);
      }
    });

    it('should create new user when email not found', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'new-user-1' }]);
      const mockValues = vi.fn(() => ({ returning: mockReturning }));
      vi.mocked(db.insert).mockReturnValue({ values: mockValues } as never);
      vi.mocked(db.delete).mockReturnValue({ where: vi.fn() } as never);

      const result = await createMagicLinkToken({ email: 'new@test.com' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.isNewUser).toBe(true);
      }
    });

    it('should handle unique constraint violation (race condition)', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);
      const mockReturning = vi.fn().mockRejectedValue(new Error('unique constraint'));
      const mockValues = vi.fn(() => ({ returning: mockReturning }));
      // First call: insert fails, second call: select finds user, third call: delete, fourth: insert token
      let insertCallCount = 0;
      vi.mocked(db.insert).mockImplementation(() => {
        insertCallCount++;
        if (insertCallCount === 1) {
          return { values: mockValues } as never;
        }
        return { values: vi.fn() } as never;
      });
      const mockWhere = vi.fn().mockResolvedValue([{ id: 'existing-user' }]);
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);
      vi.mocked(db.delete).mockReturnValue({ where: vi.fn() } as never);

      const result = await createMagicLinkToken({ email: 'race@test.com' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.isNewUser).toBe(false);
      }
    });
  });

  describe('verifyMagicLinkToken', () => {
    it('should return validation error for invalid token format', async () => {
      const result = await verifyMagicLinkToken({ token: 'bad-token' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('should return TOKEN_NOT_FOUND when record not found', async () => {
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue(undefined as never);
      const result = await verifyMagicLinkToken({ token: 'ps_magic_validtoken' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TOKEN_NOT_FOUND');
      }
    });

    it('should return TOKEN_NOT_FOUND for wrong type', async () => {
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue({
        type: 'email_verification',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        userId: 'user-1',
        user: { id: 'user-1', suspendedAt: null, emailVerified: null },
        tokenHash: 'hash',
      } as never);

      const result = await verifyMagicLinkToken({ token: 'ps_magic_validtoken' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TOKEN_NOT_FOUND');
      }
    });

    it('should return TOKEN_ALREADY_USED when token used', async () => {
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue({
        type: 'magic_link',
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
        userId: 'user-1',
        user: { id: 'user-1', suspendedAt: null, emailVerified: null },
        tokenHash: 'hash',
      } as never);

      const result = await verifyMagicLinkToken({ token: 'ps_magic_validtoken' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TOKEN_ALREADY_USED');
      }
    });

    it('should return TOKEN_EXPIRED when token expired', async () => {
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue({
        type: 'magic_link',
        usedAt: null,
        expiresAt: new Date(Date.now() - 60000),
        userId: 'user-1',
        user: { id: 'user-1', suspendedAt: null, emailVerified: null },
        tokenHash: 'hash',
      } as never);

      const result = await verifyMagicLinkToken({ token: 'ps_magic_validtoken' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TOKEN_EXPIRED');
      }
    });

    it('should return TOKEN_NOT_FOUND when user missing on record', async () => {
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue({
        type: 'magic_link',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        userId: 'user-1',
        user: null,
        tokenHash: 'hash',
      } as never);

      const result = await verifyMagicLinkToken({ token: 'ps_magic_validtoken' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TOKEN_NOT_FOUND');
      }
    });

    it('should return USER_SUSPENDED for suspended user', async () => {
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue({
        type: 'magic_link',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        userId: 'user-1',
        user: { id: 'user-1', suspendedAt: new Date(), emailVerified: null },
        tokenHash: 'hashed_ps_magic_validtoken',
      } as never);

      const result = await verifyMagicLinkToken({ token: 'ps_magic_validtoken' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('USER_SUSPENDED');
      }
    });

    it('should return TOKEN_NOT_FOUND when secureCompare fails', async () => {
      vi.mocked(secureCompare).mockReturnValue(false);
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue({
        type: 'magic_link',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        userId: 'user-1',
        user: { id: 'user-1', suspendedAt: null, emailVerified: null },
        tokenHash: 'different-hash',
      } as never);

      const result = await verifyMagicLinkToken({ token: 'ps_magic_validtoken' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TOKEN_NOT_FOUND');
      }
    });

    it('should return TOKEN_ALREADY_USED when concurrent request already consumed it', async () => {
      vi.mocked(secureCompare).mockReturnValue(true);
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue({
        id: 'token-1',
        type: 'magic_link',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        userId: 'user-1',
        user: { id: 'user-1', suspendedAt: null, emailVerified: null },
        tokenHash: 'hashed_ps_magic_validtoken',
      } as never);

      const mockReturning = vi.fn().mockResolvedValue([]); // empty = already used
      const mockWhere = vi.fn(() => ({ returning: mockReturning }));
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

      const result = await verifyMagicLinkToken({ token: 'ps_magic_validtoken' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TOKEN_ALREADY_USED');
      }
    });

    it('should succeed for valid token', async () => {
      vi.mocked(secureCompare).mockReturnValue(true);
      vi.mocked(db.query.verificationTokens.findFirst).mockResolvedValue({
        id: 'token-1',
        type: 'magic_link',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        userId: 'user-1',
        user: { id: 'user-1', suspendedAt: null, emailVerified: null },
        tokenHash: 'hashed_ps_magic_validtoken',
      } as never);

      const mockReturning = vi.fn().mockResolvedValue([{ id: 'token-1' }]);
      const mockWhere = vi.fn(() => ({ returning: mockReturning }));
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

      const result = await verifyMagicLinkToken({ token: 'ps_magic_validtoken' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.userId).toBe('user-1');
        expect(result.data.isNewUser).toBe(true); // emailVerified is null
      }
    });
  });
});

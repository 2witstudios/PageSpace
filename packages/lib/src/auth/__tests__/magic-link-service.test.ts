import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
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
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', email: 'email' },
  verificationTokens: { userId: 'userId', tokenHash: 'tokenHash', type: 'type', usedAt: 'usedAt', id: 'id' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
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

import { verifyMagicLinkToken, MAGIC_LINK_EXPIRY_MINUTES } from '../magic-link-service';
import { db } from '@pagespace/db/db';
import { secureCompare } from '../secure-compare';

describe('magic-link-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export MAGIC_LINK_EXPIRY_MINUTES as 5', () => {
    expect(MAGIC_LINK_EXPIRY_MINUTES).toBe(5);
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

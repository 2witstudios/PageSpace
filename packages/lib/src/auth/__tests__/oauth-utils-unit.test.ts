/**
 * @scaffold - ORM chain mocks present in createOrLinkOAuthUser tests
 * (insert().values().returning(), update().set().where(), select().from().where()).
 * Pending oauth-repository seam extraction for full rubric compliance.
 *
 * REVIEW: createOrLinkOAuthUser tests use mockReturnValueOnce chains
 * (db.query.users.findFirst called twice) that encode internal query order.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    verifyIdToken: vi.fn(),
  })),
}));

vi.mock('apple-signin-auth', () => ({
  default: {
    verifyIdToken: vi.fn(),
  },
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
    },
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn() })) })),
  },
  users: { id: 'id', email: 'email', googleId: 'googleId', appleId: 'appleId' },
  drives: { ownerId: 'ownerId' },
  eq: vi.fn(),
  or: vi.fn(),
  count: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));
vi.mock('../../utils/utils', () => ({ slugify: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, '-')) }));
vi.mock('../../logging/logger-config', () => ({
  loggers: { auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { verifyGoogleIdToken, verifyAppleIdToken, verifyOAuthIdToken, createOrLinkOAuthUser } from '../oauth-utils';
import { OAuthProvider } from '../oauth-types';
import { OAuth2Client } from 'google-auth-library';
import appleSignIn from 'apple-signin-auth';
import { db, users } from '@pagespace/db';

describe('oauth-utils', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client-id';
    process.env.APPLE_CLIENT_ID = 'apple-client-id';
  });

  afterEach(() => {
    const keys = ['GOOGLE_OAUTH_CLIENT_ID', 'APPLE_CLIENT_ID', 'APPLE_SERVICE_ID', 'GOOGLE_OAUTH_IOS_CLIENT_ID'] as const;
    for (const key of keys) {
      if (origEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = origEnv[key];
      }
    }
  });

  describe('verifyGoogleIdToken', () => {
    it('should return error when GOOGLE_OAUTH_CLIENT_ID not set', async () => {
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      const result = await verifyGoogleIdToken('some-token');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('should return error when payload is missing', async () => {
      const mockVerify = vi.fn().mockResolvedValue({ getPayload: () => null });
      vi.mocked(OAuth2Client).mockImplementation(() => ({ verifyIdToken: mockVerify }) as never);

      const result = await verifyGoogleIdToken('some-token');
      expect(result.success).toBe(false);
      expect(result.error).toContain('missing required claims');
    });

    it('should return user info on success', async () => {
      const mockPayload = {
        sub: 'google-123',
        email: 'user@gmail.com',
        email_verified: true,
        name: 'Test User',
        picture: 'http://photo.jpg',
      };
      const mockVerify = vi.fn().mockResolvedValue({ getPayload: () => mockPayload });
      vi.mocked(OAuth2Client).mockImplementation(() => ({ verifyIdToken: mockVerify }) as never);

      const result = await verifyGoogleIdToken('valid-token');
      expect(result.success).toBe(true);
      expect(result.userInfo?.email).toBe('user@gmail.com');
      expect(result.userInfo?.provider).toBe(OAuthProvider.GOOGLE);
    });

    it('should handle verification errors', async () => {
      const mockVerify = vi.fn().mockRejectedValue(new Error('Invalid token'));
      vi.mocked(OAuth2Client).mockImplementation(() => ({ verifyIdToken: mockVerify }) as never);

      const result = await verifyGoogleIdToken('bad-token');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid token');
    });

    it('should include iOS client ID when set', async () => {
      process.env.GOOGLE_OAUTH_IOS_CLIENT_ID = 'ios-client-id';
      const mockVerify = vi.fn().mockResolvedValue({
        getPayload: () => ({ sub: '1', email: 'u@g.com', email_verified: true }),
      });
      vi.mocked(OAuth2Client).mockImplementation(() => ({ verifyIdToken: mockVerify }) as never);

      await verifyGoogleIdToken('token');
      expect(mockVerify).toHaveBeenCalledWith(
        expect.objectContaining({
          audience: ['google-client-id', 'ios-client-id'],
        })
      );
    });
  });

  describe('verifyAppleIdToken', () => {
    it('should return error when no Apple client IDs configured', async () => {
      delete process.env.APPLE_CLIENT_ID;
      delete process.env.APPLE_SERVICE_ID;
      const result = await verifyAppleIdToken('some-token');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    it('should return error when payload missing', async () => {
      vi.mocked(appleSignIn.verifyIdToken).mockResolvedValue(null as never);
      const result = await verifyAppleIdToken('some-token');
      expect(result.success).toBe(false);
    });

    it('should return user info on success', async () => {
      vi.mocked(appleSignIn.verifyIdToken).mockResolvedValue({
        sub: 'apple-123',
        email: 'user@icloud.com',
        email_verified: 'true',
      } as never);

      const result = await verifyAppleIdToken('valid-token');
      expect(result.success).toBe(true);
      expect(result.userInfo?.provider).toBe(OAuthProvider.APPLE);
    });

    it('should handle boolean email_verified', async () => {
      vi.mocked(appleSignIn.verifyIdToken).mockResolvedValue({
        sub: 'apple-123',
        email: 'user@icloud.com',
        email_verified: true,
      } as never);

      const result = await verifyAppleIdToken('valid-token');
      expect(result.success).toBe(true);
      expect(result.userInfo?.emailVerified).toBe(true);
    });

    it('should handle verification errors', async () => {
      vi.mocked(appleSignIn.verifyIdToken).mockRejectedValue(new Error('Bad token'));
      const result = await verifyAppleIdToken('bad-token');
      expect(result.success).toBe(false);
    });

    it('should include service ID when set', async () => {
      process.env.APPLE_SERVICE_ID = 'apple-service-id';
      vi.mocked(appleSignIn.verifyIdToken).mockResolvedValue({
        sub: '1', email: 'u@a.com', email_verified: true,
      } as never);

      await verifyAppleIdToken('token');
      expect(appleSignIn.verifyIdToken).toHaveBeenCalledWith('token', {
        audience: ['apple-client-id', 'apple-service-id'],
        ignoreExpiration: false,
      });
    });
  });

  describe('verifyOAuthIdToken', () => {
    it('should route to Google verification', async () => {
      const mockVerify = vi.fn().mockResolvedValue({
        getPayload: () => ({ sub: '1', email: 'u@g.com', email_verified: true }),
      });
      vi.mocked(OAuth2Client).mockImplementation(() => ({ verifyIdToken: mockVerify }) as never);

      const result = await verifyOAuthIdToken(OAuthProvider.GOOGLE, 'token');
      expect(result.success).toBe(true);
    });

    it('should route to Apple verification', async () => {
      vi.mocked(appleSignIn.verifyIdToken).mockResolvedValue({
        sub: '1', email: 'u@a.com', email_verified: true,
      } as never);

      const result = await verifyOAuthIdToken(OAuthProvider.APPLE, 'token');
      expect(result.success).toBe(true);
    });

    it('should return error for unsupported provider', async () => {
      const result = await verifyOAuthIdToken('github' as OAuthProvider, 'token');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported');
    });
  });

  describe('createOrLinkOAuthUser', () => {
    it('should update existing user with OAuth provider ID', async () => {
      const existingUser = {
        id: 'user-1', email: 'user@test.com', name: 'Test', googleId: null,
        image: null, emailVerified: null, appleId: null,
      };
      vi.mocked(db.query.users.findFirst)
        .mockResolvedValueOnce(existingUser as never) // first lookup
        .mockResolvedValueOnce({ ...existingUser, googleId: 'google-123' } as never); // after update
      const mockWhere = vi.fn();
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);
      const mockCountWhere = vi.fn().mockResolvedValue([{ count: 1 }]);
      const mockCountFrom = vi.fn(() => ({ where: mockCountWhere }));
      vi.mocked(db.select).mockReturnValue({ from: mockCountFrom } as never);

      const result = await createOrLinkOAuthUser({
        providerId: 'google-123',
        email: 'user@test.com',
        emailVerified: true,
        name: 'Test User',
        picture: 'http://photo.jpg',
        provider: OAuthProvider.GOOGLE,
      });

      expect(result).toBeDefined();
      expect(db.update).toHaveBeenCalledWith(users);
    });

    it('should create new user when not found', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);
      const mockReturning = vi.fn().mockResolvedValue([{
        id: 'new-user', name: 'New', email: 'new@test.com',
      }]);
      const mockValues = vi.fn(() => ({ returning: mockReturning }));
      vi.mocked(db.insert).mockReturnValue({ values: mockValues } as never);
      const mockCountWhere = vi.fn().mockResolvedValue([{ count: 0 }]);
      const mockCountFrom = vi.fn(() => ({ where: mockCountWhere }));
      vi.mocked(db.select).mockReturnValue({ from: mockCountFrom } as never);

      const result = await createOrLinkOAuthUser({
        providerId: 'google-456',
        email: 'new@test.com',
        emailVerified: true,
        name: 'New User',
        picture: undefined,
        provider: OAuthProvider.GOOGLE,
      });

      expect(result).toBeDefined();
    });

    it('should create personal drive for new user with no drives', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);
      const mockReturning = vi.fn().mockResolvedValue([{
        id: 'new-user', name: 'New User', email: 'new@test.com',
      }]);
      const mockValues = vi.fn(() => ({ returning: mockReturning }));
      vi.mocked(db.insert).mockReturnValue({ values: mockValues } as never);
      const mockCountWhere = vi.fn().mockResolvedValue([{ count: 0 }]); // 0 drives
      const mockCountFrom = vi.fn(() => ({ where: mockCountWhere }));
      vi.mocked(db.select).mockReturnValue({ from: mockCountFrom } as never);

      await createOrLinkOAuthUser({
        providerId: 'apple-789',
        email: 'new@test.com',
        emailVerified: false,
        name: undefined,
        picture: undefined,
        provider: OAuthProvider.APPLE,
      });

      // insert called twice: once for user, once for drive
      expect(db.insert).toHaveBeenCalledTimes(2);
    });

    it('should surface personal drive creation failure for new user', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);
      const mockUserReturning = vi.fn().mockResolvedValue([{
        id: 'new-user', name: 'New User', email: 'new@test.com',
      }]);
      vi.mocked(db.insert)
        .mockReturnValueOnce({ values: vi.fn(() => ({ returning: mockUserReturning })) } as never)
        .mockReturnValueOnce({
          values: vi.fn(() => {
            throw new Error('drive insert failed');
          }),
        } as never);
      const mockCountWhere = vi.fn().mockResolvedValue([{ count: 0 }]);
      const mockCountFrom = vi.fn(() => ({ where: mockCountWhere }));
      vi.mocked(db.select).mockReturnValue({ from: mockCountFrom } as never);

      await expect(
        createOrLinkOAuthUser({
          providerId: 'apple-789',
          email: 'new@test.com',
          emailVerified: false,
          name: undefined,
          picture: undefined,
          provider: OAuthProvider.APPLE,
        }),
      ).rejects.toThrow('drive insert failed');
    });
  });
});

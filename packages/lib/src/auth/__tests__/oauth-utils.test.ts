/**
 * OAuth Utilities Tests
 *
 * Tests for ID token verification functions.
 * These functions validate JWT tokens from OAuth providers (Google, Apple)
 * and extract user information for authentication.
 *
 * Contract:
 * - Input: ID token string from OAuth provider
 * - Output: OAuthVerificationResult with success/failure and user info
 *
 * Security considerations:
 * - Tokens must be verified using provider's public keys
 * - Audience (client ID) must match our application
 * - Token expiration must be enforced
 * - No sensitive data (tokens) should be logged
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OAuthProvider } from '../oauth-types';

// Mock external dependencies at system boundary
vi.mock('../apple/apple-jwt', () => ({
  verifyAppleJwt: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    verifyIdToken: vi.fn(),
  })),
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

// Import after mocking
import { verifyAppleJwt } from '../apple/apple-jwt';
import { OAuth2Client } from 'google-auth-library';
import { verifyAppleIdToken, verifyGoogleIdToken } from '../oauth-utils';
import { loggers } from '../../logging/logger-config';

// Verified Apple identity-token claims, as verifyAppleJwt returns them
const createAppleClaims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sub: 'apple-user-123',
  email: 'user@example.com',
  email_verified: true,
  iss: 'https://appleid.apple.com',
  aud: 'ai.pagespace.ios',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  is_private_email: false,
  ...overrides,
});

const verified = (claims: Record<string, unknown>) => ({ ok: true as const, claims });
const rejected = (reason: string) => ({ ok: false as const, reason });

describe('verifyAppleIdToken', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.APPLE_CLIENT_ID;
    delete process.env.APPLE_SERVICE_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('configuration validation', () => {
    it('verifyAppleIdToken_noClientIds_returnsError', async () => {
      const result = await verifyAppleIdToken('fake-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Apple Sign-In not configured');
      expect(result.userInfo).toBeUndefined();
      expect(verifyAppleJwt).not.toHaveBeenCalled();
    });

    it('verifyAppleIdToken_onlyClientId_usesClientId', async () => {
      process.env.APPLE_CLIENT_ID = 'ai.pagespace.ios';
      vi.mocked(verifyAppleJwt).mockResolvedValue(verified(createAppleClaims()));

      const result = await verifyAppleIdToken('valid-token');

      expect(verifyAppleJwt).toHaveBeenCalledWith('valid-token', { audience: ['ai.pagespace.ios'] });
      expect(result.success).toBe(true);
    });

    it('verifyAppleIdToken_bothClientIds_usesBoth', async () => {
      process.env.APPLE_CLIENT_ID = 'ai.pagespace.ios';
      process.env.APPLE_SERVICE_ID = 'ai.pagespace.web';
      vi.mocked(verifyAppleJwt).mockResolvedValue(verified(createAppleClaims({ email_verified: 'true' })));

      await verifyAppleIdToken('valid-token');

      expect(verifyAppleJwt).toHaveBeenCalledWith('valid-token', { audience: ['ai.pagespace.ios', 'ai.pagespace.web'] });
    });
  });

  describe('successful verification', () => {
    beforeEach(() => {
      process.env.APPLE_CLIENT_ID = 'ai.pagespace.ios';
    });

    it('verifyAppleIdToken_validToken_returnsUserInfo', async () => {
      vi.mocked(verifyAppleJwt).mockResolvedValue(verified(createAppleClaims()));

      const result = await verifyAppleIdToken('valid-token');

      expect(result.success).toBe(true);
      expect(result.audience).toBe('ai.pagespace.ios');
      expect(result.userInfo).toEqual({
        providerId: 'apple-user-123',
        email: 'user@example.com',
        emailVerified: true,
        name: undefined, // Apple doesn't include name in token
        picture: undefined, // Apple doesn't provide pictures
        provider: OAuthProvider.APPLE,
      });
    });

    it('verifyAppleIdToken_emailVerifiedAsString_parsesCorrectly', async () => {
      vi.mocked(verifyAppleJwt).mockResolvedValue(verified(createAppleClaims({ email_verified: 'true' })));

      const result = await verifyAppleIdToken('valid-token');

      expect(result.success).toBe(true);
      expect(result.userInfo?.emailVerified).toBe(true);
    });

    it('verifyAppleIdToken_emailVerifiedFalse_parsesCorrectly', async () => {
      vi.mocked(verifyAppleJwt).mockResolvedValue(verified(createAppleClaims({ email_verified: false })));

      const result = await verifyAppleIdToken('valid-token');

      expect(result.success).toBe(true);
      expect(result.userInfo?.emailVerified).toBe(false);
    });
  });

  describe('verification failures', () => {
    beforeEach(() => {
      process.env.APPLE_CLIENT_ID = 'ai.pagespace.ios';
    });

    it('verifyAppleIdToken_missingEmail_returnsError', async () => {
      const claims = createAppleClaims();
      delete claims.email;
      vi.mocked(verifyAppleJwt).mockResolvedValue(verified(claims));

      const result = await verifyAppleIdToken('token-without-email');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid ID token: missing required claims');
    });

    it('verifyAppleIdToken_missingSubject_returnsError', async () => {
      const claims = createAppleClaims();
      delete claims.sub;
      vi.mocked(verifyAppleJwt).mockResolvedValue(verified(claims));

      const result = await verifyAppleIdToken('token-without-sub');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid ID token: missing required claims');
    });

    it.each(['expired', 'invalid_signature', 'invalid_audience', 'unknown_kid'])(
      'verifyAppleIdToken_%s_returnsReasonAsError',
      async (reason) => {
        vi.mocked(verifyAppleJwt).mockResolvedValue(rejected(reason));

        const result = await verifyAppleIdToken('bad-token');

        expect(result.success).toBe(false);
        expect(result.error).toBe(reason);
        expect(loggers.auth.warn).toHaveBeenCalledWith('Apple ID token verification failed', { reason });
      },
    );

    it('verifyAppleIdToken_unexpectedThrow_returnsGenericMessage', async () => {
      vi.mocked(verifyAppleJwt).mockRejectedValue('non-error-throw');

      const result = await verifyAppleIdToken('valid-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Token verification failed');
    });
  });

  describe('security logging', () => {
    beforeEach(() => {
      process.env.APPLE_CLIENT_ID = 'ai.pagespace.ios';
    });

    it('verifyAppleIdToken_failure_logsWithoutToken', async () => {
      vi.mocked(verifyAppleJwt).mockResolvedValue(rejected('invalid_signature'));

      await verifyAppleIdToken('secret-token-value');

      const calls = [...vi.mocked(loggers.auth.warn).mock.calls, ...vi.mocked(loggers.auth.error).mock.calls];
      expect(JSON.stringify(calls)).not.toContain('secret-token-value');
    });
  });
});

describe('verifyGoogleIdToken', () => {
  const originalEnv = { ...process.env };
  let mockVerifyIdToken: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_IOS_CLIENT_ID;

    mockVerifyIdToken = vi.fn();
    vi.mocked(OAuth2Client).mockImplementation(() => ({
      verifyIdToken: mockVerifyIdToken,
    }) as any);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('configuration validation', () => {
    it('verifyGoogleIdToken_noClientId_returnsError', async () => {
      const result = await verifyGoogleIdToken('fake-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Google OAuth client ID not configured');
    });
  });

  describe('successful verification', () => {
    beforeEach(() => {
      process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-web-client-id';
    });

    it('verifyGoogleIdToken_validToken_returnsUserInfo', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-user-123',
          email: 'user@gmail.com',
          email_verified: true,
          name: 'Test User',
          picture: 'https://lh3.googleusercontent.com/photo.jpg',
        }),
      });

      const result = await verifyGoogleIdToken('valid-token');

      expect(result.success).toBe(true);
      expect(result.userInfo).toEqual({
        providerId: 'google-user-123',
        email: 'user@gmail.com',
        emailVerified: true,
        name: 'Test User',
        picture: 'https://lh3.googleusercontent.com/photo.jpg',
        provider: OAuthProvider.GOOGLE,
      });
    });

    it('verifyGoogleIdToken_withIosClientId_acceptsBothAudiences', async () => {
      process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-web-client-id';
      process.env.GOOGLE_OAUTH_IOS_CLIENT_ID = 'google-ios-client-id';

      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-user-123',
          email: 'user@gmail.com',
          email_verified: true,
        }),
      });

      await verifyGoogleIdToken('valid-token');

      expect(mockVerifyIdToken).toHaveBeenCalledWith({
        idToken: 'valid-token',
        audience: ['google-web-client-id', 'google-ios-client-id'],
      });
    });
  });

  describe('verification failures', () => {
    beforeEach(() => {
      process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-web-client-id';
    });

    it('verifyGoogleIdToken_missingEmail_returnsError', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-user-123',
          // No email
        }),
      });

      const result = await verifyGoogleIdToken('token-without-email');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid ID token: missing required claims');
    });

    it('verifyGoogleIdToken_nullPayload_returnsError', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => null,
      });

      const result = await verifyGoogleIdToken('invalid-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid ID token: missing required claims');
    });

    it('verifyGoogleIdToken_expiredToken_returnsError', async () => {
      const expiredError = new Error('Token used too late');
      mockVerifyIdToken.mockRejectedValue(expiredError);

      const result = await verifyGoogleIdToken('expired-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Token used too late');
    });
  });
});

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
vi.mock('apple-signin-auth', () => ({
  default: {
    verifyIdToken: vi.fn(),
  },
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
import appleSignIn from 'apple-signin-auth';
import { OAuth2Client } from 'google-auth-library';
import { verifyAppleIdToken, verifyGoogleIdToken } from '../oauth-utils';
import { loggers } from '../../logging/logger-config';

describe('verifyAppleIdToken', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment
    delete process.env.APPLE_CLIENT_ID;
    delete process.env.APPLE_SERVICE_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('configuration validation', () => {
    it('verifyAppleIdToken_noClientIds_returnsError', async () => {
      // No APPLE_CLIENT_ID or APPLE_SERVICE_ID configured
      const result = await verifyAppleIdToken('fake-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Apple Sign-In not configured');
      expect(result.userInfo).toBeUndefined();
    });

    it('verifyAppleIdToken_onlyClientId_usesClientId', async () => {
      process.env.APPLE_CLIENT_ID = 'ai.pagespace.ios';

      vi.mocked(appleSignIn.verifyIdToken).mockResolvedValue({
        sub: 'apple-user-123',
        email: 'user@example.com',
        email_verified: true,
      });

      const result = await verifyAppleIdToken('valid-token');

      expect(appleSignIn.verifyIdToken).toHaveBeenCalledWith('valid-token', {
        audience: ['ai.pagespace.ios'],
        ignoreExpiration: false,
      });
      expect(result.success).toBe(true);
    });

    it('verifyAppleIdToken_bothClientIds_usesBoth', async () => {
      process.env.APPLE_CLIENT_ID = 'ai.pagespace.ios';
      process.env.APPLE_SERVICE_ID = 'ai.pagespace.web';

      vi.mocked(appleSignIn.verifyIdToken).mockResolvedValue({
        sub: 'apple-user-123',
        email: 'user@example.com',
        email_verified: 'true',
      });

      await verifyAppleIdToken('valid-token');

      expect(appleSignIn.verifyIdToken).toHaveBeenCalledWith('valid-token', {
        audience: ['ai.pagespace.ios', 'ai.pagespace.web'],
        ignoreExpiration: false,
      });
    });
  });

  describe('successful verification', () => {
    beforeEach(() => {
      process.env.APPLE_CLIENT_ID = 'ai.pagespace.ios';
    });

    it('verifyAppleIdToken_validToken_returnsUserInfo', async () => {
      vi.mocked(appleSignIn.verifyIdToken).mockResolvedValue({
        sub: 'apple-user-123',
        email: 'user@example.com',
        email_verified: true,
        iss: 'https://appleid.apple.com',
        aud: 'ai.pagespace.ios',
        exp: Date.now() / 1000 + 3600,
        iat: Date.now() / 1000,
      });

      const result = await verifyAppleIdToken('valid-token');

      expect(result.success).toBe(true);
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
      vi.mocked(appleSignIn.verifyIdToken).mockResolvedValue({
        sub: 'apple-user-123',
        email: 'user@example.com',
        email_verified: 'true', // Apple sometimes sends as string
      });

      const result = await verifyAppleIdToken('valid-token');

      expect(result.success).toBe(true);
      expect(result.userInfo?.emailVerified).toBe(true);
    });

    it('verifyAppleIdToken_emailVerifiedFalse_parsesCorrectly', async () => {
      vi.mocked(appleSignIn.verifyIdToken).mockResolvedValue({
        sub: 'apple-user-123',
        email: 'user@example.com',
        email_verified: false,
      });

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
      vi.mocked(appleSignIn.verifyIdToken).mockResolvedValue({
        sub: 'apple-user-123',
        // No email
      });

      const result = await verifyAppleIdToken('token-without-email');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid ID token: missing required claims');
    });

    it('verifyAppleIdToken_nullPayload_returnsError', async () => {
      vi.mocked(appleSignIn.verifyIdToken).mockResolvedValue(null as any);

      const result = await verifyAppleIdToken('invalid-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid ID token: missing required claims');
    });

    it('verifyAppleIdToken_expiredToken_returnsError', async () => {
      const expiredError = new Error('Token has expired');
      vi.mocked(appleSignIn.verifyIdToken).mockRejectedValue(expiredError);

      const result = await verifyAppleIdToken('expired-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Token has expired');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Apple ID token verification failed',
        expiredError
      );
    });

    it('verifyAppleIdToken_invalidSignature_returnsError', async () => {
      const signatureError = new Error('Invalid signature');
      vi.mocked(appleSignIn.verifyIdToken).mockRejectedValue(signatureError);

      const result = await verifyAppleIdToken('tampered-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid signature');
    });

    it('verifyAppleIdToken_wrongAudience_returnsError', async () => {
      const audienceError = new Error('Audience mismatch');
      vi.mocked(appleSignIn.verifyIdToken).mockRejectedValue(audienceError);

      const result = await verifyAppleIdToken('wrong-audience-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Audience mismatch');
    });

    it('verifyAppleIdToken_networkError_returnsError', async () => {
      const networkError = new Error('Network request failed');
      vi.mocked(appleSignIn.verifyIdToken).mockRejectedValue(networkError);

      const result = await verifyAppleIdToken('valid-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network request failed');
    });

    it('verifyAppleIdToken_unknownError_returnsGenericMessage', async () => {
      vi.mocked(appleSignIn.verifyIdToken).mockRejectedValue('non-error-throw');

      const result = await verifyAppleIdToken('valid-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Token verification failed');
    });
  });

  describe('security logging', () => {
    beforeEach(() => {
      process.env.APPLE_CLIENT_ID = 'ai.pagespace.ios';
    });

    it('verifyAppleIdToken_failure_logsErrorWithoutToken', async () => {
      const error = new Error('Verification failed');
      vi.mocked(appleSignIn.verifyIdToken).mockRejectedValue(error);

      await verifyAppleIdToken('secret-token-value');

      // Should log error but NOT the token itself
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Apple ID token verification failed',
        error
      );
      // Verify token is not in any call
      const calls = vi.mocked(loggers.auth.error).mock.calls;
      const callStr = JSON.stringify(calls);
      expect(callStr).not.toContain('secret-token-value');
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

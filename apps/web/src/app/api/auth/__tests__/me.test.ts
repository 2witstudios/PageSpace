/**
 * Contract tests for GET /api/auth/me
 *
 * These tests verify the Request → Response contract.
 * Database operations are mocked at the repository seam (not ORM chains).
 *
 * Coverage:
 * - Authentication (token validation)
 * - User profile retrieval
 * - Security (no password exposure, role-based responses)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '../me/route';
import type { User } from '@/lib/repositories/auth-repository';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserById: vi.fn(),
  },
}));

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { authRepository } from '@/lib/repositories/auth-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// Test fixtures
const mockVerifiedDate = new Date('2024-01-15T10:00:00Z');
const mockUser: User = {
  id: 'test-user-id',
  name: 'Test User',
  email: 'test@example.com',
  emailBidx: null,
  image: 'https://example.com/avatar.png',
  role: 'user',
  provider: 'email',
  googleId: null,
  appleId: null,
  emailVerified: mockVerifiedDate,
  tokenVersion: 0,
  adminRoleVersion: 0,
  currentAiProvider: 'openai',
  currentAiModel: 'openai/gpt-5.3-chat',
  imageGenerationModel: null,
  storageUsedBytes: 0,
  activeUploads: 0,
  lastStorageCalculated: null,
  stripeCustomerId: null,
  subscriptionTier: 'free',
  tosAcceptedAt: null,
  failedLoginAttempts: 0,
  lockedUntil: null,
  suspendedAt: null,
  suspendedReason: null,
  timezone: null,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
};

const mockAuthSuccess = {
  userId: 'test-user-id',
  role: 'user',
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
};

const createRequest = () => {
  return new Request('http://localhost/api/auth/me', {
    method: 'GET',
    headers: {
      Cookie: 'ps_session=valid-token',
    },
  });
};

describe('GET /api/auth/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthSuccess as never);
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authRepository.findUserById).mockResolvedValue(mockUser);
  });

  describe('successful retrieval', () => {
    it('returns 200 with user profile data', async () => {
      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.id).toBe(mockUser.id);
      expect(body.name).toBe(mockUser.name);
      expect(body.email).toBe(mockUser.email);
      expect(body.image).toBeNull();
      expect(body.role).toBe(mockUser.role);
      // Date is serialized to ISO string in JSON response
      expect(body.emailVerified).toBe(mockVerifiedDate.toISOString());
    });

    it('does not expose sensitive fields like tokenVersion', async () => {
      const response = await GET(createRequest());
      const body = await response.json();

      expect(body.tokenVersion).toBeUndefined();
    });

    it('returns admin role for admin users', async () => {
      vi.mocked(authRepository.findUserById).mockResolvedValue({
        ...mockUser,
        role: 'admin',
      });
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
        ...mockAuthSuccess,
        role: 'admin',
      } as never);

      const response = await GET(createRequest());
      const body = await response.json();

      expect(body.role).toBe('admin');
    });
  });

  describe('authentication', () => {
    it('returns 401 when not authenticated', async () => {
      const mockResponse = new Response('Unauthorized', { status: 401 });
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: mockResponse } as never);
      vi.mocked(isAuthError).mockReturnValue(true);

      const response = await GET(createRequest());

      expect(response.status).toBe(401);
    });

    it('calls repository with authenticated userId', async () => {
      await GET(createRequest());

      expect(authRepository.findUserById).toHaveBeenCalledWith('test-user-id');
    });

    it('accepts an OAuth-authenticated identity (CLI `pagespace login`/`whoami`)', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
        userId: 'test-user-id',
        role: 'user',
        tokenVersion: 0,
        adminRoleVersion: 0,
        tokenType: 'oauth',
        tokenId: 'oauth-token-id',
        scopes: { account: true, offlineAccess: false, drives: new Map() },
        driveScopes: [],
        allowedDriveIds: [],
      } as never);
      vi.mocked(isAuthError).mockReturnValue(false);

      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.email).toBe(mockUser.email);
      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(expect.anything(), { allow: ['session', 'oauth'], requireCSRF: false });
    });

    it('does not allow mcp bearer auth — a scoped agent credential must never resolve the personal owner\'s profile', async () => {
      // `authenticateRequestWithOptions` is mocked at the boundary in this
      // file, so this can't exercise the real allow-list rejection end to
      // end — it pins the contract this route depends on: 'mcp' must be
      // absent from AUTH_OPTIONS.allow, so the real (unmocked)
      // authenticateRequestWithOptions rejects an mcp_* bearer token before
      // this handler's own logic ever runs. `pagespace keys create` mints a
      // scoped mcp_* token — its own `confirmIdentity` call against this
      // route degrades to a caught, silently-absorbed failure
      // (loopback-flow.ts), not a functional break: `keys create` never
      // reads that result (only `login`/`login-device`/`whoami` do, and
      // none of those authenticate with an mcp_* token).
      await GET(createRequest());

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(expect.anything(), { allow: ['session', 'oauth'], requireCSRF: false });
    });
  });

  describe('user not found', () => {
    it('returns 404 when authenticated user is not found in database', async () => {
      // Edge case: token valid but user deleted
      vi.mocked(authRepository.findUserById).mockResolvedValue(null);

      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });
  });

  describe('OAuth users', () => {
    it('returns correct email for Google OAuth users', async () => {
      const oauthUser: User = {
        ...mockUser,
        provider: 'google',
        googleId: 'google-123',
      };
      vi.mocked(authRepository.findUserById).mockResolvedValue(oauthUser);

      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.email).toBe(oauthUser.email);
    });
  });

  describe('email verification status', () => {
    it('returns null emailVerified for unverified users', async () => {
      vi.mocked(authRepository.findUserById).mockResolvedValue({
        ...mockUser,
        emailVerified: null, // Not verified - null in database
      });

      const response = await GET(createRequest());
      const body = await response.json();

      expect(body.emailVerified).toBeNull();
    });

    it('returns verification date for verified users', async () => {
      const response = await GET(createRequest());
      const body = await response.json();

      // Date is serialized to ISO string
      expect(body.emailVerified).toBe(mockVerifiedDate.toISOString());
    });
  });

  describe('image sanitization', () => {
    it('returns local image path when image is not an external HTTP URL', async () => {
      vi.mocked(authRepository.findUserById).mockResolvedValue({
        ...mockUser,
        image: '/uploads/avatars/user-123.jpg',
      });

      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.image).toBe('/uploads/avatars/user-123.jpg');
    });
  });

  describe('debug logging', () => {
    it('logs user profile in development mode with DEBUG_AUTH enabled', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('DEBUG_AUTH', 'true');

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const response = await GET(createRequest());

      expect(response.status).toBe(200);
      expect(consoleSpy).toHaveBeenCalledWith(
        '[AUTH] User profile loaded: test@example.com (provider: email, id: test-user-id)'
      );

      consoleSpy.mockRestore();
      vi.unstubAllEnvs();
    });
  });
});

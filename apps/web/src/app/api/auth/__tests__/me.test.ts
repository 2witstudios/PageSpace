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

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { GET } from '../me/route';
import type { User } from '@/lib/repositories/auth-repository';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserById: vi.fn(),
  },
}));

// Mock auth helpers (boundary)
vi.mock('@/lib/auth/auth-helpers', () => ({
  requireAuth: vi.fn(),
  isAuthError: vi.fn(),
}));

import { authRepository } from '@/lib/repositories/auth-repository';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';

// Test fixtures
const mockVerifiedDate = new Date('2024-01-15T10:00:00Z');
const mockUser: User = {
  id: 'test-user-id',
  name: 'Test User',
  email: 'test@example.com',
  image: 'https://example.com/avatar.png',
  role: 'user',
  provider: 'email',
  googleId: null,
  emailVerified: mockVerifiedDate,
  password: '$2a$12$hashedpassword',
  tokenVersion: 0,
  adminRoleVersion: 0,
  currentAiProvider: 'pagespace',
  currentAiModel: 'glm-4.5-air',
  storageUsedBytes: 0,
  activeUploads: 0,
  lastStorageCalculated: null,
  stripeCustomerId: null,
  subscriptionTier: 'free',
  tosAcceptedAt: null,
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
    (requireAuth as unknown as Mock).mockResolvedValue(mockAuthSuccess);
    (isAuthError as unknown as Mock).mockReturnValue(false);
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
      expect(body.image).toBe(mockUser.image);
      expect(body.role).toBe(mockUser.role);
      // Date is serialized to ISO string in JSON response
      expect(body.emailVerified).toBe(mockVerifiedDate.toISOString());
    });

    it('does not expose sensitive fields like password', async () => {
      const response = await GET(createRequest());
      const body = await response.json();

      // Security: password must never be in response
      expect(body.password).toBeUndefined();
      expect(body.tokenVersion).toBeUndefined();
    });

    it('returns admin role for admin users', async () => {
      vi.mocked(authRepository.findUserById).mockResolvedValue({
        ...mockUser,
        role: 'admin',
      });
      (requireAuth as unknown as Mock).mockResolvedValue({
        ...mockAuthSuccess,
        role: 'admin',
      });

      const response = await GET(createRequest());
      const body = await response.json();

      expect(body.role).toBe('admin');
    });
  });

  describe('authentication', () => {
    it('returns 401 when not authenticated', async () => {
      const mockResponse = new Response('Unauthorized', { status: 401 });
      (requireAuth as unknown as Mock).mockResolvedValue(mockResponse);
      (isAuthError as unknown as Mock).mockReturnValue(true);

      const response = await GET(createRequest());

      expect(response.status).toBe(401);
    });

    it('calls repository with authenticated userId', async () => {
      await GET(createRequest());

      expect(authRepository.findUserById).toHaveBeenCalledWith('test-user-id');
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
});

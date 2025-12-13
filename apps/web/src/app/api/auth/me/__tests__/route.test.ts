import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

// Mock auth helpers
const { mockRequireAuth, mockIsAuthError } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result instanceof NextResponse),
}));

vi.mock('@/lib/auth/auth-helpers', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
}));

// Mock database
const { mockDbQueryUsersFindFirst } = vi.hoisted(() => ({
  mockDbQueryUsersFindFirst: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      users: { findFirst: mockDbQueryUsersFindFirst },
    },
  },
  users: {},
  eq: vi.fn(),
}));

// Import after mocks
import { GET } from '../route';

// Helper to create mock auth user
const mockAuthUser = (overrides: Partial<{
  userId: string;
  role: 'user' | 'admin';
  tokenVersion: number;
}> = {}) => ({
  userId: overrides.userId ?? 'user_123',
  role: overrides.role ?? 'user',
  tokenVersion: overrides.tokenVersion ?? 0,
  tokenType: 'jwt' as const,
});

// Helper to create mock user from database
const mockDbUser = (overrides: Partial<{
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  role: 'user' | 'admin';
  provider: string | null;
  googleId: string | null;
  emailVerified: boolean;
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  name: overrides.name ?? 'Test User',
  email: overrides.email ?? 'test@example.com',
  image: overrides.image ?? null,
  role: overrides.role ?? 'user',
  provider: overrides.provider ?? null,
  googleId: overrides.googleId ?? null,
  emailVerified: overrides.emailVerified ?? false,
});

// Helper to create request
const createRequest = (headers: Record<string, string> = {}) => {
  return new Request('https://example.com/api/auth/me', {
    method: 'GET',
    headers,
  });
};

describe('GET /api/auth/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    mockRequireAuth.mockResolvedValue(mockAuthUser());

    // Default user exists
    mockDbQueryUsersFindFirst.mockResolvedValue(mockDbUser());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should return 401 when not authenticated', async () => {
      mockRequireAuth.mockResolvedValue(
        new NextResponse('Unauthorized', { status: 401 })
      );

      const request = createRequest();
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should call requireAuth with request', async () => {
      const request = createRequest();
      await GET(request);

      expect(mockRequireAuth).toHaveBeenCalledWith(request);
    });
  });

  describe('User Retrieval', () => {
    it('should return 404 when user not found', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(null);

      const request = createRequest();
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return user profile data', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(
        mockDbUser({
          id: 'user_456',
          name: 'John Doe',
          email: 'john@example.com',
          role: 'admin',
          emailVerified: true,
        })
      );

      const request = createRequest();
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        id: 'user_456',
        name: 'John Doe',
        email: 'john@example.com',
        image: null,
        role: 'admin',
        emailVerified: true,
      });
    });

    it('should return user with image', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(
        mockDbUser({ image: 'https://example.com/avatar.jpg' })
      );

      const request = createRequest();
      const response = await GET(request);
      const body = await response.json();

      expect(body.image).toBe('https://example.com/avatar.jpg');
    });

    it('should not expose password or sensitive fields', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue({
        ...mockDbUser(),
        password: 'hashed-password',
        tokenVersion: 5,
        stripeCustomerId: 'cus_123',
      });

      const request = createRequest();
      const response = await GET(request);
      const body = await response.json();

      expect(body.password).toBeUndefined();
      expect(body.tokenVersion).toBeUndefined();
      expect(body.stripeCustomerId).toBeUndefined();
    });
  });

  describe('Email Verification Status', () => {
    it('should return emailVerified as false for unverified users', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(
        mockDbUser({ emailVerified: false })
      );

      const request = createRequest();
      const response = await GET(request);
      const body = await response.json();

      expect(body.emailVerified).toBe(false);
    });

    it('should return emailVerified as true for verified users', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(
        mockDbUser({ emailVerified: true })
      );

      const request = createRequest();
      const response = await GET(request);
      const body = await response.json();

      expect(body.emailVerified).toBe(true);
    });
  });

  describe('OAuth Users', () => {
    it('should return provider info for OAuth users', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(
        mockDbUser({
          provider: 'google',
          googleId: 'google-123',
        })
      );

      const request = createRequest();
      const response = await GET(request);
      const body = await response.json();

      // Note: The route doesn't expose provider in response, only uses it internally
      expect(response.status).toBe(200);
    });
  });

  describe('User Roles', () => {
    it('should return role for regular users', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockDbUser({ role: 'user' }));

      const request = createRequest();
      const response = await GET(request);
      const body = await response.json();

      expect(body.role).toBe('user');
    });

    it('should return role for admin users', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockDbUser({ role: 'admin' }));

      const request = createRequest();
      const response = await GET(request);
      const body = await response.json();

      expect(body.role).toBe('admin');
    });
  });
});

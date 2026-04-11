import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/users/find
//
// Mock at the SERVICE SEAM level: auth and db.query.users.findFirst
// ============================================================================

const { mockSecurityAudit } = vi.hoisted(() => ({
  mockSecurityAudit: { logDataAccess: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  securityAudit: mockSecurityAudit,
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

const mockFindFirst = vi.fn();

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      users: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
  },
  users: { email: 'email-column' },
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

import { GET } from '../route';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// ============================================================================
// GET /api/users/find
// ============================================================================

describe('GET /api/users/find', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    mockFindFirst.mockResolvedValue(null);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/users/find?email=test@example.com');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with correct auth options', async () => {
      const request = new Request('https://example.com/api/users/find?email=test@example.com');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('validation', () => {
    it('should return 400 when email parameter is missing', async () => {
      const request = new Request('https://example.com/api/users/find');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Email parameter is missing');
    });
  });

  describe('service integration', () => {
    it('should query users by email with correct columns', async () => {
      const request = new Request('https://example.com/api/users/find?email=test@example.com');
      await GET(request);

      expect(mockFindFirst).toHaveBeenCalledWith({
        where: { col: 'email-column', val: 'test@example.com' },
        columns: { id: true, name: true, email: true, image: true },
      });
    });
  });

  describe('response contract', () => {
    it('should return 404 when user is not found', async () => {
      mockFindFirst.mockResolvedValue(null);

      const request = new Request('https://example.com/api/users/find?email=unknown@example.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should return user data when found', async () => {
      const userData = {
        id: 'user_456',
        name: 'Test User',
        email: 'test@example.com',
        image: 'https://example.com/avatar.png',
      };
      mockFindFirst.mockResolvedValue(userData);

      const request = new Request('https://example.com/api/users/find?email=test@example.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(userData);
    });
  });

  describe('security audit', () => {
    it('should log audit event on successful user lookup', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'user_456', name: 'Test', email: 'test@example.com', image: null,
      });

      const request = new Request('https://example.com/api/users/find?email=test@example.com');
      await GET(request);

      expect(mockSecurityAudit.logDataAccess).toHaveBeenCalledWith(
        'user_123', 'read', 'user_search', 'user_456', { queryLength: 16, resultCount: 1 }
      );
    });

    it('should not log audit event when user is not found', async () => {
      mockFindFirst.mockResolvedValue(null);

      const request = new Request('https://example.com/api/users/find?email=missing@example.com');
      await GET(request);

      expect(mockSecurityAudit.logDataAccess).not.toHaveBeenCalled();
    });

    it('should not log audit event when auth fails', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError());
      vi.mocked(isAuthError).mockReturnValue(true);

      const request = new Request('https://example.com/api/users/find?email=test@example.com');
      await GET(request);

      expect(mockSecurityAudit.logDataAccess).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 when database throws', async () => {
      mockFindFirst.mockRejectedValueOnce(new Error('Database connection lost'));

      const request = new Request('https://example.com/api/users/find?email=test@example.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to find user');
    });

    it('should log error when database throws', async () => {
      const error = new Error('Database failure');
      mockFindFirst.mockRejectedValueOnce(error);

      const request = new Request('https://example.com/api/users/find?email=test@example.com');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error finding user:', error);
    });
  });
});

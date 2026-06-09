import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/users/find
//
// Mock at the SERVICE SEAM level: auth and db.query.users.findFirst
// ============================================================================

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: { API: { maxAttempts: 100, windowMs: 60000 } },
}));

vi.mock('@/lib/users/visibility', () => ({
  callerCanViewUser: vi.fn(),
}));

const mockFindFirst = vi.fn();

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      users: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { email: 'email-column' },
}));

import { GET } from '../route';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { callerCanViewUser } from '@/lib/users/visibility';

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
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true });
    // Default: caller already shares context with the matched user (visible).
    vi.mocked(callerCanViewUser).mockResolvedValue(true);
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
      // No relationship check is needed when there is no candidate at all.
      expect(callerCanViewUser).not.toHaveBeenCalled();
    });

    it('should return user data when found AND caller already shares context', async () => {
      const userData = {
        id: 'user_456',
        name: 'Test User',
        email: 'test@example.com',
        image: 'https://example.com/avatar.png',
      };
      mockFindFirst.mockResolvedValue(userData);
      vi.mocked(callerCanViewUser).mockResolvedValue(true);

      const request = new Request('https://example.com/api/users/find?email=test@example.com');
      const response = await GET(request);
      const body = await response.json();

      expect(callerCanViewUser).toHaveBeenCalledWith(mockUserId, 'user_456');
      expect(response.status).toBe(200);
      expect(body).toEqual(userData);
    });

    it('should return a UNIFORM 404 when the account exists but the caller cannot see them (L1)', async () => {
      // Indistinguishable from the "not found" case above — no existence leak,
      // no name/avatar harvest.
      mockFindFirst.mockResolvedValue({
        id: 'stranger_1',
        name: 'Stranger',
        email: 'stranger@example.com',
        image: 'https://example.com/s.png',
      });
      vi.mocked(callerCanViewUser).mockResolvedValue(false);

      const request = new Request('https://example.com/api/users/find?email=stranger@example.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body).toEqual({ error: 'User not found' });
      expect(body).not.toHaveProperty('name');
      expect(body).not.toHaveProperty('image');
    });

    it('should always let a caller resolve their own account regardless of relationship', async () => {
      const self = {
        id: mockUserId,
        name: 'Me',
        email: 'me@example.com',
        image: null,
      };
      mockFindFirst.mockResolvedValue(self);
      vi.mocked(callerCanViewUser).mockResolvedValue(false);

      const request = new Request('https://example.com/api/users/find?email=me@example.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(self);
    });
  });

  describe('rate limiting (L1)', () => {
    it('should return 429 when the per-user rate limit is exceeded', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        retryAfter: 30,
      });

      const request = new Request('https://example.com/api/users/find?email=test@example.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('30');
      expect(body.error).toBe('Too many requests');
      expect(mockFindFirst).not.toHaveBeenCalled();
    });
  });

  describe('security audit', () => {
    it('should log audit event on successful user lookup', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'user_456', name: 'Test', email: 'test@example.com', image: null,
      });

      const request = new Request('https://example.com/api/users/find?email=test@example.com');
      await GET(request);

      expect(auditRequest).toHaveBeenCalledWith(
        request,
        { eventType: 'data.read', userId: 'user_123', resourceType: 'user_search', resourceId: 'user_456', details: { queryLength: 16, resultCount: 1 } }
      );
    });

    it('should not log audit event when user is not found', async () => {
      mockFindFirst.mockResolvedValue(null);

      const request = new Request('https://example.com/api/users/find?email=missing@example.com');
      await GET(request);

      expect(auditRequest).not.toHaveBeenCalled();
    });

    it('should not log audit event when auth fails', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError());
      vi.mocked(isAuthError).mockReturnValue(true);

      const request = new Request('https://example.com/api/users/find?email=test@example.com');
      await GET(request);

      expect(auditRequest).not.toHaveBeenCalled();
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

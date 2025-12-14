import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyAuth, verifyAdminAuth, type VerifiedUser } from '../auth';

// Mock the auth index module
vi.mock('../index', () => ({
  authenticateWebRequest: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
}));

import { authenticateWebRequest } from '../index';

const mockAuthenticateWebRequest = vi.mocked(authenticateWebRequest);

describe('auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('verifyAuth', () => {
    it('returns user when authentication succeeds', async () => {
      const mockAuthResult = {
        userId: 'user-123',
        role: 'user' as const,
        tokenVersion: 1,
        tokenType: 'jwt' as const,
        source: 'cookie' as const,
      };
      mockAuthenticateWebRequest.mockResolvedValue(mockAuthResult);

      const request = new Request('http://localhost/api/test');
      const result = await verifyAuth(request);

      expect(result).toEqual({
        id: 'user-123',
        role: 'user',
        tokenVersion: 1,
      });
      expect(mockAuthenticateWebRequest).toHaveBeenCalledWith(request);
    });

    it('returns user with admin role', async () => {
      const mockAuthResult = {
        userId: 'admin-123',
        role: 'admin' as const,
        tokenVersion: 2,
        tokenType: 'jwt' as const,
        source: 'header' as const,
      };
      mockAuthenticateWebRequest.mockResolvedValue(mockAuthResult);

      const request = new Request('http://localhost/api/test');
      const result = await verifyAuth(request);

      expect(result).toEqual({
        id: 'admin-123',
        role: 'admin',
        tokenVersion: 2,
      });
    });

    it('returns null when authentication fails', async () => {
      const mockErrorResult = {
        error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
      };
      mockAuthenticateWebRequest.mockResolvedValue(mockErrorResult as never);

      const request = new Request('http://localhost/api/test');
      const result = await verifyAuth(request);

      expect(result).toBeNull();
    });

    it('handles different token versions', async () => {
      const mockAuthResult = {
        userId: 'user-456',
        role: 'user' as const,
        tokenVersion: 42,
        tokenType: 'jwt' as const,
        source: 'cookie' as const,
      };
      mockAuthenticateWebRequest.mockResolvedValue(mockAuthResult);

      const request = new Request('http://localhost/api/test');
      const result = await verifyAuth(request);

      expect(result?.tokenVersion).toBe(42);
    });
  });

  describe('verifyAdminAuth', () => {
    it('returns user when admin authentication succeeds', async () => {
      const mockAuthResult = {
        userId: 'admin-123',
        role: 'admin' as const,
        tokenVersion: 1,
        tokenType: 'jwt' as const,
        source: 'cookie' as const,
      };
      mockAuthenticateWebRequest.mockResolvedValue(mockAuthResult);

      const request = new Request('http://localhost/api/admin/test');
      const result = await verifyAdminAuth(request);

      expect(result).toEqual({
        id: 'admin-123',
        role: 'admin',
        tokenVersion: 1,
      });
    });

    it('returns null when user is not admin', async () => {
      const mockAuthResult = {
        userId: 'user-123',
        role: 'user' as const,
        tokenVersion: 1,
        tokenType: 'jwt' as const,
        source: 'cookie' as const,
      };
      mockAuthenticateWebRequest.mockResolvedValue(mockAuthResult);

      const request = new Request('http://localhost/api/admin/test');
      const result = await verifyAdminAuth(request);

      expect(result).toBeNull();
    });

    it('returns null when authentication fails', async () => {
      const mockErrorResult = {
        error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
      };
      mockAuthenticateWebRequest.mockResolvedValue(mockErrorResult as never);

      const request = new Request('http://localhost/api/admin/test');
      const result = await verifyAdminAuth(request);

      expect(result).toBeNull();
    });

    it('returns null when user is null', async () => {
      // Simulate a case where verifyAuth returns null
      const mockErrorResult = {
        error: new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401 }),
      };
      mockAuthenticateWebRequest.mockResolvedValue(mockErrorResult as never);

      const request = new Request('http://localhost/api/admin/test');
      const result = await verifyAdminAuth(request);

      expect(result).toBeNull();
    });
  });

  describe('VerifiedUser type', () => {
    it('satisfies VerifiedUser interface structure', () => {
      const user: VerifiedUser = {
        id: 'test-id',
        role: 'user',
        tokenVersion: 1,
      };

      expect(user.id).toBe('test-id');
      expect(user.role).toBe('user');
      expect(user.tokenVersion).toBe(1);
    });

    it('accepts admin role', () => {
      const admin: VerifiedUser = {
        id: 'admin-id',
        role: 'admin',
        tokenVersion: 5,
      };

      expect(admin.role).toBe('admin');
    });
  });
});

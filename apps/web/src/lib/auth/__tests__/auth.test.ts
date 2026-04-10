import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { verifyAuth, verifyAdminAuth, isAdminAuthError } from '../auth';
import type { AdminValidationResult } from '../admin-role';

// Mock the auth index module
vi.mock('../index', () => ({
  authenticateSessionRequest: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
}));

// Mock the admin-role module
vi.mock('../admin-role', () => ({
  validateAdminAccess: vi.fn(),
}));

// Mock CSRF validation - allow all requests by default
vi.mock('../csrf-validation', () => ({
  validateCSRF: vi.fn().mockResolvedValue(null),
}));

// Mock security event logging
vi.mock('@pagespace/lib/server', () => ({
  logSecurityEvent: vi.fn(),
  loggers: {
    security: { warn: vi.fn() },
  },
  securityAudit: {
    logAccessDenied: vi.fn().mockResolvedValue(undefined),
  },
}));

import { authenticateSessionRequest } from '../index';
import { validateAdminAccess } from '../admin-role';

const mockAuthenticateWebRequest = vi.mocked(authenticateSessionRequest);
const mockValidateAdminAccess = vi.mocked(validateAdminAccess);

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
        adminRoleVersion: 0,
        tokenType: 'session' as const,
        sessionId: 'test-session-id',
      };
      mockAuthenticateWebRequest.mockResolvedValue(mockAuthResult);

      const request = new Request('http://localhost/api/test');
      const result = await verifyAuth(request);

      expect(result).toEqual({
        id: 'user-123',
        role: 'user',
        tokenVersion: 1,
        adminRoleVersion: 0,
        authTransport: 'cookie',
      });
      expect(mockAuthenticateWebRequest).toHaveBeenCalledWith(request);
    });

    it('returns user with admin role', async () => {
      const mockAuthResult = {
        userId: 'admin-123',
        role: 'admin' as const,
        tokenVersion: 2,
        adminRoleVersion: 1,
        tokenType: 'session' as const,
        sessionId: 'test-session-id',
      };
      mockAuthenticateWebRequest.mockResolvedValue(mockAuthResult);

      const request = new Request('http://localhost/api/test');
      const result = await verifyAuth(request);

      expect(result).toEqual({
        id: 'admin-123',
        role: 'admin',
        tokenVersion: 2,
        adminRoleVersion: 1,
        authTransport: 'cookie',
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
        adminRoleVersion: 0,
        tokenType: 'session' as const,
        sessionId: 'test-session-id',
      };
      mockAuthenticateWebRequest.mockResolvedValue(mockAuthResult);

      const request = new Request('http://localhost/api/test');
      const result = await verifyAuth(request);

      expect(result?.tokenVersion).toBe(42);
    });
  });

  describe('verifyAdminAuth', () => {
    it('returns user when admin authentication succeeds and adminRoleVersion is valid', async () => {
      const mockAuthResult = {
        userId: 'admin-123',
        role: 'admin' as const,
        tokenVersion: 1,
        adminRoleVersion: 0,
        tokenType: 'session' as const,
        sessionId: 'test-session-id',
      };
      mockAuthenticateWebRequest.mockResolvedValue(mockAuthResult);
      const validResult: AdminValidationResult = { isValid: true, actualAdminRoleVersion: 0 };
      mockValidateAdminAccess.mockResolvedValue(validResult);

      const request = new Request('http://localhost/api/admin/test');
      const result = await verifyAdminAuth(request);

      expect(result).toEqual({
        id: 'admin-123',
        role: 'admin',
        tokenVersion: 1,
        adminRoleVersion: 0,
        authTransport: 'cookie',
      });
      expect(mockValidateAdminAccess).toHaveBeenCalledWith('admin-123', 0);
    });

    it('returns error response when user is not admin (validateAdminAccess rejects)', async () => {
      const mockAuthResult = {
        userId: 'user-123',
        role: 'user' as const,
        tokenVersion: 1,
        adminRoleVersion: 0,
        tokenType: 'session' as const,
        sessionId: 'test-session-id',
      };
      mockAuthenticateWebRequest.mockResolvedValue(mockAuthResult);
      // validateAdminAccess is called and returns not_admin
      const invalidResult: AdminValidationResult = {
        isValid: false,
        reason: 'not_admin',
        currentRole: 'user',
        actualAdminRoleVersion: 0,
      };
      mockValidateAdminAccess.mockResolvedValue(invalidResult);

      const request = new Request('http://localhost/api/admin/test');
      const result = await verifyAdminAuth(request);

      expect(isAdminAuthError(result)).toBe(true);
      expect(result).toBeInstanceOf(NextResponse);
      // validateAdminAccess IS called for all authenticated users now
      expect(mockValidateAdminAccess).toHaveBeenCalledWith('user-123', 0);
    });

    it('returns error response when authentication fails', async () => {
      const mockErrorResult = {
        error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
      };
      mockAuthenticateWebRequest.mockResolvedValue(mockErrorResult as never);

      const request = new Request('http://localhost/api/admin/test');
      const result = await verifyAdminAuth(request);

      expect(isAdminAuthError(result)).toBe(true);
      expect(result).toBeInstanceOf(NextResponse);
    });

    it('returns error response when adminRoleVersion validation fails (role changed)', async () => {
      const mockAuthResult = {
        userId: 'admin-123',
        role: 'admin' as const,
        tokenVersion: 1,
        adminRoleVersion: 0,
        tokenType: 'session' as const,
        sessionId: 'test-session-id',
      };
      mockAuthenticateWebRequest.mockResolvedValue(mockAuthResult);
      // Simulate role change - validateAdminAccess returns invalid result
      const invalidResult: AdminValidationResult = {
        isValid: false,
        reason: 'version_mismatch',
        actualAdminRoleVersion: 1,
        currentRole: 'admin',
      };
      mockValidateAdminAccess.mockResolvedValue(invalidResult);

      const request = new Request('http://localhost/api/admin/test');
      const result = await verifyAdminAuth(request);

      expect(isAdminAuthError(result)).toBe(true);
      expect(result).toBeInstanceOf(NextResponse);
      expect(mockValidateAdminAccess).toHaveBeenCalledWith('admin-123', 0);
    });
  });
});

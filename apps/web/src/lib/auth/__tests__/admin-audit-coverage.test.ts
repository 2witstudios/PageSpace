import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    logDataAccess: vi.fn().mockResolvedValue(undefined),
    logEvent: vi.fn().mockResolvedValue(undefined),
    logAccessDenied: vi.fn().mockResolvedValue(undefined),
  },
}));

import { withAdminAuth } from '../auth';
import { authenticateSessionRequest } from '../index';
import { validateAdminAccess } from '../admin-role';
import { loggers, securityAudit } from '@pagespace/lib/server';

const mockAuthenticateRequest = vi.mocked(authenticateSessionRequest);
const mockValidateAdminAccess = vi.mocked(validateAdminAccess);
const mockLogDataAccess = vi.mocked(securityAudit.logDataAccess);
const mockLogEvent = vi.mocked(securityAudit.logEvent);
const mockLogAccessDenied = vi.mocked(securityAudit.logAccessDenied);
const mockSecurityWarn = vi.mocked(loggers.security.warn);

function mockAdminAuth() {
  mockAuthenticateRequest.mockResolvedValue({
    userId: 'admin-123',
    role: 'admin' as const,
    tokenVersion: 1,
    adminRoleVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'sess-abc',
  });
  const validResult: AdminValidationResult = { isValid: true, actualAdminRoleVersion: 0 };
  mockValidateAdminAccess.mockResolvedValue(validResult);
}

function mockAuthDenied() {
  mockAuthenticateRequest.mockResolvedValue({
    error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
  } as never);
}

function mockAdminRoleDenied() {
  mockAuthenticateRequest.mockResolvedValue({
    userId: 'user-456',
    role: 'user' as const,
    tokenVersion: 1,
    adminRoleVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'sess-def',
  });
  const invalidResult: AdminValidationResult = {
    isValid: false,
    reason: 'not_admin',
    currentRole: 'user',
    actualAdminRoleVersion: 0,
  };
  mockValidateAdminAccess.mockResolvedValue(invalidResult);
}

describe('Admin audit coverage (withAdminAuth)', () => {
  const handler = vi.fn().mockResolvedValue(Response.json({ ok: true }));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('successful admin access', () => {
    it('emits data.read audit event on /api/admin/users', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      await wrappedHandler(request);

      expect(mockLogDataAccess).toHaveBeenCalledTimes(1);
      expect(mockLogDataAccess).toHaveBeenCalledWith(
        'admin-123',
        'read',
        'admin-endpoint',
        '/api/admin/users',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('emits data.read audit event on /api/admin/schema', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/schema');

      await wrappedHandler(request);

      expect(mockLogDataAccess).toHaveBeenCalledTimes(1);
      expect(mockLogDataAccess).toHaveBeenCalledWith(
        'admin-123',
        'read',
        'admin-endpoint',
        '/api/admin/schema',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('includes required audit fields: userId, resourceType, resourceId', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      await wrappedHandler(request);

      const [userId, operation, resourceType, resourceId] = mockLogDataAccess.mock.calls[0];
      expect(userId).toBe('admin-123');
      expect(operation).toBe('read');
      expect(resourceType).toBe('admin-endpoint');
      expect(resourceId).toBe('/api/admin/users');
    });

    it('includes IP address from x-forwarded-for header', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users', {
        headers: { 'x-forwarded-for': '203.0.113.50, 70.41.3.18' },
      });

      await wrappedHandler(request);

      const details = mockLogDataAccess.mock.calls[0][4];
      expect(details).toEqual(expect.objectContaining({ ipAddress: '203.0.113.50' }));
    });

    it('logs write operation for POST requests', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users/create', {
        method: 'POST',
      });

      await wrappedHandler(request);

      expect(mockLogDataAccess).toHaveBeenCalledWith(
        'admin-123',
        'write',
        'admin-endpoint',
        '/api/admin/users/create',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('logs delete operation for DELETE requests', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users/123/gift-subscription', {
        method: 'DELETE',
      });

      await wrappedHandler(request);

      expect(mockLogDataAccess).toHaveBeenCalledWith(
        'admin-123',
        'delete',
        'admin-endpoint',
        '/api/admin/users/123/gift-subscription',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('does not emit denied audit event on success', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      await wrappedHandler(request);

      expect(mockLogEvent).not.toHaveBeenCalled();
    });
  });

  describe('denied admin access - unauthenticated', () => {
    it('emits authz.access.denied audit event', async () => {
      mockAuthDenied();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      const response = await wrappedHandler(request);

      expect(response.status).toBe(403);
      expect(mockLogEvent).toHaveBeenCalledTimes(1);
      expect(mockLogEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'authz.access.denied',
          resourceType: 'admin-endpoint',
          resourceId: '/api/admin/users',
          details: expect.objectContaining({
            method: 'GET',
            reason: 'admin_auth_denied',
          }),
          riskScore: 0.5,
        })
      );
    });

    it('emits denied audit event for /api/admin/schema', async () => {
      mockAuthDenied();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/schema');

      const response = await wrappedHandler(request);

      expect(response.status).toBe(403);
      expect(mockLogEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'authz.access.denied',
          resourceId: '/api/admin/schema',
        })
      );
    });

    it('does not include userId in denied event for unauthenticated requests', async () => {
      mockAuthDenied();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      await wrappedHandler(request);

      const eventArg = mockLogEvent.mock.calls[0][0];
      expect(eventArg.userId).toBeUndefined();
    });

    it('does not emit success audit event on denial', async () => {
      mockAuthDenied();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      await wrappedHandler(request);

      expect(mockLogDataAccess).not.toHaveBeenCalled();
    });
  });

  describe('denied admin access - insufficient role', () => {
    it('emits authz.access.denied audit event with userId for non-admin user', async () => {
      mockAdminRoleDenied();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      const response = await wrappedHandler(request);

      expect(response.status).toBe(403);
      expect(mockLogEvent).toHaveBeenCalledTimes(1);
      expect(mockLogEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'authz.access.denied',
          userId: 'user-456',
          resourceType: 'admin-endpoint',
          resourceId: '/api/admin/users',
          riskScore: 0.5,
        })
      );
    });

    it('includes IP address in denied audit event', async () => {
      mockAdminRoleDenied();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/schema', {
        headers: { 'x-forwarded-for': '198.51.100.10' },
      });

      await wrappedHandler(request);

      expect(mockLogEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '198.51.100.10',
          resourceId: '/api/admin/schema',
        })
      );
    });
  });

  describe('required audit fields presence', () => {
    it('success audit entry contains all required fields', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users', {
        headers: { 'x-forwarded-for': '10.0.0.1' },
      });

      await wrappedHandler(request);

      expect(mockLogDataAccess).toHaveBeenCalledWith(
        'admin-123',         // actor identity (userId)
        'read',              // action
        'admin-endpoint',    // resource type
        '/api/admin/users',  // resource id (endpoint path)
        expect.objectContaining({
          method: 'GET',
          ipAddress: '10.0.0.1',
        })
      );
    });

    it('denied audit entry contains all required fields', async () => {
      mockAuthDenied();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users', {
        headers: { 'x-real-ip': '172.16.0.1' },
      });

      await wrappedHandler(request);

      expect(mockLogEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'authz.access.denied',  // action result
          resourceType: 'admin-endpoint',     // resource type
          resourceId: '/api/admin/users',     // target resource (endpoint path)
          ipAddress: '172.16.0.1',            // correlation field
          details: expect.objectContaining({
            method: 'GET',                    // HTTP method
            reason: 'admin_auth_denied',      // denial reason
          }),
          riskScore: 0.5,
        })
      );
    });
  });

  describe('audit persistence failure logging', () => {
    it('logs warning when logDataAccess rejects', async () => {
      mockAdminAuth();
      mockLogDataAccess.mockRejectedValueOnce(new Error('DB write timeout'));
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      await wrappedHandler(request);
      await new Promise(process.nextTick);

      expect(mockSecurityWarn).toHaveBeenCalledWith(
        '[AdminAuth] audit logDataAccess failed',
        expect.objectContaining({ error: 'DB write timeout', userId: 'admin-123' })
      );
    });

    it('logs warning when logEvent rejects', async () => {
      mockAuthDenied();
      mockLogEvent.mockRejectedValueOnce(new Error('Audit service down'));
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      await wrappedHandler(request);
      await new Promise(process.nextTick);

      expect(mockSecurityWarn).toHaveBeenCalledWith(
        '[AdminAuth] audit logEvent failed',
        expect.objectContaining({ error: 'Audit service down', endpoint: '/api/admin/users' })
      );
    });

    it('logs warning when logAccessDenied rejects', async () => {
      mockAdminRoleDenied();
      mockLogAccessDenied.mockRejectedValueOnce(new Error('Connection refused'));
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      await wrappedHandler(request);
      await new Promise(process.nextTick);

      expect(mockSecurityWarn).toHaveBeenCalledWith(
        '[AdminAuth] audit logAccessDenied failed',
        expect.objectContaining({ error: 'Connection refused', userId: 'user-456' })
      );
    });
  });
});

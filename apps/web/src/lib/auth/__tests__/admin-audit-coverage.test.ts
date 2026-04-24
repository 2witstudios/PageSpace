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
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  logSecurityEvent: vi.fn(),
  loggers: {
    security: { warn: vi.fn() },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

import { withAdminAuth } from '../auth';
import { authenticateSessionRequest } from '../index';
import { validateAdminAccess } from '../admin-role';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const mockAuthenticateRequest = vi.mocked(authenticateSessionRequest);
const mockValidateAdminAccess = vi.mocked(validateAdminAccess);
const mockAuditRequest = vi.mocked(auditRequest);

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

      expect(mockAuditRequest).toHaveBeenCalledTimes(1);
      expect(mockAuditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'data.read',
          userId: 'admin-123',
          resourceType: 'admin-endpoint',
          resourceId: '/api/admin/users',
          details: expect.objectContaining({ method: 'GET' }),
        })
      );
    });

    it('emits data.read audit event on /api/admin/schema', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/schema');

      await wrappedHandler(request);

      expect(mockAuditRequest).toHaveBeenCalledTimes(1);
      expect(mockAuditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'data.read',
          userId: 'admin-123',
          resourceType: 'admin-endpoint',
          resourceId: '/api/admin/schema',
          details: expect.objectContaining({ method: 'GET' }),
        })
      );
    });

    it('includes required audit fields: userId, resourceType, resourceId', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      await wrappedHandler(request);

      const event = mockAuditRequest.mock.calls[0][1];
      expect(event.userId).toBe('admin-123');
      expect(event.eventType).toBe('data.read');
      expect(event.resourceType).toBe('admin-endpoint');
      expect(event.resourceId).toBe('/api/admin/users');
    });

    it('passes request for IP extraction by auditRequest', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users', {
        headers: { 'x-forwarded-for': '203.0.113.50, 70.41.3.18' },
      });

      await wrappedHandler(request);

      // auditRequest extracts IP from the request headers automatically
      expect(mockAuditRequest).toHaveBeenCalledWith(request, expect.any(Object));
    });

    it('logs write operation for POST requests', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users/create', {
        method: 'POST',
      });

      await wrappedHandler(request);

      expect(mockAuditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'data.write',
          resourceId: '/api/admin/users/create',
          details: expect.objectContaining({ method: 'POST' }),
        })
      );
    });

    it('logs delete operation for DELETE requests', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users/123/gift-subscription', {
        method: 'DELETE',
      });

      await wrappedHandler(request);

      expect(mockAuditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'data.delete',
          resourceId: '/api/admin/users/123/gift-subscription',
          details: expect.objectContaining({ method: 'DELETE' }),
        })
      );
    });

    it('does not emit denied audit event on success', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      await wrappedHandler(request);

      expect(mockAuditRequest).toHaveBeenCalledTimes(1);
      expect(mockAuditRequest).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'authz.access.denied' })
      );
    });
  });

  describe('denied admin access - unauthenticated', () => {
    it('emits authz.access.denied audit event', async () => {
      mockAuthDenied();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      const response = await wrappedHandler(request);

      expect(response.status).toBe(403);
      expect(mockAuditRequest).toHaveBeenCalledTimes(1);
      expect(mockAuditRequest).toHaveBeenCalledWith(
        request,
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
      expect(mockAuditRequest).toHaveBeenCalledWith(
        request,
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

      const eventArg = mockAuditRequest.mock.calls[0][1];
      expect(eventArg.userId).toBeUndefined();
    });

    it('does not emit success audit event on denial', async () => {
      mockAuthDenied();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      await wrappedHandler(request);

      expect(mockAuditRequest).toHaveBeenCalledTimes(1);
      expect(mockAuditRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'authz.access.denied' })
      );
    });
  });

  describe('denied admin access - insufficient role', () => {
    it('emits exactly one authz.access.denied audit event with userId for non-admin user', async () => {
      mockAdminRoleDenied();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      const response = await wrappedHandler(request);

      expect(response.status).toBe(403);
      // withAdminAuth is the single audit point — passes skipInternalAudit
      // to verifyAdminAuth to avoid the double-emit seen when both layers audit.
      expect(mockAuditRequest).toHaveBeenCalledTimes(1);
      expect(mockAuditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'authz.access.denied',
          resourceType: 'admin-endpoint',
          resourceId: '/api/admin/users',
          riskScore: 0.5,
        })
      );
    });

    it('passes request for IP extraction in denied audit event', async () => {
      mockAdminRoleDenied();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/schema', {
        headers: { 'x-forwarded-for': '198.51.100.10' },
      });

      await wrappedHandler(request);

      // auditRequest receives the request object and extracts IP internally
      expect(mockAuditRequest).toHaveBeenCalledWith(request, expect.any(Object));
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

      const accessCall = mockAuditRequest.mock.calls.find(
        (call) => call[1].eventType === 'data.read'
      );
      expect(accessCall).toBeDefined();
      expect(accessCall![1]).toEqual(expect.objectContaining({
        eventType: 'data.read',
        userId: 'admin-123',
        resourceType: 'admin-endpoint',
        resourceId: '/api/admin/users',
        details: expect.objectContaining({ method: 'GET' }),
      }));
    });

    it('denied audit entry contains all required fields', async () => {
      mockAuthDenied();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users', {
        headers: { 'x-real-ip': '172.16.0.1' },
      });

      await wrappedHandler(request);

      expect(mockAuditRequest).toHaveBeenCalledWith(
        request,
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
  });

  describe('GDPR: IP address excluded from hash chain', () => {
    it('success audit does not include IP in details (auditRequest handles IP extraction)', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users', {
        headers: { 'x-forwarded-for': '203.0.113.50, 70.41.3.18' },
      });

      await wrappedHandler(request);

      // auditRequest extracts IP from the request and sets it as a top-level field.
      // The event object passed to auditRequest should NOT have IP in details.
      const auditCall = mockAuditRequest.mock.calls.find(
        (call) => call[1].eventType?.startsWith('data.')
      );
      expect(auditCall).toBeDefined();
      const event = auditCall![1];
      expect(event.details).not.toHaveProperty('ipAddress');
    });
  });

  describe('single audit point contract', () => {
    it('middleware is the sole audit point — exactly one auditRequest call per request', async () => {
      mockAdminAuth();
      const wrappedHandler = withAdminAuth(handler);
      const request = new Request('http://localhost/api/admin/users');

      await wrappedHandler(request);

      expect(mockAuditRequest).toHaveBeenCalledTimes(1);
    });
  });
});

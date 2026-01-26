import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { authenticateService, requireScope, AUTH_REQUIRED } from '../src/middleware/auth';

vi.mock('@pagespace/lib/auth', () => ({
  sessionService: {
    validateSession: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/permissions', () => ({
  EnforcedAuthContext: {
    fromSession: vi.fn((claims) => ({
      userId: claims.userId,
      userRole: claims.userRole,
      resourceBinding: claims.resourceType && claims.resourceId
        ? { type: claims.resourceType, id: claims.resourceId }
        : undefined,
      driveId: claims.driveId,
      hasScope: vi.fn((scope: string) => {
        if (claims.scopes.includes('*')) return true;
        if (claims.scopes.includes(scope)) return true;
        const [namespace] = scope.split(':');
        if (namespace && claims.scopes.includes(`${namespace}:*`)) return true;
        return false;
      }),
      isAdmin: vi.fn(() => claims.userRole === 'admin'),
    })),
  },
}));

import { sessionService } from '@pagespace/lib/auth';

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    path: '/api/test',
    originalUrl: '/api/test',
    method: 'GET',
    auth: undefined,
    ...overrides,
  } as Request;
}

function createMockResponse(): Response & { statusCode: number; jsonData: unknown } {
  const res: any = {
    statusCode: 200,
    jsonData: null,
    status: vi.fn(function(code: number) {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn(function(data: unknown) {
      res.jsonData = data;
      return res;
    }),
  };
  return res;
}

describe('authenticateService middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PROCESSOR_AUTH_REQUIRED = 'true';
  });

  afterEach(() => {
    delete process.env.PROCESSOR_AUTH_REQUIRED;
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const req = createMockRequest();
    const res = createMockResponse();
    const next = vi.fn();

    await authenticateService(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.jsonData).toEqual({ error: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header is malformed', async () => {
    const req = createMockRequest({
      headers: { authorization: 'Basic token123' },
    });
    const res = createMockResponse();
    const next = vi.fn();

    await authenticateService(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.jsonData).toEqual({ error: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token validation fails', async () => {
    vi.mocked(sessionService.validateSession).mockResolvedValue(null);

    const req = createMockRequest({
      headers: { authorization: 'Bearer invalid-token' },
    });
    const res = createMockResponse();
    const next = vi.fn();

    await authenticateService(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.jsonData).toEqual({ error: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when token is not a service token', async () => {
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      userId: 'user-123',
      userRole: 'user',
      type: 'session', // Not a service token
      scopes: ['files:read'],
    } as any);

    const req = createMockRequest({
      headers: { authorization: 'Bearer user-token' },
    });
    const res = createMockResponse();
    const next = vi.fn();

    await authenticateService(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.jsonData).toEqual({ error: 'Service token required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and sets req.auth for valid service tokens', async () => {
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      userId: 'user-123',
      userRole: 'user',
      type: 'service',
      scopes: ['files:read'],
    } as any);

    const req = createMockRequest({
      headers: { authorization: 'Bearer valid-service-token' },
    });
    const res = createMockResponse();
    const next = vi.fn();

    await authenticateService(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.auth).toBeDefined();
    expect(req.auth?.userId).toBe('user-123');
  });

  it('does NOT infer scopes from URL (removed anti-pattern)', async () => {
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      userId: 'user-123',
      userRole: 'user',
      type: 'service',
      scopes: [], // No scopes at all
    } as any);

    // Previously, hitting /api/upload would infer 'files:write' scope
    // and would reject if the token didn't have it.
    // Now, authentication passes - scope checking is done by requireScope()
    const req = createMockRequest({
      headers: { authorization: 'Bearer valid-service-token' },
      path: '/api/upload/single',
      originalUrl: '/api/upload/single',
    });
    const res = createMockResponse();
    const next = vi.fn();

    await authenticateService(req, res, next);

    // Authentication passes - scope checking is separate
    expect(next).toHaveBeenCalled();
    expect(req.auth).toBeDefined();
  });
});

describe('requireScope middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PROCESSOR_AUTH_REQUIRED = 'true';
  });

  afterEach(() => {
    delete process.env.PROCESSOR_AUTH_REQUIRED;
  });

  it('returns 401 when req.auth is not set', () => {
    const middleware = requireScope('files:read');
    const req = createMockRequest();
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when token lacks required scope', () => {
    const middleware = requireScope('files:write');
    const req = createMockRequest();
    req.auth = {
      userId: 'user-123',
      userRole: 'user',
      hasScope: (scope: string) => scope === 'files:read', // Only has read
    } as any;
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.jsonData).toEqual({
      error: 'Missing required scope: files:write',
      requiredScope: 'files:write',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when token has exact required scope', () => {
    const middleware = requireScope('files:write');
    const req = createMockRequest();
    req.auth = {
      userId: 'user-123',
      userRole: 'user',
      hasScope: (scope: string) => scope === 'files:write',
    } as any;
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200); // Not modified
  });

  it('calls next() when token has wildcard scope', () => {
    const middleware = requireScope('files:write');
    const req = createMockRequest();
    req.auth = {
      userId: 'user-123',
      userRole: 'user',
      hasScope: () => true, // Wildcard
    } as any;
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

describe('security: no URL-based scope bypass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PROCESSOR_AUTH_REQUIRED = 'true';
  });

  afterEach(() => {
    delete process.env.PROCESSOR_AUTH_REQUIRED;
  });

  it('unrecognized URLs do NOT bypass authentication', async () => {
    // This tests that requests to unknown endpoints still require auth
    const req = createMockRequest({
      path: '/api/unknown-endpoint',
      originalUrl: '/api/unknown-endpoint',
    });
    const res = createMockResponse();
    const next = vi.fn();

    await authenticateService(req, res, next);

    // Should require authentication (401 without token)
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('unrecognized URLs with valid auth but no scopes still pass authenticateService', async () => {
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      userId: 'user-123',
      userRole: 'user',
      type: 'service',
      scopes: [], // No scopes
    } as any);

    // The old bug: /api/something-unknown would infer null scope and bypass checks
    // Now: authenticateService only validates the token, scope checking is done separately
    const req = createMockRequest({
      headers: { authorization: 'Bearer valid-token' },
      path: '/api/something-unknown',
      originalUrl: '/api/something-unknown',
    });
    const res = createMockResponse();
    const next = vi.fn();

    await authenticateService(req, res, next);

    // authenticateService passes - it only validates the token
    // The route handler or catch-all will handle the 404
    expect(next).toHaveBeenCalled();
  });

  it('requireScope explicitly rejects tokens without the declared scope', () => {
    const middleware = requireScope('files:write');
    const req = createMockRequest({
      path: '/api/upload',
    });
    req.auth = {
      userId: 'user-123',
      userRole: 'user',
      hasScope: () => false, // No scopes
    } as any;
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.jsonData).toHaveProperty('requiredScope', 'files:write');
    expect(next).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Auth Middleware Tests
 *
 * Validates that authentication cannot be accidentally disabled in production.
 * The AUTH_REQUIRED flag should:
 * - Always be true when PROCESSOR_AUTH_REQUIRED is not set
 * - Always be true when PROCESSOR_AUTH_REQUIRED=true
 * - Throw an error if PROCESSOR_AUTH_REQUIRED=false in production
 * - Only allow PROCESSOR_AUTH_REQUIRED=false in development mode
 */

// Mock all external dependencies that auth.ts imports
vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: {
    validateSession: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/permissions/enforced-context', () => ({
  EnforcedAuthContext: {
    fromSession: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    security: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

describe('AUTH_REQUIRED security behavior', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  describe('given PROCESSOR_AUTH_REQUIRED is not set', () => {
    it('should require auth (AUTH_REQUIRED = true)', async () => {
      delete process.env.PROCESSOR_AUTH_REQUIRED;
      delete process.env.NODE_ENV;

      const { AUTH_REQUIRED } = await import('../auth');
      expect(AUTH_REQUIRED).toBe(true);
    });
  });

  describe('given PROCESSOR_AUTH_REQUIRED=true', () => {
    it('should require auth (AUTH_REQUIRED = true)', async () => {
      process.env.PROCESSOR_AUTH_REQUIRED = 'true';
      delete process.env.NODE_ENV;

      const { AUTH_REQUIRED } = await import('../auth');
      expect(AUTH_REQUIRED).toBe(true);
    });
  });

  describe('given PROCESSOR_AUTH_REQUIRED=false in production', () => {
    it('should throw an error refusing to disable auth', async () => {
      process.env.PROCESSOR_AUTH_REQUIRED = 'false';
      process.env.NODE_ENV = 'production';

      await expect(import('../auth')).rejects.toThrow(
        'PROCESSOR_AUTH_REQUIRED=false is only allowed in development mode'
      );
    });
  });

  describe('given PROCESSOR_AUTH_REQUIRED=false with NODE_ENV unset', () => {
    it('should throw an error (fail-safe: unset NODE_ENV is not development)', async () => {
      process.env.PROCESSOR_AUTH_REQUIRED = 'false';
      delete process.env.NODE_ENV;

      await expect(import('../auth')).rejects.toThrow(
        'PROCESSOR_AUTH_REQUIRED=false is only allowed in development mode'
      );
    });
  });

  describe('given PROCESSOR_AUTH_REQUIRED=false in development', () => {
    it('should allow auth to be disabled (AUTH_REQUIRED = false)', async () => {
      process.env.PROCESSOR_AUTH_REQUIRED = 'false';
      process.env.NODE_ENV = 'development';

      const { AUTH_REQUIRED } = await import('../auth');
      expect(AUTH_REQUIRED).toBe(false);
    });
  });

  describe('given PROCESSOR_AUTH_REQUIRED=false in test mode', () => {
    it('should throw an error (test mode is not development)', async () => {
      process.env.PROCESSOR_AUTH_REQUIRED = 'false';
      process.env.NODE_ENV = 'test';

      await expect(import('../auth')).rejects.toThrow(
        'PROCESSOR_AUTH_REQUIRED=false is only allowed in development mode'
      );
    });
  });

  describe('given random PROCESSOR_AUTH_REQUIRED value', () => {
    it('should require auth for any value other than false', async () => {
      process.env.PROCESSOR_AUTH_REQUIRED = 'yes';
      delete process.env.NODE_ENV;

      const { AUTH_REQUIRED } = await import('../auth');
      expect(AUTH_REQUIRED).toBe(true);
    });
  });

  describe('given empty string PROCESSOR_AUTH_REQUIRED', () => {
    it('should require auth (empty string is not false)', async () => {
      process.env.PROCESSOR_AUTH_REQUIRED = '';
      delete process.env.NODE_ENV;

      const { AUTH_REQUIRED } = await import('../auth');
      expect(AUTH_REQUIRED).toBe(true);
    });
  });
});

describe('hasAuthScope', () => {
  // These tests use the real implementation, but we need the module to load
  // with AUTH_REQUIRED=true (the default), so reset modules cleanly.
  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    delete process.env.PROCESSOR_AUTH_REQUIRED;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns false when auth is undefined', async () => {
    const { hasAuthScope } = await import('../auth');
    expect(hasAuthScope(undefined, 'files:write')).toBe(false);
  });

  it('returns result of auth.hasScope when auth is provided', async () => {
    const { hasAuthScope } = await import('../auth');
    const mockAuth = { hasScope: vi.fn().mockReturnValue(true) } as unknown as Parameters<typeof hasAuthScope>[0];
    expect(hasAuthScope(mockAuth, 'files:write')).toBe(true);
    expect(mockAuth!.hasScope).toHaveBeenCalledWith('files:write');
  });

  it('returns false when auth.hasScope returns false', async () => {
    const { hasAuthScope } = await import('../auth');
    const mockAuth = { hasScope: vi.fn().mockReturnValue(false) } as unknown as Parameters<typeof hasAuthScope>[0];
    expect(hasAuthScope(mockAuth, 'admin')).toBe(false);
  });
});

describe('authenticateService - catch block', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    delete process.env.PROCESSOR_AUTH_REQUIRED;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('responds 401 when validateSession throws an error', async () => {
    // Set up mocks before importing the module
    vi.doMock('@pagespace/lib/auth/session-service', () => ({
      sessionService: {
        validateSession: vi.fn().mockRejectedValue(new Error('JWT parsing failed')),
      },
    }));
    vi.doMock('@pagespace/lib/permissions/enforced-context', () => ({
      EnforcedAuthContext: { fromSession: vi.fn() },
    }));
    vi.doMock('@pagespace/lib/logging/logger-config', () => ({
      loggers: { security: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
      logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
    }));

    const { authenticateService } = await import('../auth');

    const mockReq = {
      headers: { authorization: 'Bearer validtoken12345678' },
      path: '/upload',
      method: 'POST',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      auth: undefined,
    } as unknown as Parameters<typeof authenticateService>[0];

    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const mockRes = { status, json } as unknown as Parameters<typeof authenticateService>[1];
    const mockNext = vi.fn() as unknown as Parameters<typeof authenticateService>[2];

    await authenticateService(mockReq, mockRes, mockNext);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Invalid token' }));
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('responds 401 when validateSession throws a non-Error object', async () => {
    vi.doMock('@pagespace/lib/auth/session-service', () => ({
      sessionService: {
        validateSession: vi.fn().mockRejectedValue('string error'),
      },
    }));
    vi.doMock('@pagespace/lib/permissions/enforced-context', () => ({
      EnforcedAuthContext: { fromSession: vi.fn() },
    }));
    vi.doMock('@pagespace/lib/logging/logger-config', () => ({
      loggers: { security: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } },
      logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
    }));

    const { authenticateService } = await import('../auth');

    const mockReq = {
      headers: { authorization: 'Bearer validtoken12345678' },
      path: '/upload',
      method: 'POST',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      auth: undefined,
    } as unknown as Parameters<typeof authenticateService>[0];

    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const mockRes = { status, json } as unknown as Parameters<typeof authenticateService>[1];
    const mockNext = vi.fn() as unknown as Parameters<typeof authenticateService>[2];

    await authenticateService(mockReq, mockRes, mockNext);

    expect(status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });
});

describe('authenticateService when AUTH_REQUIRED is false', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'development';
    process.env.PROCESSOR_AUTH_REQUIRED = 'false';
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.PROCESSOR_AUTH_REQUIRED;
  });

  it('calls next immediately without validating token when AUTH_REQUIRED is false', async () => {
    const { authenticateService } = await import('../auth');

    const mockReq = {
      headers: { authorization: 'Bearer sometoken' },
      path: '/upload',
      method: 'POST',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      auth: undefined,
    } as unknown as Parameters<typeof authenticateService>[0];

    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Parameters<typeof authenticateService>[1];
    const mockNext = vi.fn() as unknown as Parameters<typeof authenticateService>[2];

    await authenticateService(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRes.status).not.toHaveBeenCalled();
  });
});

describe('requireScope when AUTH_REQUIRED is false', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'development';
    process.env.PROCESSOR_AUTH_REQUIRED = 'false';
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.PROCESSOR_AUTH_REQUIRED;
  });

  it('calls next immediately without checking scope when AUTH_REQUIRED is false', async () => {
    const { requireScope } = await import('../auth');
    const middleware = requireScope('files:write');

    const mockReq = {
      auth: undefined,
      path: '/upload',
      method: 'POST',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Parameters<typeof middleware>[0];

    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Parameters<typeof middleware>[1];
    const mockNext = vi.fn() as unknown as Parameters<typeof middleware>[2];

    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockRes.status).not.toHaveBeenCalled();
  });
});

describe('getUserId', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    delete process.env.PROCESSOR_AUTH_REQUIRED;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns null when req.auth is not set', async () => {
    const { getUserId } = await import('../auth');
    const mockReq = { auth: undefined } as unknown as Parameters<typeof getUserId>[0];
    expect(getUserId(mockReq)).toBeNull();
  });

  it('returns userId when auth is set', async () => {
    const { getUserId } = await import('../auth');
    const mockReq = { auth: { userId: 'user-123' } } as unknown as Parameters<typeof getUserId>[0];
    expect(getUserId(mockReq)).toBe('user-123');
  });

  it('returns null userId when auth exists but userId is not set', async () => {
    const { getUserId } = await import('../auth');
    const mockReq = { auth: { userId: null } } as unknown as Parameters<typeof getUserId>[0];
    expect(getUserId(mockReq)).toBeNull();
  });
});

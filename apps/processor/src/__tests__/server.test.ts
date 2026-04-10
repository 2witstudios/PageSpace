/**
 * Processor Service Server Tests
 *
 * Tests for the Express app wiring in server.ts:
 * - CORS origin callback (all branches)
 * - normalizeOrigin / getAllowedOrigins helpers (via CORS callback behaviour)
 * - /health endpoint
 * - /api/queue/status endpoint
 * - /api/job/:jobId endpoint
 * - Catch-all 404 handlers for /api and /cache
 * - Error-handling middleware
 * - start() initialisation path (success + failure)
 * - Cleanup interval registration
 * - SIGTERM handler registration
 *
 * Strategy
 * --------
 * server.ts calls start() as a top-level side-effect.
 * To prevent that side-effect from running real I/O we mock every
 * external import BEFORE the module is loaded with vi.mock(). Because
 * vi.mock() factories are hoisted to the top of the compiled output by
 * Vitest, any variables they close over must ALSO be hoisted with
 * vi.hoisted() — ordinary module-level declarations are not yet
 * initialised when the factories run.
 *
 * Each describe block that needs the server calls `await import('../server')`
 * inside a beforeEach after vi.resetModules(), giving it a fresh module with
 * clean shared mock state.
 *
 * Route handlers and middleware functions are captured from mockApp.use /
 * mockApp.get spy calls and then invoked directly in tests.
 *
 * NOTE on vi.mock paths: vi.mock paths are resolved relative to the TEST FILE,
 * not to server.ts. This file lives at src/__tests__/server.test.ts, so all
 * local mocks need '../' prefixes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted – all shared state that vi.mock factories close over MUST live
// here so it is initialised before the factory functions run.
// ---------------------------------------------------------------------------

const {
  // Capture arrays for Express registrations
  capturedUse,
  capturedGet,

  // ContentStore mock methods
  mockContentStoreInitialize,
  mockContentStoreCleanup,

  // QueueManager mock methods
  mockQueueManagerInitialize,
  mockQueueManagerGetQueueStatus,
  mockQueueManagerGetJob,
  mockQueueManagerShutdown,

  // Pointer to the CORS options object passed to cors()
  capturedCorsRef,

  // Pointer to the listen callback (evidence that start() ran)
  capturedListenRef,
} = vi.hoisted(() => {
  const capturedUse: any[][] = [];
  const capturedGet: Record<string, any[]> = {};

  const mockContentStoreInitialize = vi.fn().mockResolvedValue(undefined);
  const mockContentStoreCleanup = vi.fn().mockResolvedValue(0);

  const mockQueueManagerInitialize = vi.fn().mockResolvedValue(undefined);
  const mockQueueManagerGetQueueStatus = vi.fn();
  const mockQueueManagerGetJob = vi.fn();
  const mockQueueManagerShutdown = vi.fn().mockResolvedValue(undefined);

  // Use wrapper objects so we can mutate their .value from inside factories
  // without losing the reference.
  const capturedCorsRef = { value: null as any };
  const capturedListenRef = { value: null as (() => void) | null };

  return {
    capturedUse,
    capturedGet,
    mockContentStoreInitialize,
    mockContentStoreCleanup,
    mockQueueManagerInitialize,
    mockQueueManagerGetQueueStatus,
    mockQueueManagerGetJob,
    mockQueueManagerShutdown,
    capturedCorsRef,
    capturedListenRef,
  };
});

// ---------------------------------------------------------------------------
// vi.mock declarations – hoisted to the top of the compiled output by Vitest.
// Paths are relative to THIS TEST FILE (src/__tests__/server.test.ts).
// ---------------------------------------------------------------------------

vi.mock('dotenv', () => ({
  default: { config: vi.fn() },
}));

vi.mock('express', () => {
  const mockApp = {
    use: vi.fn((...args: any[]) => {
      capturedUse.push(args);
    }),
    get: vi.fn((path: string, ...handlers: any[]) => {
      capturedGet[`GET:${path}`] = handlers;
    }),
    listen: vi.fn((port: any, cb: () => void) => {
      capturedListenRef.value = cb;
      cb(); // fire immediately so start() resolves synchronously
    }),
  };

  const express: any = vi.fn(() => mockApp);
  express.json = vi.fn(() => 'json-middleware');

  // Router is called as both express.Router() and as a named import { Router }
  const mockRouter = vi.fn(() => ({
    use: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  }));
  express.Router = mockRouter;

  return {
    default: express,
    Router: mockRouter,   // named export: import { Router } from 'express'
    json: express.json,
  };
});

vi.mock('cors', () => ({
  default: vi.fn((options: any) => {
    capturedCorsRef.value = options;
    return 'cors-middleware';
  }),
}));

vi.mock('multer', () => {
  const multer: any = vi.fn(() => ({
    single: vi.fn(() => 'multer-single-middleware'),
    array: vi.fn(() => 'multer-array-middleware'),
  }));
  multer.memoryStorage = vi.fn(() => ({}));
  multer.diskStorage = vi.fn(() => ({}));
  return { default: multer };
});

vi.mock('../cache/content-store', () => ({
  ContentStore: vi.fn().mockImplementation(() => ({
    initialize: mockContentStoreInitialize,
    cleanupOldCache: mockContentStoreCleanup,
  })),
  isValidContentHash: vi.fn().mockReturnValue(true),
  InvalidContentHashError: class InvalidContentHashError extends Error {
    contentHash: string;
    constructor(hash: string) {
      super('Invalid content hash format');
      this.name = 'InvalidContentHashError';
      this.contentHash = hash;
    }
  },
}));

vi.mock('../workers/queue-manager', () => ({
  QueueManager: vi.fn().mockImplementation(() => ({
    initialize: mockQueueManagerInitialize,
    getQueueStatus: mockQueueManagerGetQueueStatus,
    getJob: mockQueueManagerGetJob,
    shutdown: mockQueueManagerShutdown,
  })),
}));

vi.mock('../api/optimize', () => ({ imageRouter: 'mock-image-router' }));
vi.mock('../api/upload', () => ({ uploadRouter: 'mock-upload-router' }));
vi.mock('../api/serve', () => ({ cacheRouter: 'mock-cache-router' }));
vi.mock('../api/ingest', () => ({ ingestRouter: 'mock-ingest-router' }));
vi.mock('../api/avatar', () => ({ default: 'mock-avatar-router' }));
vi.mock('../api/delete-file', () => ({ deleteFileRouter: 'mock-delete-file-router' }));

vi.mock('../middleware/auth', () => ({
  authenticateService: vi.fn((_req: any, _res: any, next: () => void) => next()),
  requireScope: vi.fn((_scope: string) =>
    vi.fn((_req: any, _res: any, next: () => void) => next()),
  ),
  AUTH_REQUIRED: true,
}));

vi.mock('../middleware/resource-binding', () => ({
  requireResourceBinding: vi.fn((_source?: string) =>
    vi.fn((_req: any, _res: any, next: () => void) => next()),
  ),
  requirePageBinding: vi.fn(() =>
    vi.fn((_req: any, _res: any, next: () => void) => next()),
  ),
}));

vi.mock('../services/siem-adapter', () => ({
  loadSiemConfig: vi.fn(() => ({ enabled: false, type: 'webhook' })),
  validateSiemConfig: vi.fn(() => ({ valid: true, errors: [] })),
}));

vi.mock('../db', () => ({
  setPageProcessing: vi.fn(),
  setPageCompleted: vi.fn(),
  setPageFailed: vi.fn(),
  setPageVisual: vi.fn(),
  getPoolForWorker: vi.fn(),
}));

vi.mock('@pagespace/lib/logger-config', () => ({
  loggers: {
    processor: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    security: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    api: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Resets all capture state and mock call histories between tests. */
function resetCaptures() {
  capturedUse.length = 0;
  for (const key of Object.keys(capturedGet)) {
    delete capturedGet[key];
  }
  capturedCorsRef.value = null;
  capturedListenRef.value = null;

  mockContentStoreInitialize.mockReset().mockResolvedValue(undefined);
  mockContentStoreCleanup.mockReset().mockResolvedValue(0);
  mockQueueManagerInitialize.mockReset().mockResolvedValue(undefined);
  mockQueueManagerGetQueueStatus.mockReset();
  mockQueueManagerGetJob.mockReset();
  mockQueueManagerShutdown.mockReset().mockResolvedValue(undefined);
}

/**
 * Returns a minimal mock req/res pair for exercising captured route handlers.
 * `statusCode.value` tracks the last code passed to res.status().
 */
function makeReqRes(overrides: {
  params?: Record<string, string>;
  body?: any;
  headers?: Record<string, string>;
} = {}) {
  const statusCode = { value: 200 };
  const jsonMock = vi.fn();
  const res: any = {
    status: vi.fn().mockImplementation((code: number) => {
      statusCode.value = code;
      return res; // chainable: res.status(404).json(...)
    }),
    json: jsonMock,
  };
  const req: any = {
    params: overrides.params ?? {},
    body: overrides.body ?? {},
    headers: overrides.headers ?? {},
    path: '/',
    method: 'GET',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    auth: undefined,
  };
  return { req, res, statusCode, jsonMock };
}

/**
 * Calls the CORS origin callback captured from the cors() invocation and
 * resolves to { err, allowed }.
 */
function callCorsOrigin(
  origin: string | undefined,
): Promise<{ err: Error | null; allowed: boolean }> {
  return new Promise((resolve) => {
    capturedCorsRef.value.origin(origin, (err: Error | null, allowed: boolean) => {
      resolve({ err, allowed });
    });
  });
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetCaptures();
  vi.resetModules();
  process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
  delete process.env.NODE_ENV;
  delete process.env.CORS_ORIGIN;
  delete process.env.WEB_APP_URL;
  delete process.env.ADDITIONAL_ALLOWED_ORIGINS;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// CORS origin callback
// ===========================================================================

describe('CORS origin callback', () => {
  beforeEach(async () => {
    await import('../server');
  });

  describe('given no origin header (non-browser client)', () => {
    it('should allow the request without error', async () => {
      const { err, allowed } = await callCorsOrigin(undefined);

      expect(err).toBeNull();
      expect(allowed).toBe(true);
    });
  });

  describe('given production environment with no origins configured', () => {
    it('should reject with CORS not configured error', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.CORS_ORIGIN;
      delete process.env.WEB_APP_URL;

      const { err, allowed } = await callCorsOrigin('https://example.com');

      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toBe('CORS not configured');
      expect(allowed).toBe(false);
    });

    it('should log a security error', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.CORS_ORIGIN;
      delete process.env.WEB_APP_URL;

      const { loggers } = await import('@pagespace/lib/logger-config');
      await callCorsOrigin('https://example.com');

      expect(loggers.processor.error).toHaveBeenCalledWith(
        'CORS rejected: no allowed origins configured',
        expect.objectContaining({ origin: 'https://example.com', severity: 'security' }),
      );
    });
  });

  describe('given development environment with no origins configured', () => {
    it('should allow the request', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.CORS_ORIGIN;
      delete process.env.WEB_APP_URL;

      const { err, allowed } = await callCorsOrigin('https://example.com');

      expect(err).toBeNull();
      expect(allowed).toBe(true);
    });

    it('should log a dev warning', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.CORS_ORIGIN;
      delete process.env.WEB_APP_URL;

      const { loggers } = await import('@pagespace/lib/logger-config');
      await callCorsOrigin('https://example.com');

      expect(loggers.processor.warn).toHaveBeenCalledWith(
        'CORS: no allowed origins configured (allowing in dev)',
        expect.objectContaining({ origin: 'https://example.com' }),
      );
    });
  });

  describe('given no NODE_ENV set', () => {
    it('should allow the request (treated as non-production)', async () => {
      delete process.env.NODE_ENV;
      delete process.env.CORS_ORIGIN;
      delete process.env.WEB_APP_URL;

      const { err, allowed } = await callCorsOrigin('https://any-origin.com');

      expect(err).toBeNull();
      expect(allowed).toBe(true);
    });
  });

  describe('given origin matches CORS_ORIGIN', () => {
    it('should allow the request', async () => {
      process.env.CORS_ORIGIN = 'https://app.example.com';

      const { err, allowed } = await callCorsOrigin('https://app.example.com');

      expect(err).toBeNull();
      expect(allowed).toBe(true);
    });
  });

  describe('given origin matches WEB_APP_URL', () => {
    it('should allow the request', async () => {
      process.env.WEB_APP_URL = 'https://webapp.example.com';

      const { err, allowed } = await callCorsOrigin('https://webapp.example.com');

      expect(err).toBeNull();
      expect(allowed).toBe(true);
    });
  });

  describe('given origin matches an ADDITIONAL_ALLOWED_ORIGINS entry', () => {
    it('should allow the request', async () => {
      process.env.WEB_APP_URL = 'https://app.example.com';
      process.env.ADDITIONAL_ALLOWED_ORIGINS =
        'https://staging.example.com,https://dev.example.com';

      const { err, allowed } = await callCorsOrigin('https://staging.example.com');

      expect(err).toBeNull();
      expect(allowed).toBe(true);
    });
  });

  describe('given origin is not in the allowed list', () => {
    it('should reject with origin not allowed error', async () => {
      process.env.WEB_APP_URL = 'https://app.example.com';

      const { err, allowed } = await callCorsOrigin('https://evil.example.com');

      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toBe('Origin not allowed');
      expect(allowed).toBe(false);
    });

    it('should log a security warning', async () => {
      process.env.WEB_APP_URL = 'https://app.example.com';

      const { loggers } = await import('@pagespace/lib/logger-config');
      await callCorsOrigin('https://evil.example.com');

      expect(loggers.processor.warn).toHaveBeenCalledWith(
        'CORS rejected: origin not in allowed list',
        expect.objectContaining({
          origin: 'https://evil.example.com',
          severity: 'security',
        }),
      );
    });
  });

  describe('given malformed origin string', () => {
    it('should reject (empty normalized form is not in allowed list)', async () => {
      process.env.WEB_APP_URL = 'https://app.example.com';

      const { err, allowed } = await callCorsOrigin('not-a-valid-url');

      expect(err).toBeInstanceOf(Error);
      expect(allowed).toBe(false);
    });
  });

  describe('given origin URL with path component', () => {
    it('should normalize and still match allowed origin', async () => {
      process.env.WEB_APP_URL = 'https://app.example.com';

      const { err, allowed } = await callCorsOrigin('https://app.example.com/some/path');

      expect(err).toBeNull();
      expect(allowed).toBe(true);
    });
  });

  describe('CORS configuration', () => {
    it('should configure credentials: true', () => {
      expect(capturedCorsRef.value).toBeDefined();
      expect(capturedCorsRef.value.credentials).toBe(true);
    });
  });
});

// ===========================================================================
// normalizeOrigin – observable via CORS callback decisions
// ===========================================================================

describe('normalizeOrigin (exercised via CORS callback)', () => {
  beforeEach(async () => {
    await import('../server');
  });

  describe('given valid HTTPS URL with path and query', () => {
    it('should strip path and query, keeping only scheme+host', async () => {
      process.env.CORS_ORIGIN = 'https://app.example.com';

      const { allowed } = await callCorsOrigin('https://app.example.com/deep/path?q=1');

      expect(allowed).toBe(true);
    });
  });

  describe('given URL with non-default port', () => {
    it('should preserve the port in normalised form', async () => {
      process.env.CORS_ORIGIN = 'http://localhost:3000';

      const { allowed } = await callCorsOrigin('http://localhost:3000');

      expect(allowed).toBe(true);
    });

    it('should reject a different port on the same host', async () => {
      process.env.CORS_ORIGIN = 'http://localhost:3000';

      const { allowed } = await callCorsOrigin('http://localhost:3001');

      expect(allowed).toBe(false);
    });
  });

  describe('given only invalid entries in ADDITIONAL_ALLOWED_ORIGINS', () => {
    it('should filter them out so allowed list is empty, triggering dev fallback', async () => {
      process.env.ADDITIONAL_ALLOWED_ORIGINS = 'not-a-url';
      delete process.env.CORS_ORIGIN;
      delete process.env.WEB_APP_URL;
      delete process.env.NODE_ENV;

      const { allowed } = await callCorsOrigin('https://whatever.com');

      // Empty allowed list + non-production → dev fallback allows
      expect(allowed).toBe(true);
    });
  });
});

// ===========================================================================
// getAllowedOrigins – observable via CORS callback decisions
// ===========================================================================

describe('getAllowedOrigins (exercised via CORS callback)', () => {
  beforeEach(async () => {
    await import('../server');
  });

  describe('given CORS_ORIGIN takes precedence over WEB_APP_URL', () => {
    it('should use CORS_ORIGIN and not include WEB_APP_URL', async () => {
      process.env.CORS_ORIGIN = 'https://cors.example.com';
      process.env.WEB_APP_URL = 'https://webapp.example.com';

      const corsResult = await callCorsOrigin('https://cors.example.com');
      const webResult = await callCorsOrigin('https://webapp.example.com');

      expect(corsResult.allowed).toBe(true);
      expect(webResult.allowed).toBe(false);
    });
  });

  describe('given WEB_APP_URL used when CORS_ORIGIN absent', () => {
    it('should allow origin matching WEB_APP_URL', async () => {
      delete process.env.CORS_ORIGIN;
      process.env.WEB_APP_URL = 'https://webapp.example.com';

      const { allowed } = await callCorsOrigin('https://webapp.example.com');

      expect(allowed).toBe(true);
    });
  });

  describe('given ADDITIONAL_ALLOWED_ORIGINS with surrounding whitespace', () => {
    it('should trim each entry and include them', async () => {
      process.env.WEB_APP_URL = 'https://app.example.com';
      process.env.ADDITIONAL_ALLOWED_ORIGINS =
        '  https://staging.example.com  ,  https://dev.example.com  ';

      const stagingResult = await callCorsOrigin('https://staging.example.com');
      const devResult = await callCorsOrigin('https://dev.example.com');

      expect(stagingResult.allowed).toBe(true);
      expect(devResult.allowed).toBe(true);
    });
  });

  describe('given no environment variables configured', () => {
    it('should produce empty allowed list; non-production allows via dev fallback', async () => {
      delete process.env.CORS_ORIGIN;
      delete process.env.WEB_APP_URL;
      delete process.env.ADDITIONAL_ALLOWED_ORIGINS;
      delete process.env.NODE_ENV;

      const { err, allowed } = await callCorsOrigin('https://anything.com');

      expect(err).toBeNull();
      expect(allowed).toBe(true);
    });
  });
});

// ===========================================================================
// Middleware & route registration
// ===========================================================================

describe('Express middleware registration', () => {
  beforeEach(async () => {
    await import('../server');
  });

  it('should register cors middleware via app.use()', () => {
    const corsArgs = capturedUse.find((args) => args.includes('cors-middleware'));
    expect(corsArgs).toBeDefined();
  });

  it('should register json body parser via app.use()', () => {
    const jsonArgs = capturedUse.find((args) => args.includes('json-middleware'));
    expect(jsonArgs).toBeDefined();
  });

  it('should mount upload router at /api/upload', () => {
    const mount = capturedUse.find((args) => args[0] === '/api/upload');
    expect(mount).toBeDefined();
    expect(mount).toContain('mock-upload-router');
  });

  it('should mount optimize router at /api/optimize', () => {
    const mount = capturedUse.find((args) => args[0] === '/api/optimize');
    expect(mount).toBeDefined();
    expect(mount).toContain('mock-image-router');
  });

  it('should mount ingest router at /api/ingest', () => {
    const mount = capturedUse.find((args) => args[0] === '/api/ingest');
    expect(mount).toBeDefined();
    expect(mount).toContain('mock-ingest-router');
  });

  it('should mount avatar router at /api/avatar', () => {
    const mount = capturedUse.find((args) => args[0] === '/api/avatar');
    expect(mount).toBeDefined();
    expect(mount).toContain('mock-avatar-router');
  });

  it('should mount cache router at /cache', () => {
    const mount = capturedUse.find((args) => args[0] === '/cache');
    expect(mount).toBeDefined();
    expect(mount).toContain('mock-cache-router');
  });

  it('should register GET handler for /health', () => {
    expect(capturedGet['GET:/health']).toBeDefined();
    expect(capturedGet['GET:/health'].length).toBeGreaterThan(0);
  });

  it('should register GET handler for /api/queue/status', () => {
    expect(capturedGet['GET:/api/queue/status']).toBeDefined();
  });

  it('should register GET handler for /api/job/:jobId', () => {
    expect(capturedGet['GET:/api/job/:jobId']).toBeDefined();
  });

  it('should register a 4-argument error handler via app.use()', () => {
    const errorHandlers = capturedUse.filter(
      (args) =>
        typeof args[args.length - 1] === 'function' &&
        (args[args.length - 1] as Function).length === 4,
    );
    expect(errorHandlers.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// /health endpoint
// ===========================================================================

describe('GET /health', () => {
  beforeEach(async () => {
    await import('../server');
  });

  function getHealthHandler() {
    const handlers = capturedGet['GET:/health'];
    expect(handlers).toBeDefined();
    return handlers[handlers.length - 1];
  }

  it('should return status: healthy', async () => {
    const { req, res, jsonMock } = makeReqRes();

    await getHealthHandler()(req, res);

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'healthy' }),
    );
  });

  it('should return service: processor', async () => {
    const { req, res, jsonMock } = makeReqRes();

    await getHealthHandler()(req, res);

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'processor' }),
    );
  });

  it('should return a valid ISO timestamp string', async () => {
    const { req, res, jsonMock } = makeReqRes();

    await getHealthHandler()(req, res);

    const body = jsonMock.mock.calls[0][0];
    expect(typeof body.timestamp).toBe('string');
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('should return memory stats with used, total, and rss fields', async () => {
    const { req, res, jsonMock } = makeReqRes();

    await getHealthHandler()(req, res);

    const { memory } = jsonMock.mock.calls[0][0];
    expect(typeof memory.used).toBe('number');
    expect(typeof memory.total).toBe('number');
    expect(typeof memory.rss).toBe('number');
    expect(memory.used).toBeGreaterThanOrEqual(0);
    expect(memory.total).toBeGreaterThanOrEqual(0);
    expect(memory.rss).toBeGreaterThanOrEqual(0);
  });

  it('should return integer MB values for all memory stats', async () => {
    const { req, res, jsonMock } = makeReqRes();

    await getHealthHandler()(req, res);

    const { memory } = jsonMock.mock.calls[0][0];
    expect(Number.isInteger(memory.used)).toBe(true);
    expect(Number.isInteger(memory.total)).toBe(true);
    expect(Number.isInteger(memory.rss)).toBe(true);
  });

  it('should include siem.enabled and siem.type when SIEM is disabled', async () => {
    const { req, res, jsonMock } = makeReqRes();

    await getHealthHandler()(req, res);

    const { siem } = jsonMock.mock.calls[0][0];
    expect(siem.enabled).toBe(false);
    expect(siem.type).toBe('webhook');
    expect(siem.cursor).toBeUndefined();
  });

  it('should include siem.cursor when SIEM is enabled and cache is pre-warmed', async () => {
    const { loadSiemConfig } = await import('../services/siem-adapter');
    const { getPoolForWorker } = await import('../db');
    const { refreshSiemCursorCache } = await import('../server');

    const mockRelease = vi.fn();
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [{ lastDeliveredAt: new Date('2026-04-10T12:00:00Z'), lastError: null, deliveryCount: 42 }],
      rowCount: 1,
    });
    (getPoolForWorker as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      connect: vi.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });

    // Pre-warm the cache (health endpoint serves cached data, never blocks on DB)
    await refreshSiemCursorCache();

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM siem_delivery_cursors'),
      ['activity_logs'],
    );
    expect(mockRelease).toHaveBeenCalled();

    // Now call health with SIEM enabled — should serve from cache
    (loadSiemConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({ enabled: true, type: 'webhook' });

    const { req, res, jsonMock } = makeReqRes();
    await getHealthHandler()(req, res);

    const { siem } = jsonMock.mock.calls[0][0];
    expect(siem.enabled).toBe(true);
    expect(siem.type).toBe('webhook');
    expect(siem.cursor).toBeDefined();
    expect(siem.cursor.deliveryCount).toBe(42);
    expect(siem.cursor.lastError).toBeNull();
  });
});

// ===========================================================================
// /api/queue/status endpoint
// ===========================================================================

describe('GET /api/queue/status', () => {
  beforeEach(async () => {
    await import('../server');
  });

  function getQueueStatusHandler() {
    const handlers = capturedGet['GET:/api/queue/status'];
    expect(handlers).toBeDefined();
    return handlers[handlers.length - 1];
  }

  describe('given queueManager.getQueueStatus() succeeds', () => {
    it('should respond with the queue status JSON', async () => {
      const fakeStatus = {
        'ingest-file': { pending: 1, active: 0, completed: 5, failed: 0 },
      };
      mockQueueManagerGetQueueStatus.mockReturnValue(fakeStatus);

      const { req, res, jsonMock } = makeReqRes();
      await getQueueStatusHandler()(req, res);

      expect(jsonMock).toHaveBeenCalledWith(fakeStatus);
    });
  });

  describe('given queueManager.getQueueStatus() throws', () => {
    it('should respond with 500 and error message', async () => {
      mockQueueManagerGetQueueStatus.mockImplementation(() => {
        throw new Error('Queue unavailable');
      });

      const { req, res, statusCode, jsonMock } = makeReqRes();
      await getQueueStatusHandler()(req, res);

      expect(statusCode.value).toBe(500);
      expect(jsonMock).toHaveBeenCalledWith({ error: 'Failed to get queue status' });
    });
  });
});

// ===========================================================================
// /api/job/:jobId endpoint
// ===========================================================================

describe('GET /api/job/:jobId', () => {
  beforeEach(async () => {
    await import('../server');
  });

  function getJobHandler() {
    const handlers = capturedGet['GET:/api/job/:jobId'];
    expect(handlers).toBeDefined();
    return handlers[handlers.length - 1];
  }

  describe('given job exists', () => {
    it('should call getJob with the jobId param and respond with job JSON', async () => {
      const fakeJob = { id: 'job-abc', status: 'completed', type: 'ingest-file' };
      mockQueueManagerGetJob.mockResolvedValue(fakeJob);

      const { req, res, jsonMock } = makeReqRes({ params: { jobId: 'job-abc' } });
      await getJobHandler()(req, res);

      expect(mockQueueManagerGetJob).toHaveBeenCalledWith('job-abc');
      expect(jsonMock).toHaveBeenCalledWith(fakeJob);
    });
  });

  describe('given job does not exist', () => {
    it('should respond with 404 and job not found message', async () => {
      mockQueueManagerGetJob.mockResolvedValue(null);

      const { req, res, statusCode, jsonMock } = makeReqRes({
        params: { jobId: 'missing-job' },
      });
      await getJobHandler()(req, res);

      expect(statusCode.value).toBe(404);
      expect(jsonMock).toHaveBeenCalledWith({ error: 'Job not found' });
    });
  });

  describe('given getJob throws', () => {
    it('should respond with 500 and error message', async () => {
      mockQueueManagerGetJob.mockRejectedValue(new Error('DB error'));

      const { req, res, statusCode, jsonMock } = makeReqRes({
        params: { jobId: 'job-xyz' },
      });
      await getJobHandler()(req, res);

      expect(statusCode.value).toBe(500);
      expect(jsonMock).toHaveBeenCalledWith({ error: 'Failed to get job status' });
    });
  });
});

// ===========================================================================
// Catch-all 404 handlers
// ===========================================================================

describe('Catch-all 404 handlers', () => {
  beforeEach(async () => {
    await import('../server');
  });

  describe('/api catch-all', () => {
    it('should respond 404 with endpoint not found', () => {
      // The /api catch-all is the app.use('/api', ...) mount whose final arg
      // is a 2-parameter (req, res) function — not a router.
      const apiCatchAll = capturedUse.find(
        (args) =>
          args[0] === '/api' &&
          typeof args[args.length - 1] === 'function' &&
          (args[args.length - 1] as Function).length === 2,
      );
      expect(apiCatchAll).toBeDefined();

      const handler = apiCatchAll![apiCatchAll!.length - 1];
      const { req, res, statusCode, jsonMock } = makeReqRes();

      handler(req, res);

      expect(statusCode.value).toBe(404);
      expect(jsonMock).toHaveBeenCalledWith({ error: 'Endpoint not found' });
    });
  });

  describe('/cache catch-all', () => {
    it('should respond 404 with endpoint not found', () => {
      // Multiple /cache mounts exist: the cacheRouter mount and the catch-all.
      // The catch-all has a 2-param final handler and does not include the mock router string.
      const cacheCatchAll = capturedUse.find(
        (args) =>
          args[0] === '/cache' &&
          typeof args[args.length - 1] === 'function' &&
          (args[args.length - 1] as Function).length === 2 &&
          !args.includes('mock-cache-router'),
      );
      expect(cacheCatchAll).toBeDefined();

      const handler = cacheCatchAll![cacheCatchAll!.length - 1];
      const { req, res, statusCode, jsonMock } = makeReqRes();

      handler(req, res);

      expect(statusCode.value).toBe(404);
      expect(jsonMock).toHaveBeenCalledWith({ error: 'Endpoint not found' });
    });
  });
});

// ===========================================================================
// Error-handling middleware
// ===========================================================================

describe('Error handling middleware', () => {
  beforeEach(async () => {
    await import('../server');
  });

  function getErrorHandler(): (err: any, req: any, res: any, next: any) => void {
    const entry = capturedUse.find(
      (args) =>
        typeof args[args.length - 1] === 'function' &&
        (args[args.length - 1] as Function).length === 4,
    );
    expect(entry).toBeDefined();
    return entry![entry!.length - 1];
  }

  describe('given an error with a status property', () => {
    it('should respond with the error status code', () => {
      const { req, res, statusCode, jsonMock } = makeReqRes();
      const err = Object.assign(new Error('Not Found'), { status: 404 });

      getErrorHandler()(err, req, res, vi.fn());

      expect(statusCode.value).toBe(404);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Not Found' }),
      );
    });
  });

  describe('given an error without a status property', () => {
    it('should default to 500', () => {
      const { req, res, statusCode } = makeReqRes();
      const err = new Error('Something went wrong');

      getErrorHandler()(err, req, res, vi.fn());

      expect(statusCode.value).toBe(500);
    });

    it('should include the error message in the response', () => {
      const { req, res, jsonMock } = makeReqRes();
      const err = new Error('Something went wrong');

      getErrorHandler()(err, req, res, vi.fn());

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Something went wrong' }),
      );
    });
  });

  describe('given an error object with no message', () => {
    it('should fall back to "Internal server error"', () => {
      const { req, res, jsonMock } = makeReqRes();
      const err = { status: 500 }; // plain object, no .message

      getErrorHandler()(err, req, res, vi.fn());

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Internal server error' }),
      );
    });
  });

  describe('given NODE_ENV=development', () => {
    it('should include stack trace in the response', () => {
      process.env.NODE_ENV = 'development';
      const { req, res, jsonMock } = makeReqRes();
      const err = new Error('Dev error');
      err.stack = 'Error: Dev error\n    at somewhere.ts:10';

      getErrorHandler()(err, req, res, vi.fn());

      const body = jsonMock.mock.calls[0][0];
      expect(body.stack).toBeDefined();
      expect(body.stack).toContain('Dev error');
    });
  });

  describe('given NODE_ENV=production', () => {
    it('should not include stack trace in the response', () => {
      process.env.NODE_ENV = 'production';
      const { req, res, jsonMock } = makeReqRes();
      const err = new Error('Prod error');
      err.stack = 'Error: Prod error\n    at somewhere.ts:10';

      getErrorHandler()(err, req, res, vi.fn());

      const body = jsonMock.mock.calls[0][0];
      expect(body.stack).toBeUndefined();
    });
  });
});

// ===========================================================================
// start() function – initialisation behaviour
// ===========================================================================

describe('start() function', () => {
  describe('given successful initialisation', () => {
    it('should call contentStore.initialize()', async () => {
      await import('../server');
      // Settle any async ticks from the fire-and-forget start() call
      await new Promise((r) => setTimeout(r, 10));

      expect(mockContentStoreInitialize).toHaveBeenCalledOnce();
    });

    it('should call queueManager.initialize()', async () => {
      await import('../server');
      await new Promise((r) => setTimeout(r, 10));

      expect(mockQueueManagerInitialize).toHaveBeenCalledOnce();
    });

    it('should call app.listen() (evidenced by capturedListenRef being populated)', async () => {
      await import('../server');
      await new Promise((r) => setTimeout(r, 10));

      expect(capturedListenRef.value).not.toBeNull();
    });
  });

  describe('given contentStore.initialize() rejects', () => {
    it('should call process.exit(1)', async () => {
      mockContentStoreInitialize.mockRejectedValueOnce(new Error('Disk full'));

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await import('../server');
      await new Promise((r) => setTimeout(r, 20));

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });
  });

  describe('given queueManager.initialize() rejects', () => {
    it('should call process.exit(1)', async () => {
      mockQueueManagerInitialize.mockRejectedValueOnce(
        new Error('PgBoss connection failed'),
      );

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await import('../server');
      await new Promise((r) => setTimeout(r, 20));

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });
  });
});

// ===========================================================================
// Cleanup interval
// ===========================================================================

describe('Cleanup interval', () => {
  it('should register a setInterval with a 1-hour delay', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    await import('../server');
    await new Promise((r) => setTimeout(r, 10));

    const hourMs = 60 * 60 * 1000;
    const hourIntervals = setIntervalSpy.mock.calls.filter(
      (call) => call[1] === hourMs,
    );
    expect(hourIntervals.length).toBeGreaterThanOrEqual(1);

    setIntervalSpy.mockRestore();
  });

  it('should call contentStore.cleanupOldCache() when the interval fires', async () => {
    const hourMs = 60 * 60 * 1000;
    let capturedIntervalCb: (() => Promise<void>) | null = null;

    vi.spyOn(globalThis, 'setInterval').mockImplementation((cb: any, ms?: number) => {
      if (ms === hourMs) capturedIntervalCb = cb;
      return 0 as any;
    });

    await import('../server');
    await new Promise((r) => setTimeout(r, 10));

    expect(capturedIntervalCb).not.toBeNull();

    mockContentStoreCleanup.mockResolvedValueOnce(3);
    await capturedIntervalCb!();

    expect(mockContentStoreCleanup).toHaveBeenCalledOnce();
  });

  it('should silently swallow cleanupOldCache() errors inside the interval', async () => {
    const hourMs = 60 * 60 * 1000;
    let capturedIntervalCb: (() => Promise<void>) | null = null;

    vi.spyOn(globalThis, 'setInterval').mockImplementation((cb: any, ms?: number) => {
      if (ms === hourMs) capturedIntervalCb = cb;
      return 0 as any;
    });

    await import('../server');
    await new Promise((r) => setTimeout(r, 10));

    mockContentStoreCleanup.mockRejectedValueOnce(new Error('IO error'));

    // Must not propagate — the interval handler catches internally
    await expect(capturedIntervalCb!()).resolves.toBeUndefined();
  });
});

// ===========================================================================
// SIGTERM handler
// ===========================================================================

describe('SIGTERM handler', () => {
  it('should register a process.on("SIGTERM") listener', async () => {
    const onSpy = vi.spyOn(process, 'on');

    await import('../server');
    await new Promise((r) => setTimeout(r, 10));

    const sigtermCall = onSpy.mock.calls.find((call) => call[0] === 'SIGTERM');
    expect(sigtermCall).toBeDefined();

    onSpy.mockRestore();
  });

  it('should call queueManager.shutdown() and process.exit(0) when SIGTERM fires', async () => {
    let capturedHandler: (() => Promise<void>) | null = null;

    vi.spyOn(process, 'on').mockImplementation((event: any, cb: any) => {
      if (event === 'SIGTERM') capturedHandler = cb;
      return process;
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('../server');
    await new Promise((r) => setTimeout(r, 10));

    expect(capturedHandler).not.toBeNull();

    await capturedHandler!();

    expect(mockQueueManagerShutdown).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });
});

// ===========================================================================
// Exported instances
// ===========================================================================

describe('Exported instances', () => {
  it('should export a contentStore object', async () => {
    const server = await import('../server');

    expect(server.contentStore).toBeDefined();
    expect(typeof server.contentStore).toBe('object');
  });

  it('should export a queueManager object', async () => {
    const server = await import('../server');

    expect(server.queueManager).toBeDefined();
    expect(typeof server.queueManager).toBe('object');
  });

  it('contentStore should have initialize method', async () => {
    const server = await import('../server');

    expect(typeof server.contentStore.initialize).toBe('function');
  });

  it('queueManager should have getQueueStatus method', async () => {
    const server = await import('../server');

    expect(typeof server.queueManager.getQueueStatus).toBe('function');
  });
});

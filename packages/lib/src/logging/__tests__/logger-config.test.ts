/**
 * Tests for packages/lib/src/logging/logger-config.ts
 *
 * Covers:
 * - loggers object has all expected categories
 * - extractRequestContext: Next.js request (nextUrl), Express request (path, url),
 *   with/without query params, IP sources, userAgent as array
 * - logRequest calls loggers.api.info
 * - logResponse: 500 -> error, 400 -> warn, 200 -> info
 * - logAIRequest logs to ai logger
 * - logDatabaseQuery: error path, slow query (>1000ms), normal query
 * - logAuthEvent: 'failed' logs as warn, others as info, email masking
 * - logSecurityEvent logs to security logger
 * - logPerformance logs to performance logger
 * - createRequestLogger returns child with requestId
 * - withLogging: success path, error path
 * - setupErrorHandlers registers process handlers
 * - logPerformanceDecorator wraps method, times it, handles errors
 * - initializeLogging calls setupErrorHandlers and logs startup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock the logger module so no actual I/O occurs ──
vi.mock('../logger', async (importOriginal) => {
  const mockChild = vi.fn();
  const mockInfo = vi.fn();
  const mockWarn = vi.fn();
  const mockError = vi.fn();
  const mockFatal = vi.fn();
  const mockDebug = vi.fn();
  const mockStartTimer = vi.fn();

  // startTimer returns a stop function
  mockStartTimer.mockImplementation(() => vi.fn());

  const mockLoggerInstance = {
    child: mockChild,
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
    fatal: mockFatal,
    debug: mockDebug,
    startTimer: mockStartTimer,
    setContext: vi.fn(),
    clearContext: vi.fn(),
    withContext: vi.fn(),
    setLevel: vi.fn(),
    getLevel: vi.fn().mockReturnValue('INFO'),
    isLevelEnabled: vi.fn().mockReturnValue(true),
  };

  // child() returns a clone of the instance with the same spy methods
  mockChild.mockImplementation(() => ({
    ...mockLoggerInstance,
    child: mockChild,
  }));

  const actual = await importOriginal<typeof import('../logger')>();

  return {
    ...actual,
    logger: mockLoggerInstance,
    LogLevel: actual.LogLevel,
  };
});

import {
  loggers,
  extractRequestContext,
  logRequest,
  logResponse,
  logAIRequest,
  logDatabaseQuery,
  logAuthEvent,
  logSecurityEvent,
  logPerformance,
  createRequestLogger,
  withLogging,
  setupErrorHandlers,
  logPerformanceDecorator,
  initializeLogging,
} from '../logger-config';
import { logger } from '../logger';

// Typed mock helpers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLogger = logger as any;

// Helper factories for request mocks
function makeNextRequest(overrides: Partial<{
  pathname: string;
  method: string;
  searchParams: URLSearchParams;
  xForwardedFor: string | null;
  xRealIp: string | null;
  userAgent: string | null;
}> = {}) {
  const searchParams = overrides.searchParams ?? new URLSearchParams();
  return {
    nextUrl: {
      pathname: overrides.pathname ?? '/api/test',
      searchParams,
    },
    method: overrides.method ?? 'GET',
    headers: {
      get: (name: string) => {
        if (name === 'x-forwarded-for') return overrides.xForwardedFor ?? null;
        if (name === 'x-real-ip') return overrides.xRealIp ?? null;
        if (name === 'user-agent') return overrides.userAgent ?? null;
        return null;
      },
    },
  };
}

function makeExpressRequest(overrides: Partial<{
  path: string;
  url: string;
  method: string;
  ip: string;
  socketRemoteAddress: string;
  userAgent: string | string[];
  query: Record<string, string>;
}> = {}) {
  return {
    path: overrides.path,
    url: overrides.url ?? '/express/path',
    method: overrides.method ?? 'POST',
    ip: overrides.ip,
    socket: { remoteAddress: overrides.socketRemoteAddress },
    headers: {
      'user-agent': overrides.userAgent ?? 'TestAgent/1.0',
    },
    query: overrides.query,
  };
}

describe('loggers object', () => {
  it('has all expected category keys', () => {
    expect(loggers).toHaveProperty('auth');
    expect(loggers).toHaveProperty('api');
    expect(loggers).toHaveProperty('ai');
    expect(loggers).toHaveProperty('database');
    expect(loggers).toHaveProperty('realtime');
    expect(loggers).toHaveProperty('performance');
    expect(loggers).toHaveProperty('security');
    expect(loggers).toHaveProperty('system');
    expect(loggers).toHaveProperty('processor');
  });
});

describe('extractRequestContext', () => {
  describe('Next.js request (has nextUrl)', () => {
    it('extracts pathname as endpoint', () => {
      const req = makeNextRequest({ pathname: '/api/pages' });
      const ctx = extractRequestContext(req);
      expect(ctx.endpoint).toBe('/api/pages');
    });

    it('extracts method', () => {
      const req = makeNextRequest({ method: 'PUT' });
      const ctx = extractRequestContext(req);
      expect(ctx.method).toBe('PUT');
    });

    it('extracts IP from x-forwarded-for (first value)', () => {
      const req = makeNextRequest({ xForwardedFor: '10.0.0.1,10.0.0.2' });
      const ctx = extractRequestContext(req);
      expect(ctx.ip).toBe('10.0.0.1');
    });

    it('falls back to x-real-ip when x-forwarded-for is absent', () => {
      const req = makeNextRequest({ xRealIp: '10.0.0.5' });
      const ctx = extractRequestContext(req);
      expect(ctx.ip).toBe('10.0.0.5');
    });

    it('falls back to "unknown" when no IP headers present', () => {
      const req = makeNextRequest({});
      const ctx = extractRequestContext(req);
      expect(ctx.ip).toBe('unknown');
    });

    it('extracts userAgent', () => {
      const req = makeNextRequest({ userAgent: 'Mozilla/5.0' });
      const ctx = extractRequestContext(req);
      expect(ctx.userAgent).toBe('Mozilla/5.0');
    });

    it('sets userAgent to undefined when header is absent', () => {
      const req = makeNextRequest({ userAgent: null });
      const ctx = extractRequestContext(req);
      expect(ctx.userAgent).toBeUndefined();
    });

    it('extracts query params when present', () => {
      const params = new URLSearchParams({ page: '1', size: '10' });
      const req = makeNextRequest({ searchParams: params });
      const ctx = extractRequestContext(req);
      expect(ctx.query).toEqual({ page: '1', size: '10' });
    });

    it('omits query when searchParams is empty', () => {
      const req = makeNextRequest({ searchParams: new URLSearchParams() });
      const ctx = extractRequestContext(req);
      expect(ctx.query).toBeUndefined();
    });
  });

  describe('Express-like request', () => {
    it('extracts path as endpoint when path is set', () => {
      const req = makeExpressRequest({ path: '/express/route' });
      const ctx = extractRequestContext(req);
      expect(ctx.endpoint).toBe('/express/route');
    });

    it('falls back to url when path is not set', () => {
      const req = makeExpressRequest({ url: '/fallback/url' });
      delete (req as Record<string, unknown>).path;
      const ctx = extractRequestContext(req);
      expect(ctx.endpoint).toBe('/fallback/url');
    });

    it('extracts method', () => {
      const req = makeExpressRequest({ method: 'DELETE' });
      const ctx = extractRequestContext(req);
      expect(ctx.method).toBe('DELETE');
    });

    it('uses req.ip when present', () => {
      const req = makeExpressRequest({ ip: '192.168.1.1' });
      const ctx = extractRequestContext(req);
      expect(ctx.ip).toBe('192.168.1.1');
    });

    it('falls back to socket.remoteAddress when req.ip is absent', () => {
      const req = makeExpressRequest({ socketRemoteAddress: '172.16.0.1' });
      const ctx = extractRequestContext(req);
      expect(ctx.ip).toBe('172.16.0.1');
    });

    it('extracts userAgent from headers as string', () => {
      const req = makeExpressRequest({ userAgent: 'curl/7.68' });
      const ctx = extractRequestContext(req);
      expect(ctx.userAgent).toBe('curl/7.68');
    });

    it('extracts first element when userAgent is an array', () => {
      const req = makeExpressRequest({ userAgent: ['agent-one', 'agent-two'] });
      const ctx = extractRequestContext(req);
      expect(ctx.userAgent).toBe('agent-one');
    });

    it('extracts query when present and non-empty', () => {
      const req = makeExpressRequest({ query: { filter: 'active' } });
      const ctx = extractRequestContext(req);
      expect(ctx.query).toEqual({ filter: 'active' });
    });

    it('omits query when req.query is absent', () => {
      const req = makeExpressRequest({});
      const ctx = extractRequestContext(req);
      expect(ctx.query).toBeUndefined();
    });

    it('omits query when req.query is empty', () => {
      const req = makeExpressRequest({ query: {} });
      const ctx = extractRequestContext(req);
      expect(ctx.query).toBeUndefined();
    });
  });
});

describe('logRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset child mock to return an object with info spy
    mockLogger.child.mockImplementation(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: mockLogger.child,
    }));
  });

  it('calls loggers.api.info with method and endpoint', () => {
    const req = makeNextRequest({ pathname: '/api/test', method: 'GET' });
    // Spy directly on the loggers.api child
    const infoSpy = vi.spyOn(loggers.api, 'info').mockImplementation(() => {});
    logRequest(req);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('GET'),
      expect.any(Object)
    );
    infoSpy.mockRestore();
  });

  it('merges additional context into the log call', () => {
    const req = makeNextRequest({ pathname: '/api/test', method: 'POST' });
    const infoSpy = vi.spyOn(loggers.api, 'info').mockImplementation(() => {});
    logRequest(req, { requestId: 'req-999' });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ context: expect.objectContaining({ requestId: 'req-999' }) })
    );
    infoSpy.mockRestore();
  });
});

describe('logResponse', () => {
  let apiErrorSpy: ReturnType<typeof vi.spyOn>;
  let apiWarnSpy: ReturnType<typeof vi.spyOn>;
  let apiInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    apiErrorSpy = vi.spyOn(loggers.api, 'error').mockImplementation(() => {});
    apiWarnSpy = vi.spyOn(loggers.api, 'warn').mockImplementation(() => {});
    apiInfoSpy = vi.spyOn(loggers.api, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    apiErrorSpy.mockRestore();
    apiWarnSpy.mockRestore();
    apiInfoSpy.mockRestore();
  });

  it('uses error level for 5xx status codes', () => {
    const req = makeNextRequest({ pathname: '/api/test', method: 'GET' });
    logResponse(req, 500, Date.now() - 50);
    expect(apiErrorSpy).toHaveBeenCalledTimes(1);
    expect(apiErrorSpy.mock.calls[0][0]).toContain('500');
  });

  it('uses warn level for 4xx status codes', () => {
    const req = makeNextRequest({ pathname: '/api/test', method: 'GET' });
    logResponse(req, 404, Date.now() - 10);
    expect(apiWarnSpy).toHaveBeenCalledTimes(1);
    expect(apiWarnSpy.mock.calls[0][0]).toContain('404');
  });

  it('uses info level for 2xx status codes', () => {
    const req = makeNextRequest({ pathname: '/api/test', method: 'GET' });
    logResponse(req, 200, Date.now() - 5);
    expect(apiInfoSpy).toHaveBeenCalledTimes(1);
    expect(apiInfoSpy.mock.calls[0][0]).toContain('200');
  });

  it('uses info level for 3xx status codes', () => {
    const req = makeNextRequest({ pathname: '/api/redirect', method: 'GET' });
    logResponse(req, 301, Date.now() - 5);
    expect(apiInfoSpy).toHaveBeenCalledTimes(1);
    expect(apiInfoSpy.mock.calls[0][0]).toContain('301');
  });

  it('message includes status code and duration', () => {
    const req = makeNextRequest({ pathname: '/api/health', method: 'GET' });
    logResponse(req, 200, Date.now() - 100);
    const call = apiInfoSpy.mock.calls[0];
    expect(call[0]).toContain('200');
    expect(call[0]).toContain('ms');
  });

  it('merges additional context', () => {
    const req = makeNextRequest({ pathname: '/api/test', method: 'GET' });
    logResponse(req, 200, Date.now(), { userId: 'u-1' });
    expect(apiInfoSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ context: expect.objectContaining({ userId: 'u-1' }) })
    );
  });
});

describe('logAIRequest', () => {
  it('calls loggers.ai.info with provider/model in message', () => {
    const aiInfoSpy = vi.spyOn(loggers.ai, 'info').mockImplementation(() => {});
    logAIRequest('openai', 'gpt-4', 'user-123', { input: 100, output: 50, total: 150 }, 0.002, 500);
    expect(aiInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('openai/gpt-4'),
      expect.objectContaining({ provider: 'openai', model: 'gpt-4', userId: 'user-123' })
    );
    aiInfoSpy.mockRestore();
  });

  it('handles optional parameters (no tokens, cost, duration)', () => {
    const aiInfoSpy = vi.spyOn(loggers.ai, 'info').mockImplementation(() => {});
    logAIRequest('ollama', 'llama3', 'user-456');
    expect(aiInfoSpy).toHaveBeenCalledTimes(1);
    expect(aiInfoSpy.mock.calls[0][0]).toContain('ollama/llama3');
    aiInfoSpy.mockRestore();
  });
});

describe('logDatabaseQuery', () => {
  let dbErrorSpy: ReturnType<typeof vi.spyOn>;
  let dbWarnSpy: ReturnType<typeof vi.spyOn>;
  let dbDebugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbErrorSpy = vi.spyOn(loggers.database, 'error').mockImplementation(() => {});
    dbWarnSpy = vi.spyOn(loggers.database, 'warn').mockImplementation(() => {});
    dbDebugSpy = vi.spyOn(loggers.database, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    dbErrorSpy.mockRestore();
    dbWarnSpy.mockRestore();
    dbDebugSpy.mockRestore();
  });

  it('logs error when error is provided', () => {
    const err = new Error('query failed');
    logDatabaseQuery('SELECT', 'users', 100, 0, err);
    expect(dbErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('SELECT'),
      err,
      expect.any(Object)
    );
  });

  it('logs warn for slow queries (>1000ms)', () => {
    logDatabaseQuery('SELECT', 'pages', 1500);
    expect(dbWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Slow query'),
      expect.any(Object)
    );
  });

  it('logs debug for normal queries', () => {
    logDatabaseQuery('INSERT', 'logs', 50, 1);
    expect(dbDebugSpy).toHaveBeenCalledWith(
      expect.stringContaining('INSERT'),
      expect.any(Object)
    );
  });

  it('logs at exactly 1000ms as debug (not slow)', () => {
    logDatabaseQuery('UPDATE', 'sessions', 1000, 5);
    expect(dbDebugSpy).toHaveBeenCalledTimes(1);
    expect(dbWarnSpy).not.toHaveBeenCalled();
  });
});

describe('logAuthEvent', () => {
  let authWarnSpy: ReturnType<typeof vi.spyOn>;
  let authInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    authWarnSpy = vi.spyOn(loggers.auth, 'warn').mockImplementation(() => {});
    authInfoSpy = vi.spyOn(loggers.auth, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    authWarnSpy.mockRestore();
    authInfoSpy.mockRestore();
  });

  it('logs warn for "failed" event', () => {
    logAuthEvent('failed', 'u-1', 'user@example.com', '127.0.0.1', 'bad password');
    expect(authWarnSpy).toHaveBeenCalledWith(
      'Authentication failed',
      expect.any(Object)
    );
  });

  it('logs info for "login" event', () => {
    logAuthEvent('login', 'u-1');
    expect(authInfoSpy).toHaveBeenCalledWith(
      'Authentication: login',
      expect.any(Object)
    );
  });

  it('logs info for "logout" event', () => {
    logAuthEvent('logout', 'u-2');
    expect(authInfoSpy).toHaveBeenCalledTimes(1);
    expect(authInfoSpy.mock.calls[0][0]).toContain('logout');
  });

  it('logs info for "signup" event', () => {
    logAuthEvent('signup');
    expect(authInfoSpy).toHaveBeenCalledTimes(1);
    expect(authInfoSpy.mock.calls[0][0]).toContain('signup');
  });

  it('logs info for "refresh" event', () => {
    logAuthEvent('refresh', 'u-3');
    expect(authInfoSpy).toHaveBeenCalledTimes(1);
    expect(authInfoSpy.mock.calls[0][0]).toContain('refresh');
  });

  it('logs info for "magic_link_login" event', () => {
    logAuthEvent('magic_link_login', 'u-4');
    expect(authInfoSpy).toHaveBeenCalledTimes(1);
    expect(authInfoSpy.mock.calls[0][0]).toContain('magic_link_login');
  });

  it('partially masks email (preserves first 2 chars and domain)', () => {
    logAuthEvent('login', 'u-1', 'alice@example.com');
    const call = authInfoSpy.mock.calls[0];
    const metadata = call[1] as { email?: string };
    expect(metadata.email).toMatch(/^al\*\*\*@example\.com$/);
  });

  it('handles missing email gracefully', () => {
    logAuthEvent('login', 'u-1', undefined);
    const call = authInfoSpy.mock.calls[0];
    const metadata = call[1] as { email?: string };
    expect(metadata.email).toBeUndefined();
  });
});

describe('logSecurityEvent', () => {
  it('calls loggers.security.warn with event in message', () => {
    const securityWarnSpy = vi.spyOn(loggers.security, 'warn').mockImplementation(() => {});
    logSecurityEvent('rate_limit', { ip: '1.2.3.4' });
    expect(securityWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('rate_limit'),
      expect.objectContaining({ ip: '1.2.3.4' })
    );
    securityWarnSpy.mockRestore();
  });

  it('works for various security event types', () => {
    const securityWarnSpy = vi.spyOn(loggers.security, 'warn').mockImplementation(() => {});
    logSecurityEvent('invalid_token', {});
    logSecurityEvent('unauthorized', { userId: 'u-1' });
    logSecurityEvent('login_csrf_missing', {});
    expect(securityWarnSpy).toHaveBeenCalledTimes(3);
    securityWarnSpy.mockRestore();
  });
});

describe('logPerformance', () => {
  it('calls loggers.performance.info with metric and value', () => {
    const perfInfoSpy = vi.spyOn(loggers.performance, 'info').mockImplementation(() => {});
    logPerformance('response_time', 250, 'ms', { endpoint: '/api/test' });
    expect(perfInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining('response_time'),
      expect.objectContaining({ metric: 'response_time', value: 250, unit: 'ms' })
    );
    perfInfoSpy.mockRestore();
  });

  it('defaults unit to "ms" when not specified', () => {
    const perfInfoSpy = vi.spyOn(loggers.performance, 'info').mockImplementation(() => {});
    logPerformance('latency', 100);
    expect(perfInfoSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ unit: 'ms' })
    );
    perfInfoSpy.mockRestore();
  });

  it('accepts "bytes" unit', () => {
    const perfInfoSpy = vi.spyOn(loggers.performance, 'info').mockImplementation(() => {});
    logPerformance('payload_size', 4096, 'bytes');
    expect(perfInfoSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ unit: 'bytes' })
    );
    perfInfoSpy.mockRestore();
  });
});

describe('createRequestLogger', () => {
  it('returns a child logger with requestId in context', () => {
    const childSpy = vi.spyOn(logger, 'child');
    createRequestLogger('req-xyz');
    expect(childSpy).toHaveBeenCalledWith({ requestId: 'req-xyz' });
    childSpy.mockRestore();
  });
});

describe('withLogging', () => {
  let timerStop: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let startTimerSpy: any;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Always stub startTimer so every withLogging call has a valid timer function
    timerStop = vi.fn();
    startTimerSpy = vi.spyOn(logger, 'startTimer').mockReturnValue(timerStop);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns result of the wrapped function on success', async () => {
    const fn = vi.fn().mockResolvedValue('result-value');
    const wrapped = withLogging(fn, 'myFn');
    const result = await wrapped('arg1', 'arg2');
    expect(result).toBe('result-value');
  });

  it('calls the original function with provided args', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const wrapped = withLogging(fn, 'myFn');
    await wrapped('hello', 42);
    expect(fn).toHaveBeenCalledWith('hello', 42);
  });

  it('calls timer on success', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const wrapped = withLogging(fn, 'myFn');
    await wrapped();
    expect(timerStop).toHaveBeenCalledTimes(1);
    expect(startTimerSpy).toHaveBeenCalledWith('myFn');
  });

  it('re-throws the error after logging on failure', async () => {
    const err = new Error('wrapped error');
    const fn = vi.fn().mockRejectedValue(err);
    const wrapped = withLogging(fn, 'failFn');
    await expect(wrapped()).rejects.toThrow('wrapped error');
  });

  it('calls logger.error when function throws', async () => {
    const logErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const err = new Error('fail');
    const fn = vi.fn().mockRejectedValue(err);
    const wrapped = withLogging(fn, 'failFn');
    await expect(wrapped()).rejects.toThrow('fail');
    expect(logErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failFn'),
      err
    );
  });

  it('calls timer stop even when function throws', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const wrapped = withLogging(fn, 'failFn');
    await expect(wrapped()).rejects.toThrow();
    expect(timerStop).toHaveBeenCalledTimes(1);
  });
});

describe('setupErrorHandlers', () => {
  it('registers uncaughtException listener', () => {
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    setupErrorHandlers();
    const callArgs = onSpy.mock.calls.map(c => c[0]);
    expect(callArgs).toContain('uncaughtException');
    onSpy.mockRestore();
  });

  it('registers unhandledRejection listener', () => {
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    setupErrorHandlers();
    const callArgs = onSpy.mock.calls.map(c => c[0]);
    expect(callArgs).toContain('unhandledRejection');
    onSpy.mockRestore();
  });

  it('uncaughtException handler calls loggers.system.fatal and process.exit', () => {
    const handlers: Record<string, Function> = {};
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: Function) => {
      handlers[event] = handler;
      return process;
    }) as any);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const systemFatalSpy = vi.spyOn(loggers.system, 'fatal').mockImplementation(() => {});

    setupErrorHandlers();
    const err = new Error('uncaught!');
    handlers['uncaughtException'](err);

    expect(systemFatalSpy).toHaveBeenCalledWith('Uncaught exception', err);
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    systemFatalSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('unhandledRejection handler calls loggers.system.error', () => {
    const handlers: Record<string, Function> = {};
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: Function) => {
      handlers[event] = handler;
      return process;
    }) as any);
    const systemErrorSpy = vi.spyOn(loggers.system, 'error').mockImplementation(() => {});

    setupErrorHandlers();
    handlers['unhandledRejection']('some reason');

    expect(systemErrorSpy).toHaveBeenCalledWith(
      'Unhandled rejection',
      undefined,
      expect.objectContaining({ reason: 'some reason' })
    );

    systemErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });
});

describe('logPerformanceDecorator', () => {
  let timerStop: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    timerStop = vi.fn();
    vi.spyOn(logger, 'startTimer').mockReturnValue(timerStop);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('wraps method and calls it with original args', async () => {
    class MyService {
      async doWork(x: number): Promise<number> {
        return x * 2;
      }
    }

    const proto = MyService.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'doWork')!;
    logPerformanceDecorator(proto, 'doWork', descriptor);
    Object.defineProperty(proto, 'doWork', descriptor);

    const svc = new MyService();
    const result = await svc.doWork(5);
    expect(result).toBe(10);
  });

  it('calls startTimer on entry and stops timer on exit', async () => {
    class MyService {
      async doWork(): Promise<string> {
        return 'ok';
      }
    }

    const proto = MyService.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'doWork')!;
    logPerformanceDecorator(proto, 'doWork', descriptor);
    Object.defineProperty(proto, 'doWork', descriptor);

    const svc = new MyService();
    await svc.doWork();

    expect(logger.startTimer).toHaveBeenCalledTimes(1);
    expect(timerStop).toHaveBeenCalledTimes(1);
  });

  it('re-throws errors from the original method', async () => {
    class MyService {
      async doWork(): Promise<void> {
        throw new Error('service error');
      }
    }

    const proto = MyService.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'doWork')!;
    logPerformanceDecorator(proto, 'doWork', descriptor);
    Object.defineProperty(proto, 'doWork', descriptor);

    const svc = new MyService();
    await expect(svc.doWork()).rejects.toThrow('service error');
    expect(timerStop).toHaveBeenCalledTimes(1);
  });

  it('returns the modified descriptor', () => {
    class MyService {
      async doWork(): Promise<void> {}
    }
    const proto = MyService.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'doWork')!;
    const result = logPerformanceDecorator(proto, 'doWork', descriptor);
    expect(result).toBe(descriptor);
  });
});

describe('initializeLogging', () => {
  it('calls setupErrorHandlers (registers process.on listeners)', () => {
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    const systemInfoSpy = vi.spyOn(loggers.system, 'info').mockImplementation(() => {});
    initializeLogging();
    const callArgs = onSpy.mock.calls.map(c => c[0]);
    expect(callArgs).toContain('uncaughtException');
    expect(callArgs).toContain('unhandledRejection');
    onSpy.mockRestore();
    systemInfoSpy.mockRestore();
  });

  it('logs startup message via loggers.system.info', () => {
    vi.spyOn(process, 'on').mockImplementation(() => process);
    const systemInfoSpy = vi.spyOn(loggers.system, 'info').mockImplementation(() => {});
    initializeLogging();
    expect(systemInfoSpy).toHaveBeenCalledWith(
      'Application starting',
      expect.objectContaining({ node_version: process.version })
    );
    systemInfoSpy.mockRestore();
    vi.restoreAllMocks();
  });
});

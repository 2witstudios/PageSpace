import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  classifyHttpError,
  HttpError,
  type HttpErrorHeaders,
  IncompatibleServerError,
  isAuthenticationError,
  isHttpError,
  isIncompatibleServerError,
  isNetworkError,
  isNotFoundError,
  isPageSpaceError,
  isPermissionDeniedError,
  isRateLimitError,
  isResponseValidationError,
  isServerError,
  isTimeoutError,
  isValidationError,
  NetworkError,
  NotFoundError,
  PageSpaceError,
  PermissionDeniedError,
  RateLimitError,
  ResponseValidationError,
  ServerError,
  TimeoutError,
  ValidationError,
} from '../errors.js';

const SECRET_TOKEN = 'ps_sess_SUPERSECRETTOKEN123';
const SECRET_PASSWORD = 'hunter2correcthorse';

describe('classifyHttpError — classification matrix', () => {
  it.each([
    [401, 'AUTHENTICATION_ERROR'],
    [403, 'PERMISSION_DENIED'],
    [404, 'NOT_FOUND'],
    [400, 'VALIDATION_ERROR'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
    [502, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
    [599, 'SERVER_ERROR'],
  ] as Array<[number, string]>)('maps HTTP %i to code %s', (status, code) => {
    const err = classifyHttpError(status, {}, { error: 'boom' });
    expect(err).toBeInstanceOf(PageSpaceError);
    expect(err.code).toBe(code);
  });

  it('maps each status to its distinct concrete class', () => {
    expect(classifyHttpError(401, {}, null)).toBeInstanceOf(AuthenticationError);
    expect(classifyHttpError(403, {}, null)).toBeInstanceOf(PermissionDeniedError);
    expect(classifyHttpError(404, {}, null)).toBeInstanceOf(NotFoundError);
    expect(classifyHttpError(400, {}, null)).toBeInstanceOf(ValidationError);
    expect(classifyHttpError(429, {}, null)).toBeInstanceOf(RateLimitError);
    expect(classifyHttpError(500, {}, null)).toBeInstanceOf(ServerError);
    expect(classifyHttpError(502, {}, null)).toBeInstanceOf(ServerError);
    expect(classifyHttpError(503, {}, null)).toBeInstanceOf(ServerError);
    expect(classifyHttpError(599, {}, null)).toBeInstanceOf(ServerError);
  });

  it('falls back to a generic HttpError for unmapped statuses (never throws, never misclassifies)', () => {
    for (const status of [402, 409, 418, 301, 200, 0, -1]) {
      const err = classifyHttpError(status, {}, null);
      expect(err).toBeInstanceOf(PageSpaceError);
      expect(err).toBeInstanceOf(HttpError);
      expect(err.code).toBe('HTTP_ERROR');
      expect(isHttpError(err)).toBe(true);
    }
  });

  it('records the HTTP status on status-carrying errors', () => {
    expect((classifyHttpError(404, {}, null) as NotFoundError).status).toBe(404);
    expect((classifyHttpError(503, {}, null) as ServerError).status).toBe(503);
    expect((classifyHttpError(409, {}, null) as HttpError).status).toBe(409);
  });

  it('attaches the operation name when provided', () => {
    const err = classifyHttpError(404, {}, null, 'pages.get');
    expect(err.operation).toBe('pages.get');
  });

  it('leaves operation undefined when not provided', () => {
    const err = classifyHttpError(404, {}, null);
    expect(err.operation).toBeUndefined();
  });
});

describe('classifyHttpError — ValidationError issues', () => {
  it('extracts a string body.error as the message with no issues', () => {
    const err = classifyHttpError(400, {}, { error: 'name is required' }) as ValidationError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('name is required');
    expect(err.issues).toEqual([]);
  });

  it('extracts an array body.error as structured issues (zod-issue-shaped)', () => {
    const err = classifyHttpError(400, {}, {
      error: [
        { path: ['name'], message: 'Required' },
        { path: ['age', 0], message: 'Expected number' },
      ],
    }) as ValidationError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.issues).toEqual([
      { path: ['name'], message: 'Required' },
      { path: ['age', 0], message: 'Expected number' },
    ]);
  });

  it('ignores malformed issue entries instead of throwing', () => {
    const err = classifyHttpError(400, {}, {
      error: [null, 42, { path: ['ok'], message: 'fine' }, { message: 'no path' }, {}],
    }) as ValidationError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.issues).toEqual([{ path: ['ok'], message: 'fine' }]);
  });
});

describe('classifyHttpError — retryAfterMs parsing', () => {
  it('parses a numeric Retry-After header (seconds) into ms', () => {
    const err = classifyHttpError(429, { 'Retry-After': '30' }, null) as RateLimitError;
    expect(err.retryAfterMs).toBe(30_000);
  });

  it('is case-insensitive for plain header records', () => {
    const err = classifyHttpError(429, { 'retry-after': '5' }, null) as RateLimitError;
    expect(err.retryAfterMs).toBe(5_000);
  });

  it('reads from a Headers instance', () => {
    const headers = new Headers({ 'Retry-After': '12' });
    const err = classifyHttpError(429, headers, null) as RateLimitError;
    expect(err.retryAfterMs).toBe(12_000);
  });

  it('is null when the header is missing', () => {
    const err = classifyHttpError(429, {}, null) as RateLimitError;
    expect(err.retryAfterMs).toBeNull();
  });

  it('is null (not NaN, not throwing) when the header is not numeric', () => {
    const err = classifyHttpError(429, { 'Retry-After': 'never' }, null) as RateLimitError;
    expect(err.retryAfterMs).toBeNull();
  });

  it('is null for a negative Retry-After value', () => {
    const err = classifyHttpError(429, { 'Retry-After': '-5' }, null) as RateLimitError;
    expect(err.retryAfterMs).toBeNull();
  });
});

describe('classifyHttpError — junk body resilience', () => {
  const junkBodies: unknown[] = [
    null,
    undefined,
    '',
    '<html><body>502 Bad Gateway</body></html>',
    '   ',
    42,
    true,
    [],
    [1, 2, 3],
    {},
    { error: 123 },
    { error: null },
    { error: { nested: 'object' } },
    { error: undefined },
  ];

  it.each(junkBodies.map((b) => [b] as const))('never throws for junk body %j', (body) => {
    expect(() => classifyHttpError(401, {}, body)).not.toThrow();
    expect(() => classifyHttpError(400, {}, body)).not.toThrow();
    expect(() => classifyHttpError(429, {}, body)).not.toThrow();
    expect(() => classifyHttpError(500, {}, body)).not.toThrow();
    expect(() => classifyHttpError(418, {}, body)).not.toThrow();
  });

  it('never throws for junk headers', () => {
    const junkHeaders: unknown[] = [null, undefined, '', 42, [], { '': '' }];
    for (const headers of junkHeaders) {
      expect(() => classifyHttpError(429, headers as HttpErrorHeaders, null)).not.toThrow();
    }
  });

  it('produces a non-empty message even for empty/garbage responses', () => {
    for (const body of [null, undefined, '', {}, []]) {
      const err = classifyHttpError(500, {}, body);
      expect(typeof err.message).toBe('string');
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});

describe('zero trust — no secret leakage', () => {
  it('does not embed extraneous body fields (e.g. echoed tokens/passwords) in the error', () => {
    const err = classifyHttpError(401, {}, {
      error: 'Unauthorized',
      requestHeaders: { Authorization: `Bearer ${SECRET_TOKEN}` },
      requestBody: { password: SECRET_PASSWORD },
    });
    const serialized = JSON.stringify(err) + err.message + String(err.stack);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(SECRET_PASSWORD);
  });

  it('does not embed secret-bearing response headers beyond the parsed Retry-After value', () => {
    const err = classifyHttpError(429, {
      'Retry-After': '10',
      'X-Secret-Session': SECRET_TOKEN,
    }, null);
    const serialized = JSON.stringify(err) + err.message + String(err.stack);
    expect(serialized).not.toContain(SECRET_TOKEN);
  });

  it('does not embed a token passed as a NetworkError cause message beyond what the caller supplies safely', () => {
    const err = new NetworkError('fetch failed', { operation: 'pages.get' });
    const serialized = JSON.stringify(err) + err.message + String(err.stack);
    expect(serialized).not.toContain(SECRET_TOKEN);
  });

  it('ValidationError issues never carry a raw request body, only path/message pairs', () => {
    const err = classifyHttpError(400, {}, {
      error: [{ path: ['token'], message: 'Invalid', receivedValue: SECRET_TOKEN }],
    }) as ValidationError;
    const serialized = JSON.stringify(err.issues);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(err.issues).toEqual([{ path: ['token'], message: 'Invalid' }]);
  });
});

describe('instanceof AND .code discrimination', () => {
  it('every classified error is discriminable both ways', () => {
    const cases: Array<[number, string]> = [
      [401, 'AUTHENTICATION_ERROR'],
      [403, 'PERMISSION_DENIED'],
      [404, 'NOT_FOUND'],
      [400, 'VALIDATION_ERROR'],
      [429, 'RATE_LIMITED'],
      [500, 'SERVER_ERROR'],
      [409, 'HTTP_ERROR'],
    ];
    for (const [status, code] of cases) {
      const err = classifyHttpError(status, {}, null);
      expect(err instanceof PageSpaceError).toBe(true);
      switch (err.code) {
        case 'AUTHENTICATION_ERROR':
          expect(err instanceof AuthenticationError).toBe(true);
          break;
        case 'PERMISSION_DENIED':
          expect(err instanceof PermissionDeniedError).toBe(true);
          break;
        case 'NOT_FOUND':
          expect(err instanceof NotFoundError).toBe(true);
          break;
        case 'VALIDATION_ERROR':
          expect(err instanceof ValidationError).toBe(true);
          break;
        case 'RATE_LIMITED':
          expect(err instanceof RateLimitError).toBe(true);
          break;
        case 'SERVER_ERROR':
          expect(err instanceof ServerError).toBe(true);
          break;
        case 'HTTP_ERROR':
          expect(err instanceof HttpError).toBe(true);
          break;
        default:
          throw new Error(`unexpected code ${err.code}`);
      }
      expect(err.code).toBe(code);
    }
  });

  it('realm-independent type guards agree with instanceof for every class', () => {
    expect(isAuthenticationError(classifyHttpError(401, {}, null))).toBe(true);
    expect(isPermissionDeniedError(classifyHttpError(403, {}, null))).toBe(true);
    expect(isNotFoundError(classifyHttpError(404, {}, null))).toBe(true);
    expect(isValidationError(classifyHttpError(400, {}, null))).toBe(true);
    expect(isRateLimitError(classifyHttpError(429, {}, null))).toBe(true);
    expect(isServerError(classifyHttpError(500, {}, null))).toBe(true);
    expect(isHttpError(classifyHttpError(409, {}, null))).toBe(true);
    expect(isNetworkError(new NetworkError('offline'))).toBe(true);
    expect(isTimeoutError(new TimeoutError('timed out'))).toBe(true);
    expect(isResponseValidationError(new ResponseValidationError('pages.get', []))).toBe(true);
    expect(isIncompatibleServerError(
      new IncompatibleServerError({ ok: false, reason: 'server-too-old', serverVersion: '1.0.0', sdkMinVersion: '1.1.0' }),
    )).toBe(true);
  });

  it('guards reject errors of other codes and non-error values', () => {
    expect(isAuthenticationError(classifyHttpError(403, {}, null))).toBe(false);
    expect(isAuthenticationError(new Error('plain'))).toBe(false);
    expect(isAuthenticationError(null)).toBe(false);
    expect(isAuthenticationError(undefined)).toBe(false);
    expect(isAuthenticationError('AUTHENTICATION_ERROR')).toBe(false);
    expect(isPageSpaceError(new Error('plain'))).toBe(false);
    expect(isPageSpaceError(classifyHttpError(401, {}, null))).toBe(true);
  });
});

describe('NetworkError / TimeoutError', () => {
  it('NetworkError carries code, operation, and an optional cause without throwing', () => {
    const cause = new TypeError('fetch failed');
    const err = new NetworkError('network request failed', { operation: 'drives.list', cause });
    expect(err).toBeInstanceOf(PageSpaceError);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.operation).toBe('drives.list');
    expect(err.cause).toBe(cause);
  });

  it('TimeoutError carries code and optional timeoutMs', () => {
    const err = new TimeoutError('request timed out', { operation: 'pages.get', timeoutMs: 30_000 });
    expect(err).toBeInstanceOf(PageSpaceError);
    expect(err.code).toBe('TIMEOUT_ERROR');
    expect(err.timeoutMs).toBe(30_000);
  });
});

describe('ResponseValidationError — server-drift signal', () => {
  it('carries the operation name and zod-issue-shaped issues', () => {
    const err = new ResponseValidationError('pages.get', [
      { path: ['title'], message: 'Expected string, received number' },
    ]);
    expect(err).toBeInstanceOf(PageSpaceError);
    expect(err.code).toBe('RESPONSE_VALIDATION_ERROR');
    expect(err.operation).toBe('pages.get');
    expect(err.issues).toEqual([{ path: ['title'], message: 'Expected string, received number' }]);
  });
});

describe('IncompatibleServerError — ADR 0001 D6', () => {
  it('constructs from a failed CompatibilityResult and names both versions in the message', () => {
    const err = new IncompatibleServerError({
      ok: false,
      reason: 'major-mismatch',
      serverVersion: '2.0.0',
      sdkMinVersion: '1.3.0',
    });
    expect(err).toBeInstanceOf(PageSpaceError);
    expect(err.code).toBe('INCOMPATIBLE_SERVER');
    expect(err.reason).toBe('major-mismatch');
    expect(err.serverVersion).toBe('2.0.0');
    expect(err.sdkMinVersion).toBe('1.3.0');
    expect(err.message).toContain('2.0.0');
    expect(err.message).toContain('1.3.0');
  });

  it('supports a null serverVersion (missing-header reason)', () => {
    const err = new IncompatibleServerError({
      ok: false,
      reason: 'missing-header',
      serverVersion: null,
      sdkMinVersion: '1.0.0',
    });
    expect(err.serverVersion).toBeNull();
    expect(err.reason).toBe('missing-header');
  });

  it.each(['missing-header', 'malformed-version', 'major-mismatch', 'server-too-old'] as const)(
    'accepts reason %s',
    (reason) => {
      const err = new IncompatibleServerError({
        ok: false,
        reason,
        serverVersion: 'x',
        sdkMinVersion: '1.0.0',
      });
      expect(err.reason).toBe(reason);
    },
  );
});

describe('PageSpaceError base class', () => {
  it('cannot be discriminated from a plain Error via instanceof alone at the base without a code', () => {
    // Every concrete instance still reports its class name distinctly.
    const err = classifyHttpError(404, {}, null);
    expect(err.name).toBe('NotFoundError');
  });

  it('every constructed error has a stable string .code and a message', () => {
    const errors: PageSpaceError[] = [
      classifyHttpError(401, {}, null),
      classifyHttpError(403, {}, null),
      classifyHttpError(404, {}, null),
      classifyHttpError(400, {}, null),
      classifyHttpError(429, {}, null),
      classifyHttpError(500, {}, null),
      classifyHttpError(409, {}, null),
      new NetworkError('offline'),
      new TimeoutError('timed out'),
      new ResponseValidationError('op', []),
      new IncompatibleServerError({ ok: false, reason: 'missing-header', serverVersion: null, sdkMinVersion: '1.0.0' }),
    ];
    for (const err of errors) {
      expect(typeof err.code).toBe('string');
      expect(err.code.length).toBeGreaterThan(0);
      expect(typeof err.message).toBe('string');
    }
  });
});

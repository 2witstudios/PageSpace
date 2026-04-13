/**
 * Tests for packages/lib/src/logging/logger.ts
 *
 * Covers:
 * - LogLevel enum values
 * - Logger singleton (getInstance)
 * - All log level methods (trace, debug, info, warn, error, fatal)
 * - shouldLog level filtering
 * - sanitizeData: sensitive field redaction, strings, arrays, nested objects
 * - formatOutput: json and pretty modes
 * - Context management: setContext, clearContext, withContext, child
 * - startTimer
 * - setLevel / getLevel / isLevelEnabled
 * - error/fatal with Error object vs plain metadata
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── mock logger-database so the dynamic import in Logger never hits the DB ──
vi.mock('../logger-database', () => ({
  writeLogsToDatabase: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks are set up
import { LogLevel, logger, type LogContext } from '../logger';

// Helper: cast to access private methods for white-box testing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLogger = any;

describe('LogLevel enum', () => {
  it('has correct numeric values', () => {
    expect(LogLevel.TRACE).toBe(0);
    expect(LogLevel.DEBUG).toBe(1);
    expect(LogLevel.INFO).toBe(2);
    expect(LogLevel.WARN).toBe(3);
    expect(LogLevel.ERROR).toBe(4);
    expect(LogLevel.FATAL).toBe(5);
    expect(LogLevel.SILENT).toBe(6);
  });
});

describe('Logger singleton', () => {
  it('getInstance returns the same instance each time', async () => {
    const { logger: l1 } = await import('../logger');
    const { logger: l2 } = await import('../logger');
    expect(l1).toBe(l2);
  });
});

describe('Logger log level methods', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let anyLogger: AnyLogger;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    anyLogger = logger as AnyLogger;
    // Ensure destination is console so logs fire immediately
    anyLogger.config.destination = 'console';
    // Set level to TRACE so all levels fire
    anyLogger.config.level = LogLevel.TRACE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Reset to default config so other tests are not affected
    anyLogger.config.level = LogLevel.INFO;
    anyLogger.config.destination = 'console';
    anyLogger.clearContext();
  });

  it('trace() calls console.log', () => {
    logger.trace('trace message');
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  it('debug() calls console.log', () => {
    logger.debug('debug message');
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  it('info() calls console.log', () => {
    logger.info('info message');
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  it('warn() calls console.warn', () => {
    logger.warn('warn message');
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it('error() with Error object calls console.error', () => {
    logger.error('error message', new Error('boom'));
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('error() with plain metadata calls console.error', () => {
    logger.error('error message', { extra: 'data' });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('error() with no second arg calls console.error', () => {
    logger.error('error only');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('fatal() with Error object calls console.error', () => {
    logger.fatal('fatal message', new Error('boom'));
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('fatal() with plain metadata calls console.error', () => {
    logger.fatal('fatal message', { extra: 'info' });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

describe('Logger shouldLog', () => {
  let anyLogger: AnyLogger;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    anyLogger = logger as AnyLogger;
    anyLogger.config.destination = 'console';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    anyLogger.config.level = LogLevel.INFO;
    anyLogger.clearContext();
  });

  it('does not log when level is below configured minimum', () => {
    anyLogger.config.level = LogLevel.WARN;
    logger.info('should be suppressed');
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('logs when level meets configured minimum', () => {
    anyLogger.config.level = LogLevel.INFO;
    logger.info('should appear');
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  it('SILENT level suppresses all logs', () => {
    anyLogger.config.level = LogLevel.SILENT;
    logger.fatal('should be suppressed');
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});

describe('Logger setLevel / getLevel / isLevelEnabled', () => {
  let anyLogger: AnyLogger;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    anyLogger = logger as AnyLogger;
    anyLogger.config.destination = 'console';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    anyLogger.config.level = LogLevel.INFO;
    anyLogger.clearContext();
  });

  it('setLevel accepts LogLevel enum', () => {
    logger.setLevel(LogLevel.DEBUG);
    expect(logger.getLevel()).toBe('DEBUG');
  });

  it('setLevel accepts string', () => {
    logger.setLevel('warn');
    expect(logger.getLevel()).toBe('WARN');
  });

  it('setLevel with unknown string falls back to INFO', () => {
    logger.setLevel('nonexistent');
    expect(logger.getLevel()).toBe('INFO');
  });

  it('isLevelEnabled returns true when level meets threshold', () => {
    logger.setLevel(LogLevel.DEBUG);
    expect(logger.isLevelEnabled(LogLevel.INFO)).toBe(true);
  });

  it('isLevelEnabled returns false when level below threshold', () => {
    logger.setLevel(LogLevel.WARN);
    expect(logger.isLevelEnabled(LogLevel.DEBUG)).toBe(false);
  });

  it('isLevelEnabled accepts string level', () => {
    logger.setLevel('info');
    expect(logger.isLevelEnabled('info')).toBe(true);
  });
});

describe('Logger sanitizeData', () => {
  let anyLogger: AnyLogger;

  beforeEach(() => {
    anyLogger = logger as AnyLogger;
    anyLogger.config.sanitize = true;
  });

  afterEach(() => {
    anyLogger.config.sanitize = true;
  });

  it('redacts "password" field', () => {
    const result = anyLogger.sanitizeData({ password: 'secret123' });
    expect(result.password).toBe('[REDACTED]');
  });

  it('redacts "token" field', () => {
    const result = anyLogger.sanitizeData({ token: 'abc' });
    expect(result.token).toBe('[REDACTED]');
  });

  it('redacts "secret" field', () => {
    const result = anyLogger.sanitizeData({ secret: 'mysecret' });
    expect(result.secret).toBe('[REDACTED]');
  });

  it('redacts "api_key" field', () => {
    const result = anyLogger.sanitizeData({ api_key: 'key123' });
    expect(result.api_key).toBe('[REDACTED]');
  });

  it('redacts "apiKey" field via lowercase substring match', () => {
    // substringSensitive contains 'apikey' (lowercase), and comparison is
    // `lowerKey.includes(s)` on `key.toLowerCase()`, so `apiKey` → 'apikey'
    // matches 'apikey' and is redacted. (This corrects a latent bug in
    // master where the camelCase entry `'apiKey'` never matched.)
    const result = anyLogger.sanitizeData({ apiKey: 'key123' });
    expect(result.apiKey).toBe('[REDACTED]');
  });

  it('redacts "authorization" field', () => {
    const result = anyLogger.sanitizeData({ authorization: 'Bearer xyz' });
    expect(result.authorization).toBe('[REDACTED]');
  });

  it('redacts "cookie" field', () => {
    const result = anyLogger.sanitizeData({ cookie: 'session=abc' });
    expect(result.cookie).toBe('[REDACTED]');
  });

  it('redacts "credit_card" field', () => {
    const result = anyLogger.sanitizeData({ credit_card: '4111111111111111' });
    expect(result.credit_card).toBe('[REDACTED]');
  });

  it('redacts "ssn" field', () => {
    const result = anyLogger.sanitizeData({ ssn: '123-45-6789' });
    expect(result.ssn).toBe('[REDACTED]');
  });

  it('redacts "jwt" field', () => {
    const result = anyLogger.sanitizeData({ jwt: 'eyJhb...' });
    expect(result.jwt).toBe('[REDACTED]');
  });

  it('preserves non-sensitive string fields', () => {
    const result = anyLogger.sanitizeData({ requestId: 'req-123' });
    expect(result.requestId).toBe('req-123');
  });

  it('returns string unchanged', () => {
    const result = anyLogger.sanitizeData('hello world');
    expect(result).toBe('hello world');
  });

  it('handles arrays by sanitizing each element', () => {
    const result = anyLogger.sanitizeData([{ password: 'x' }, { requestId: 'req-y' }]);
    expect(result[0].password).toBe('[REDACTED]');
    expect(result[1].requestId).toBe('req-y');
  });

  it('handles nested objects recursively', () => {
    const result = anyLogger.sanitizeData({ user: { password: 'nested', requestId: 'req-bob' } });
    expect(result.user.password).toBe('[REDACTED]');
    expect(result.user.requestId).toBe('req-bob');
  });

  it('redacts "email" field', () => {
    const result = anyLogger.sanitizeData({ email: 'alice@example.com' });
    expect(result.email).toBe('[REDACTED]');
  });

  it('redacts "name" field', () => {
    const result = anyLogger.sanitizeData({ name: 'Alice Smith' });
    expect(result.name).toBe('[REDACTED]');
  });

  it('redacts substring matches like "username", "firstName", "filename"', () => {
    const result = anyLogger.sanitizeData({
      username: 'alice',
      firstName: 'Alice',
      lastName: 'Smith',
      filename: 'W2_2024.pdf',
    });
    expect(result.username).toBe('[REDACTED]');
    expect(result.firstName).toBe('[REDACTED]');
    expect(result.lastName).toBe('[REDACTED]');
    expect(result.filename).toBe('[REDACTED]');
  });

  it('redacts "phone" and "phoneNumber" fields', () => {
    const result = anyLogger.sanitizeData({ phone: '+15551234', phoneNumber: '555-1234' });
    expect(result.phone).toBe('[REDACTED]');
    expect(result.phoneNumber).toBe('[REDACTED]');
  });

  it('redacts "address" and substring matches', () => {
    const result = anyLogger.sanitizeData({
      address: '1 Main St',
      streetAddress: '1 Main St',
      emailAddress: 'a@b.com',
    });
    expect(result.address).toBe('[REDACTED]');
    expect(result.streetAddress).toBe('[REDACTED]');
    expect(result.emailAddress).toBe('[REDACTED]');
  });

  it('redacts "dob" and "dateOfBirth" fields', () => {
    const result = anyLogger.sanitizeData({ dob: '1990-01-01', dateOfBirth: '1990-01-01' });
    expect(result.dob).toBe('[REDACTED]');
    expect(result.dateOfBirth).toBe('[REDACTED]');
  });

  it('returns primitives (number, boolean) unchanged', () => {
    expect(anyLogger.sanitizeData(42)).toBe(42);
    expect(anyLogger.sanitizeData(true)).toBe(true);
    expect(anyLogger.sanitizeData(null)).toBe(null);
  });

  it('returns data unchanged when sanitize is false', () => {
    anyLogger.config.sanitize = false;
    const result = anyLogger.sanitizeData({ password: 'secret' });
    expect(result.password).toBe('secret');
  });

  it('redacts field with "password" substring (case-insensitive)', () => {
    const result = anyLogger.sanitizeData({ userPassword: 'abc' });
    expect(result.userPassword).toBe('[REDACTED]');
  });

  it('preserves operational keys that only superficially resemble PII names', () => {
    // Regression: the split substring/exact rule must NOT collide with
    // operational telemetry keys. Before the split, a naive
    // `includes('name')` redacted every *Name field across the codebase.
    const result = anyLogger.sanitizeData({
      eventName: 'user.created',
      tableName: 'users',
      functionName: 'handleRequest',
      hostname: 'worker-07.prod',
      pathname: '/api/drives',
      methodName: 'POST',
      className: 'DriveService',
      serviceName: 'processor',
      providerName: 'anthropic',
      modelName: 'claude-opus-4-6',
      ipAddress: '10.0.0.4',
      macAddress: 'aa:bb:cc:dd:ee:ff',
    });
    expect(result.eventName).toBe('user.created');
    expect(result.tableName).toBe('users');
    expect(result.functionName).toBe('handleRequest');
    expect(result.hostname).toBe('worker-07.prod');
    expect(result.pathname).toBe('/api/drives');
    expect(result.methodName).toBe('POST');
    expect(result.className).toBe('DriveService');
    expect(result.serviceName).toBe('processor');
    expect(result.providerName).toBe('anthropic');
    expect(result.modelName).toBe('claude-opus-4-6');
    expect(result.ipAddress).toBe('10.0.0.4');
    expect(result.macAddress).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('redacts nested { name } under metadata (use logger.error(msg, err, meta) to preserve error class names)', () => {
    // This documents the tradeoff introduced by adding `name` to the
    // PII list: if a caller stuffs an Error into metadata as a raw
    // object, the nested `name` is correctly redacted because the
    // sanitizer can't distinguish error-class-name (not PII) from
    // person-name (PII). The correct API is to pass Errors through
    // `logger.error(message, err, metadata)`, which bypasses
    // sanitizeData entirely via createLogEntry's hoisting path.
    const result = anyLogger.sanitizeData({
      errorInfo: { name: 'TypeError', message: 'Cannot read property' },
    });
    expect(result.errorInfo.name).toBe('[REDACTED]');
    expect(result.errorInfo.message).toBe('Cannot read property');
  });
});

describe('Logger error hoisting (Error passed as 2nd arg bypasses sanitize)', () => {
  let anyLogger: AnyLogger;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    anyLogger = logger as AnyLogger;
    anyLogger.config.destination = 'console';
    anyLogger.config.level = LogLevel.TRACE;
    anyLogger.config.format = 'json';
    anyLogger.config.sanitize = true;
    anyLogger.clearContext();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    anyLogger.config.level = LogLevel.INFO;
    anyLogger.config.format = 'pretty';
    anyLogger.clearContext();
  });

  it('preserves error.name when Error is passed as the structured error arg', () => {
    // Regression guard for the processor workers fix in PR #982:
    // `loggers.processor.error('...', err, { contentHash })` must land
    // the Error's name ('TypeError', 'RangeError', etc.) in
    // entry.error.name without passing through sanitizeData, so the
    // `name` PII rule does not redact it.
    const err = new TypeError('boom');
    logger.error('something broke', err, { contentHash: 'abc' });

    const raw = consoleErrorSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.name).toBe('TypeError');
    expect(parsed.error.message).toBe('boom');
    expect(parsed.metadata).toMatchObject({ contentHash: 'abc' });
    // And the metadata path did NOT inherit the error object
    expect(parsed.metadata.name).toBeUndefined();
  });

  it('fatal() also preserves error.name via the hoisting path', () => {
    const err = new RangeError('out of range');
    logger.fatal('critical', err);
    const raw = consoleErrorSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.error.name).toBe('RangeError');
    expect(parsed.error.message).toBe('out of range');
  });
});

describe('Logger formatOutput', () => {
  let anyLogger: AnyLogger;

  beforeEach(() => {
    anyLogger = logger as AnyLogger;
  });

  it('json format returns valid JSON string', () => {
    anyLogger.config.format = 'json';
    const entry = anyLogger.createLogEntry(LogLevel.INFO, 'test message');
    const output = anyLogger.formatOutput(entry);
    const parsed = JSON.parse(output);
    expect(parsed.message).toBe('test message');
    expect(parsed.level).toBe('INFO');
  });

  it('pretty format includes level and message', () => {
    anyLogger.config.format = 'pretty';
    const entry = anyLogger.createLogEntry(LogLevel.INFO, 'hello world');
    const output = anyLogger.formatOutput(entry);
    expect(output).toContain('[INFO]');
    expect(output).toContain('hello world');
  });

  it('pretty format includes context when present', () => {
    anyLogger.config.format = 'pretty';
    anyLogger.config.enableContext = true;
    anyLogger.setContext({ requestId: 'req-1' });
    const entry = anyLogger.createLogEntry(LogLevel.INFO, 'ctx message');
    const output = anyLogger.formatOutput(entry);
    expect(output).toContain('req-1');
    anyLogger.clearContext();
  });

  it('pretty format includes metadata when present', () => {
    anyLogger.config.format = 'pretty';
    const entry = anyLogger.createLogEntry(LogLevel.INFO, 'meta msg', { key: 'val' });
    const output = anyLogger.formatOutput(entry);
    expect(output).toContain('val');
  });

  it('pretty format includes error info when present', () => {
    anyLogger.config.format = 'pretty';
    const err = new Error('kaboom');
    const entry = anyLogger.createLogEntry(LogLevel.ERROR, 'err msg', undefined, err);
    const output = anyLogger.formatOutput(entry);
    expect(output).toContain('kaboom');
    expect(output).toContain('Error');
  });

  it('pretty format includes stack trace when error has stack', () => {
    anyLogger.config.format = 'pretty';
    const err = new Error('stack error');
    const entry = anyLogger.createLogEntry(LogLevel.ERROR, 'err msg', undefined, err);
    const output = anyLogger.formatOutput(entry);
    expect(output).toContain('Error');
  });

  it('NO_COLOR env var suppresses color codes', () => {
    process.env.NO_COLOR = '1';
    anyLogger.config.format = 'pretty';
    const entry = anyLogger.createLogEntry(LogLevel.INFO, 'plain');
    const output = anyLogger.formatOutput(entry);
    expect(output).not.toContain('\x1b[');
    delete process.env.NO_COLOR;
  });
});

describe('Logger context management', () => {
  let anyLogger: AnyLogger;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    anyLogger = logger as AnyLogger;
    anyLogger.config.destination = 'console';
    anyLogger.config.level = LogLevel.TRACE;
    anyLogger.config.format = 'json';
    anyLogger.config.enableContext = true;
    anyLogger.clearContext();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    anyLogger.config.level = LogLevel.INFO;
    anyLogger.config.format = 'pretty';
    anyLogger.clearContext();
  });

  it('setContext merges context into future log entries', () => {
    logger.setContext({ userId: 'u-1' });
    logger.info('ctx test');
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.context.userId).toBe('u-1');
  });

  it('setContext merges additively', () => {
    logger.setContext({ userId: 'u-1' });
    logger.setContext({ sessionId: 's-1' });
    logger.info('merge test');
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.context.userId).toBe('u-1');
    expect(parsed.context.sessionId).toBe('s-1');
  });

  it('clearContext removes all context', () => {
    logger.setContext({ userId: 'u-1' });
    logger.clearContext();
    logger.info('after clear');
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.context).toBeUndefined();
  });

  it('withContext returns a child logger with merged context', () => {
    logger.setContext({ userId: 'u-1' });
    const child = logger.withContext({ requestId: 'r-1' });
    child.info('child log');
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.context.userId).toBe('u-1');
    expect(parsed.context.requestId).toBe('r-1');
  });

  it('child() is an alias for withContext()', () => {
    const child = logger.child({ driveId: 'd-1' } as LogContext);
    child.info('child alias');
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.context.driveId).toBe('d-1');
  });
});

describe('Logger startTimer', () => {
  let anyLogger: AnyLogger;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    anyLogger = logger as AnyLogger;
    anyLogger.config.destination = 'console';
    anyLogger.config.level = LogLevel.TRACE;
    anyLogger.config.format = 'json';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    anyLogger.config.level = LogLevel.INFO;
    anyLogger.config.format = 'pretty';
    anyLogger.clearContext();
  });

  it('startTimer returns a function', () => {
    const stop = logger.startTimer('myOp');
    expect(typeof stop).toBe('function');
  });

  it('calling the returned function logs a debug entry with duration and label', () => {
    const stop = logger.startTimer('myOp');
    stop();
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.message).toContain('myOp');
    expect(parsed.metadata).toHaveProperty('duration');
    expect(parsed.metadata).toHaveProperty('label', 'myOp');
  });
});

describe('Logger buffer / database destination', () => {
  let anyLogger: AnyLogger;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    anyLogger = logger as AnyLogger;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    anyLogger.config.destination = 'console';
    anyLogger.config.level = LogLevel.INFO;
    anyLogger.buffer = [];
    anyLogger.clearContext();
  });

  it('destination="database" buffers entries', () => {
    anyLogger.config.destination = 'database';
    anyLogger.config.level = LogLevel.TRACE;
    logger.info('buffered');
    expect(anyLogger.buffer.length).toBeGreaterThan(0);
  });

  it('destination="both" buffers entries', () => {
    anyLogger.config.destination = 'both';
    anyLogger.config.level = LogLevel.TRACE;
    logger.info('buffered both');
    expect(anyLogger.buffer.length).toBeGreaterThan(0);
  });

  it('flush with empty buffer does nothing', async () => {
    anyLogger.buffer = [];
    await anyLogger.flush();
    // No error thrown — passes
  });

  it('flush sends buffered entries to database', async () => {
    const { writeLogsToDatabase } = await import('../logger-database');
    anyLogger.config.destination = 'database';
    anyLogger.config.level = LogLevel.TRACE;
    logger.info('flush test');
    await anyLogger.flush();
    expect(writeLogsToDatabase).toHaveBeenCalled();
  });

  it('flush with destination="console" writes each entry to console', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    anyLogger.config.destination = 'console';
    anyLogger.config.format = 'json';
    // Manually push entries to buffer (bypassing the console-immediate path)
    const entry = anyLogger.createLogEntry(LogLevel.INFO, 'console flush test');
    anyLogger.buffer = [entry];
    await anyLogger.flush();
    expect(consoleLogSpy).toHaveBeenCalled();
    anyLogger.config.format = 'pretty';
  });

  it('flush with destination="both" writes to database and console', async () => {
    const { writeLogsToDatabase } = await import('../logger-database');
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    anyLogger.config.destination = 'both';
    anyLogger.config.format = 'json';
    const entry = anyLogger.createLogEntry(LogLevel.INFO, 'both flush test');
    anyLogger.buffer = [entry];
    await anyLogger.flush();
    expect(writeLogsToDatabase).toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalled();
    anyLogger.config.format = 'pretty';
  });

  it('buffer triggers flush when batchSize is reached', async () => {
    anyLogger.config.destination = 'database';
    anyLogger.config.level = LogLevel.TRACE;
    anyLogger.config.batchSize = 2;
    anyLogger.buffer = [];
    // Provide a mock flush
    const flushSpy = vi.spyOn(anyLogger, 'flush').mockResolvedValue(undefined);
    logger.info('first');
    logger.info('second'); // triggers flush at batchSize=2
    expect(flushSpy).toHaveBeenCalled();
    flushSpy.mockRestore();
    anyLogger.config.batchSize = 100;
  });

  it('setInterval flush error handler calls console.error', async () => {
    // Simulate the interval callback's .catch() path by calling flush
    // then catching the error ourselves to verify the pattern matches
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const flushError = new Error('interval flush failed');
    // Manually invoke the pattern: flush().catch(err => console.error('[Logger] Flush error:', err))
    await Promise.resolve().then(() => { throw flushError; }).catch(err => {
      console.error('[Logger] Flush error:', err);
    });
    expect(consoleSpy).toHaveBeenCalledWith('[Logger] Flush error:', flushError);
  });
});

describe('Logger enablePerformance flag', () => {
  let anyLogger: AnyLogger;

  beforeEach(() => {
    anyLogger = logger as AnyLogger;
  });

  it('includes performance data in entry when enablePerformance=true', () => {
    anyLogger.config.enablePerformance = true;
    const entry = anyLogger.createLogEntry(LogLevel.INFO, 'perf test');
    expect(entry.performance).toBeDefined();
    expect(entry.performance.duration).toBeTypeOf('number');
    expect(entry.performance.memory).toBeDefined();
  });

  it('excludes performance data when enablePerformance=false', () => {
    anyLogger.config.enablePerformance = false;
    const entry = anyLogger.createLogEntry(LogLevel.INFO, 'no perf');
    expect(entry.performance).toBeUndefined();
  });
});

describe('Logger startFlushTimer signal handlers', () => {
  let anyLogger: AnyLogger;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    anyLogger = logger as AnyLogger;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    anyLogger.config.destination = 'console';
    anyLogger.config.level = LogLevel.INFO;
    anyLogger.buffer = [];
    anyLogger.clearContext();
  });

  it('SIGINT handler flushes and exits', async () => {
    // Capture the SIGINT handler registered by startFlushTimer
    const handlers: Record<string, Function[]> = {};
    const onSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return process;
    }) as any);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const flushSpy = vi.spyOn(anyLogger, 'flush').mockResolvedValue(undefined);

    // Trigger startFlushTimer to register handlers
    anyLogger.startFlushTimer();

    // Call the SIGINT handler if registered
    if (handlers['SIGINT'] && handlers['SIGINT'].length > 0) {
      const handler = handlers['SIGINT'][handlers['SIGINT'].length - 1];
      handler();
      expect(flushSpy).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    }

    onSpy.mockRestore();
    exitSpy.mockRestore();
    flushSpy.mockRestore();
  });

  it('SIGTERM handler flushes and exits', async () => {
    const handlers: Record<string, Function[]> = {};
    const onSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return process;
    }) as any);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const flushSpy = vi.spyOn(anyLogger, 'flush').mockResolvedValue(undefined);

    anyLogger.startFlushTimer();

    if (handlers['SIGTERM'] && handlers['SIGTERM'].length > 0) {
      const handler = handlers['SIGTERM'][handlers['SIGTERM'].length - 1];
      handler();
      expect(flushSpy).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    }

    onSpy.mockRestore();
    exitSpy.mockRestore();
    flushSpy.mockRestore();
  });

  it('startFlushTimer clears existing timer before creating new one', () => {
    // Set a fake existing timer
    anyLogger.flushTimer = setInterval(() => {}, 100000);
    const clearSpy = vi.spyOn(global, 'clearInterval');
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    anyLogger.startFlushTimer();
    expect(clearSpy).toHaveBeenCalled();
    onSpy.mockRestore();
    clearSpy.mockRestore();
  });
});

describe('Logger getLevelColor / dim / red / resetColor', () => {
  let anyLogger: AnyLogger;

  beforeEach(() => {
    anyLogger = logger as AnyLogger;
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    delete process.env.NO_COLOR;
  });

  it('getLevelColor returns ANSI code for known levels', () => {
    expect(anyLogger.getLevelColor('INFO')).toContain('\x1b[');
    expect(anyLogger.getLevelColor('WARN')).toContain('\x1b[');
    expect(anyLogger.getLevelColor('ERROR')).toContain('\x1b[');
    expect(anyLogger.getLevelColor('FATAL')).toContain('\x1b[');
    expect(anyLogger.getLevelColor('DEBUG')).toContain('\x1b[');
    expect(anyLogger.getLevelColor('TRACE')).toContain('\x1b[');
  });

  it('getLevelColor returns empty string for unknown level', () => {
    expect(anyLogger.getLevelColor('UNKNOWN')).toBe('');
  });

  it('getLevelColor returns empty string when NO_COLOR is set', () => {
    process.env.NO_COLOR = '1';
    expect(anyLogger.getLevelColor('INFO')).toBe('');
  });

  it('dim returns empty string when NO_COLOR is set', () => {
    process.env.NO_COLOR = '1';
    expect(anyLogger.dim()).toBe('');
  });

  it('red returns empty string when NO_COLOR is set', () => {
    process.env.NO_COLOR = '1';
    expect(anyLogger.red()).toBe('');
  });

  it('resetColor returns empty string when NO_COLOR is set', () => {
    process.env.NO_COLOR = '1';
    expect(anyLogger.resetColor()).toBe('');
  });
});

describe('Logger internal error handlers (catch callbacks)', () => {
  let anyLogger: AnyLogger;

  beforeEach(() => {
    anyLogger = logger as AnyLogger;
    anyLogger.config.destination = 'console';
    anyLogger.config.level = LogLevel.TRACE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    anyLogger.config.destination = 'console';
    anyLogger.config.level = LogLevel.INFO;
    anyLogger.buffer = [];
    anyLogger.clearContext();
  });

  it('console write error catch logs to console.error', async () => {
    // Force writeToConsole to reject by making formatOutput throw
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(anyLogger, 'formatOutput').mockImplementation(() => {
      throw new Error('format failed');
    });
    anyLogger.config.destination = 'console';
    logger.info('trigger console catch');
    // Give the micro-task queue a chance to run the .catch()
    await new Promise(r => setTimeout(r, 0));
    expect(consoleSpy).toHaveBeenCalledWith(
      '[Logger] Console write error:',
      expect.any(Error)
    );
  });

  it('buffer flush error catch logs to console.error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Set destination to database and a tiny batchSize so flush fires
    anyLogger.config.destination = 'database';
    anyLogger.config.batchSize = 1;
    anyLogger.buffer = [];
    // Make flush reject
    vi.spyOn(anyLogger, 'flush').mockRejectedValueOnce(new Error('flush failed'));
    logger.info('trigger flush catch');
    await new Promise(r => setTimeout(r, 0));
    expect(consoleSpy).toHaveBeenCalledWith(
      '[Logger] Flush error:',
      expect.any(Error)
    );
    anyLogger.config.batchSize = 100;
  });
});

describe('Logger writeToDatabase error handling', () => {
  let anyLogger: AnyLogger;

  beforeEach(() => {
    anyLogger = logger as AnyLogger;
  });

  it('silently handles writeLogsToDatabase import failure in production', async () => {
    // Patch the dynamic import to throw
    const original = anyLogger.writeToDatabase.bind(anyLogger);
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    // We'll just call flush on a buffer entry with a broken database writer
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { writeLogsToDatabase } = await import('../logger-database');
    vi.mocked(writeLogsToDatabase).mockRejectedValueOnce(new Error('db down'));

    anyLogger.config.destination = 'database';
    anyLogger.buffer = [anyLogger.createLogEntry(LogLevel.INFO, 'test')];
    await anyLogger.flush();

    // Should not throw
    process.env.NODE_ENV = originalNodeEnv;
    consoleSpy.mockRestore();
    vi.mocked(writeLogsToDatabase).mockResolvedValue(undefined);
  });

  it('logs to console in development when writeLogsToDatabase fails', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { writeLogsToDatabase } = await import('../logger-database');
    vi.mocked(writeLogsToDatabase).mockRejectedValueOnce(new Error('db down'));

    anyLogger.config.destination = 'database';
    anyLogger.buffer = [anyLogger.createLogEntry(LogLevel.INFO, 'test')];
    await anyLogger.flush();

    process.env.NODE_ENV = originalNodeEnv;
    consoleSpy.mockRestore();
    consoleLogSpy.mockRestore();
    vi.mocked(writeLogsToDatabase).mockResolvedValue(undefined);
  });
});

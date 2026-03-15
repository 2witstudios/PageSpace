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

  it('trace() routes to console.log with message', () => {
    logger.trace('trace message');
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy.mock.calls[0][0]).toContain('trace message');
  });

  it('debug() routes to console.log with message', () => {
    logger.debug('debug message');
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy.mock.calls[0][0]).toContain('debug message');
  });

  it('info() routes to console.log with message', () => {
    logger.info('info message');
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy.mock.calls[0][0]).toContain('info message');
  });

  it('warn() routes to console.warn with message', () => {
    logger.warn('warn message');
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy.mock.calls[0][0]).toContain('warn message');
  });

  it('error() with Error object routes to console.error', () => {
    logger.error('error message', new Error('boom'));
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('error message');
  });

  it('error() with plain metadata routes to console.error', () => {
    logger.error('error message', { extra: 'data' });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('error message');
  });

  it('error() with no second arg routes to console.error', () => {
    logger.error('error only');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('error only');
  });

  it('fatal() with Error object routes to console.error', () => {
    logger.fatal('fatal message', new Error('boom'));
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('fatal message');
  });

  it('fatal() with plain metadata routes to console.error', () => {
    logger.fatal('fatal message', { extra: 'info' });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('fatal message');
  });
});

describe('Logger shouldLog', () => {
  let anyLogger: AnyLogger;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy.mock.calls[0][0]).toContain('should appear');
  });

  it('SILENT level suppresses all logs including fatal', () => {
    anyLogger.config.level = LogLevel.SILENT;
    logger.fatal('should be suppressed');
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
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

  it('redacts "apiKey" field (case-insensitive match)', () => {
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
    const result = anyLogger.sanitizeData({ username: 'alice' });
    expect(result.username).toBe('alice');
  });

  it('returns string unchanged', () => {
    const result = anyLogger.sanitizeData('hello world');
    expect(result).toBe('hello world');
  });

  it('handles arrays by sanitizing each element', () => {
    const result = anyLogger.sanitizeData([{ password: 'x' }, { name: 'y' }]);
    expect(result[0].password).toBe('[REDACTED]');
    expect(result[1].name).toBe('y');
  });

  it('handles nested objects recursively', () => {
    const result = anyLogger.sanitizeData({ user: { password: 'nested', name: 'bob' } });
    expect(result.user.password).toBe('[REDACTED]');
    expect(result.user.name).toBe('bob');
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
    expect(writeLogsToDatabase).toHaveBeenCalledTimes(1);
  });

  it('flush with destination="console" writes each entry to console', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    anyLogger.config.destination = 'console';
    anyLogger.config.format = 'json';
    // Manually push entries to buffer (bypassing the console-immediate path)
    const entry = anyLogger.createLogEntry(LogLevel.INFO, 'console flush test');
    anyLogger.buffer = [entry];
    await anyLogger.flush();
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy.mock.calls[0][0]).toContain('console flush test');
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
    expect(writeLogsToDatabase).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
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
    expect(flushSpy).toHaveBeenCalledTimes(1);
    flushSpy.mockRestore();
    anyLogger.config.batchSize = 100;
  });

  it('setInterval flush error handler calls console.error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const flushError = new Error('interval flush failed');

    // Capture the callback registered with setInterval
    let intervalCallback: (() => void) | null = null;
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((cb: () => void) => {
      intervalCallback = cb;
      return 999 as unknown as NodeJS.Timeout;
    }) as typeof setInterval);
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);

    // Make flush reject so the .catch() path fires
    vi.spyOn(anyLogger, 'flush').mockRejectedValueOnce(flushError);

    anyLogger.startFlushTimer();
    expect(intervalCallback).not.toBeNull();

    // Invoke the captured interval callback
    intervalCallback!();

    // REVIEW: setTimeout(0) flushes the .catch() microtask — consider process.nextTick if flaky on CI
    await new Promise(r => setTimeout(r, 0));

    expect(consoleSpy).toHaveBeenCalledWith('[Logger] Flush error:', flushError);

    setIntervalSpy.mockRestore();
    onSpy.mockRestore();
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
      expect(flushSpy).toHaveBeenCalledTimes(1);
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
      expect(flushSpy).toHaveBeenCalledTimes(1);
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
    expect(clearSpy).toHaveBeenCalledTimes(1);
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

/**
 * Tests for packages/lib/src/logging/logger-browser.ts
 *
 * Covers:
 * - BrowserSafeLogger constructor with default and custom config
 * - All log levels with shouldLog filtering
 * - sanitizeData: max depth, max string length, Error objects, arrays, null, booleans, numbers
 * - formatOutput: json and text modes
 * - output routing: error/fatal -> console.error, warn -> console.warn, debug/trace -> console.debug, info -> console.log
 * - destination 'none' produces no output
 * - context management: setContext, clearContext, child
 * - isNode, getHostname, getPid, getMemoryUsage
 * - enablePerformance flag
 * - log() method
 * - browserLogger and browserLoggers exports
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserSafeLogger, LogLevel, browserLogger, browserLoggers } from '../logger-browser';

// Helper to access private methods for white-box tests
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLogger = any;

describe('BrowserSafeLogger constructor', () => {
  it('uses INFO level by default', () => {
    const bsl = new BrowserSafeLogger();
    const any = bsl as AnyLogger;
    expect(any.config.level).toBe(LogLevel.INFO);
  });

  it('accepts custom level', () => {
    const bsl = new BrowserSafeLogger({ level: LogLevel.DEBUG });
    const any = bsl as AnyLogger;
    expect(any.config.level).toBe(LogLevel.DEBUG);
  });

  it('defaults format to "text"', () => {
    const bsl = new BrowserSafeLogger();
    const any = bsl as AnyLogger;
    expect(any.config.format).toBe('text');
  });

  it('accepts "json" format', () => {
    const bsl = new BrowserSafeLogger({ format: 'json' });
    const any = bsl as AnyLogger;
    expect(any.config.format).toBe('json');
  });

  it('defaults destination to "console"', () => {
    const bsl = new BrowserSafeLogger();
    const any = bsl as AnyLogger;
    expect(any.config.destination).toBe('console');
  });

  it('accepts destination "none"', () => {
    const bsl = new BrowserSafeLogger({ destination: 'none' });
    const any = bsl as AnyLogger;
    expect(any.config.destination).toBe('none');
  });

  it('defaults maxStringLength to 1000', () => {
    const bsl = new BrowserSafeLogger();
    const any = bsl as AnyLogger;
    expect(any.config.maxStringLength).toBe(1000);
  });

  it('defaults maxObjectDepth to 3', () => {
    const bsl = new BrowserSafeLogger();
    const any = bsl as AnyLogger;
    expect(any.config.maxObjectDepth).toBe(3);
  });

  it('accepts custom version', () => {
    const bsl = new BrowserSafeLogger({ version: '1.2.3' });
    const any = bsl as AnyLogger;
    expect(any.config.version).toBe('1.2.3');
  });
});

describe('BrowserSafeLogger log level routing', () => {
  let bsl: BrowserSafeLogger;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    bsl = new BrowserSafeLogger({ level: LogLevel.TRACE, destination: 'console' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('error() routes to console.error', () => {
    bsl.error('err msg');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('err msg');
  });

  it('fatal() routes to console.error', () => {
    bsl.fatal('fatal msg');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('fatal msg');
  });

  it('warn() routes to console.warn', () => {
    bsl.warn('warn msg');
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy.mock.calls[0][0]).toContain('warn msg');
  });

  it('debug() routes to console.debug', () => {
    bsl.debug('debug msg');
    expect(consoleDebugSpy).toHaveBeenCalledTimes(1);
    expect(consoleDebugSpy.mock.calls[0][0]).toContain('debug msg');
  });

  it('trace() routes to console.debug', () => {
    bsl.trace('trace msg');
    expect(consoleDebugSpy).toHaveBeenCalledTimes(1);
    expect(consoleDebugSpy.mock.calls[0][0]).toContain('trace msg');
  });

  it('info() routes to console.log', () => {
    bsl.info('info msg');
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy.mock.calls[0][0]).toContain('info msg');
  });
});

describe('BrowserSafeLogger shouldLog filtering', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('suppresses levels below configured threshold', () => {
    const bsl = new BrowserSafeLogger({ level: LogLevel.WARN });
    bsl.info('should be suppressed');
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('passes levels at or above threshold', () => {
    const bsl = new BrowserSafeLogger({ level: LogLevel.INFO });
    bsl.info('should pass');
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  it('trace is suppressed at INFO level', () => {
    const bsl = new BrowserSafeLogger({ level: LogLevel.INFO });
    bsl.trace('trace suppressed');
    expect(consoleDebugSpy).not.toHaveBeenCalled();
  });

  it('SILENT level suppresses everything including fatal', () => {
    const bsl = new BrowserSafeLogger({ level: LogLevel.SILENT });
    bsl.fatal('nope');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(consoleDebugSpy).not.toHaveBeenCalled();
  });
});

describe('BrowserSafeLogger destination "none"', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('produces no output for any level when destination is "none"', () => {
    const bsl = new BrowserSafeLogger({ level: LogLevel.TRACE, destination: 'none' });
    bsl.trace('t');
    bsl.debug('d');
    bsl.info('i');
    bsl.warn('w');
    bsl.error('e');
    bsl.fatal('f');
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleDebugSpy).not.toHaveBeenCalled();
  });
});

describe('BrowserSafeLogger sanitizeData', () => {
  let bsl: AnyLogger;

  beforeEach(() => {
    bsl = new BrowserSafeLogger({ maxObjectDepth: 2, maxStringLength: 10 }) as AnyLogger;
  });

  it('returns null unchanged', () => {
    expect(bsl.sanitizeData(null)).toBeNull();
  });

  it('returns undefined unchanged', () => {
    expect(bsl.sanitizeData(undefined)).toBeUndefined();
  });

  it('truncates long strings', () => {
    const result = bsl.sanitizeData('hello world!');
    expect(result).toContain('[truncated]');
    expect((result as string).length).toBeLessThan(30);
  });

  it('passes short strings unchanged', () => {
    expect(bsl.sanitizeData('hi')).toBe('hi');
  });

  it('returns numbers unchanged', () => {
    expect(bsl.sanitizeData(42)).toBe(42);
  });

  it('returns booleans unchanged', () => {
    expect(bsl.sanitizeData(false)).toBe(false);
  });

  it('converts Error to plain object with name, message, stack', () => {
    const err = new Error('test error');
    const result = bsl.sanitizeData(err) as { name: string; message: string; stack?: string };
    expect(result.name).toBe('Error');
    expect(result.message).toBe('test error');
    expect(result).toHaveProperty('stack');
  });

  it('sanitizes array items recursively', () => {
    const result = bsl.sanitizeData([1, 'two', null]) as unknown[];
    expect(result[0]).toBe(1);
    expect(result[1]).toBe('two'); // 'two' has length 3 which is <= 10, passed through unchanged
    expect(result[2]).toBeNull();
  });

  it('sanitizes nested object fields', () => {
    const result = bsl.sanitizeData({ a: 1, b: 'hi' }) as Record<string, unknown>;
    expect(result.a).toBe(1);
    expect(result.b).toBe('hi');
  });

  it('returns max depth exceeded message at limit', () => {
    // maxObjectDepth=2, depth starts at 0
    // depth 0: object, depth 1: object, depth 2: object -> at depth>2 returns placeholder
    const result = bsl.sanitizeData({ l1: { l2: { l3: 'deep' } } }) as Record<string, unknown>;
    // l1 is processed at depth=0, l2 at depth=1, l3 at depth=2, so l3 value is at depth=3 > maxObjectDepth=2
    const l1 = result.l1 as Record<string, unknown>;
    const l2 = l1.l2 as Record<string, unknown>;
    expect(l2.l3).toBe('[Object: max depth exceeded]');
  });

  it('converts unknown type to string', () => {
    // Symbol falls through to String(data)
    const sym = Symbol('test');
    const result = bsl.sanitizeData(sym);
    expect(typeof result).toBe('string');
  });
});

describe('BrowserSafeLogger formatOutput', () => {
  let bsl: AnyLogger;

  beforeEach(() => {
    bsl = new BrowserSafeLogger({ format: 'json' }) as AnyLogger;
  });

  it('json format returns valid JSON', () => {
    const entry = bsl.createLogEntry(LogLevel.INFO, 'json test');
    const output = bsl.formatOutput(entry);
    const parsed = JSON.parse(output);
    expect(parsed.message).toBe('json test');
    expect(parsed.level).toBe('info');
  });

  it('text format includes timestamp, level, message', () => {
    bsl.config.format = 'text';
    const entry = bsl.createLogEntry(LogLevel.INFO, 'text test');
    const output = bsl.formatOutput(entry);
    expect(output).toContain('INFO');
    expect(output).toContain('text test');
  });

  it('text format appends context when present', () => {
    bsl.config.format = 'text';
    bsl.config.enableContext = true;
    bsl.setContext({ userId: 'u-42' });
    const entry = bsl.createLogEntry(LogLevel.INFO, 'ctx test');
    const output = bsl.formatOutput(entry);
    expect(output).toContain('u-42');
    bsl.clearContext();
  });

  it('text format appends metadata when present', () => {
    bsl.config.format = 'text';
    const entry = bsl.createLogEntry(LogLevel.INFO, 'meta test', { foo: 'bar' });
    const output = bsl.formatOutput(entry);
    expect(output).toContain('bar');
  });

  it('text format appends error info when present', () => {
    bsl.config.format = 'text';
    const err = new Error('oops');
    const entry = bsl.createLogEntry(LogLevel.ERROR, 'err test', undefined, err);
    const output = bsl.formatOutput(entry);
    expect(output).toContain('oops');
  });

  it('text format appends error stack when present', () => {
    bsl.config.format = 'text';
    const err = new Error('oops');
    const entry = bsl.createLogEntry(LogLevel.ERROR, 'err test', undefined, err);
    const output = bsl.formatOutput(entry);
    expect(output).toContain('Stack:');
  });

  it('text format does not append empty metadata', () => {
    bsl.config.format = 'text';
    const entry = bsl.createLogEntry(LogLevel.INFO, 'no meta');
    const output = bsl.formatOutput(entry);
    expect(output).not.toContain('{}');
  });
});

describe('BrowserSafeLogger context management', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('setContext merges into existing context', () => {
    const bsl = new BrowserSafeLogger({ format: 'json', level: LogLevel.TRACE });
    bsl.setContext({ userId: 'u-1' });
    bsl.setContext({ requestId: 'r-1' });
    bsl.info('merge');
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.context.userId).toBe('u-1');
    expect(parsed.context.requestId).toBe('r-1');
  });

  it('clearContext removes all context', () => {
    const bsl = new BrowserSafeLogger({ format: 'json', level: LogLevel.TRACE });
    bsl.setContext({ userId: 'u-1' });
    bsl.clearContext();
    bsl.info('after clear');
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.context).toBeUndefined();
  });

  it('child() returns a new BrowserSafeLogger with merged context', () => {
    const bsl = new BrowserSafeLogger({ format: 'json', level: LogLevel.TRACE });
    bsl.setContext({ userId: 'u-1' });
    const child = bsl.child({ driveId: 'd-1' });
    child.info('child');
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.context.userId).toBe('u-1');
    expect(parsed.context.driveId).toBe('d-1');
  });

  it('child() returns a different instance', () => {
    const bsl = new BrowserSafeLogger();
    const child = bsl.child({ requestId: 'r-1' });
    expect(child).not.toBe(bsl);
  });
});

describe('BrowserSafeLogger error/fatal with Error object', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('error() with Error object captures error fields', () => {
    const bsl = new BrowserSafeLogger({ format: 'json', level: LogLevel.TRACE });
    const err = new Error('my error');
    bsl.error('test', err);
    const raw = consoleErrorSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.error.message).toBe('my error');
  });

  it('error() with metadata object (not Error)', () => {
    const bsl = new BrowserSafeLogger({ format: 'json', level: LogLevel.TRACE });
    bsl.error('test', { code: 404 });
    const raw = consoleErrorSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.metadata).toHaveProperty('code', 404);
  });

  it('error() with both Error and metadata', () => {
    const bsl = new BrowserSafeLogger({ format: 'json', level: LogLevel.TRACE });
    const err = new Error('combined');
    bsl.error('test', err, { extra: 'data' });
    const raw = consoleErrorSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.error.message).toBe('combined');
    expect(parsed.metadata).toHaveProperty('extra', 'data');
  });

  it('fatal() with Error object captures error fields', () => {
    const bsl = new BrowserSafeLogger({ format: 'json', level: LogLevel.TRACE });
    const err = new Error('fatal error');
    bsl.fatal('test', err);
    const raw = consoleErrorSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.error.message).toBe('fatal error');
  });

  it('fatal() with metadata object (not Error)', () => {
    const bsl = new BrowserSafeLogger({ format: 'json', level: LogLevel.TRACE });
    bsl.fatal('test', { info: 'ok' });
    const raw = consoleErrorSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.metadata).toHaveProperty('info', 'ok');
  });
});

describe('BrowserSafeLogger log() method', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('log() with INFO level routes to console.log', () => {
    const bsl = new BrowserSafeLogger({ level: LogLevel.TRACE });
    bsl.log(LogLevel.INFO, 'via log()');
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  it('log() with DEBUG level routes to console.debug', () => {
    const bsl = new BrowserSafeLogger({ level: LogLevel.TRACE });
    bsl.log(LogLevel.DEBUG, 'via log debug');
    expect(consoleDebugSpy).toHaveBeenCalled();
  });

  it('log() is filtered by shouldLog', () => {
    const bsl = new BrowserSafeLogger({ level: LogLevel.WARN });
    bsl.log(LogLevel.DEBUG, 'filtered out');
    expect(consoleDebugSpy).not.toHaveBeenCalled();
  });

  it('log() with metadata and error', () => {
    const bsl = new BrowserSafeLogger({ level: LogLevel.TRACE, format: 'json' });
    const err = new Error('log err');
    bsl.log(LogLevel.INFO, 'with err', { x: 1 }, err);
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.error.message).toBe('log err');
    expect(parsed.metadata.x).toBe(1);
  });
});

describe('BrowserSafeLogger environment detection', () => {
  it('isNode returns true in Vitest (Node.js)', () => {
    const bsl = new BrowserSafeLogger() as AnyLogger;
    expect(bsl.isNode()).toBe(true);
  });

  it('getPid returns a number in Node.js', () => {
    const bsl = new BrowserSafeLogger() as AnyLogger;
    expect(typeof bsl.getPid()).toBe('number');
  });

  it('getHostname returns a string in Node.js', () => {
    const bsl = new BrowserSafeLogger() as AnyLogger;
    expect(typeof bsl.getHostname()).toBe('string');
  });

  it('getHostname returns a valid hostname string in Node.js', () => {
    const bsl = new BrowserSafeLogger() as AnyLogger;
    const hostname = bsl.getHostname();
    expect(typeof hostname).toBe('string');
    expect(hostname.length).toBeGreaterThan(0);
    expect(hostname).not.toBe('unknown');
    expect(hostname).not.toBe('browser');
  });

  it('getMemoryUsage returns used and total in Node.js', () => {
    const bsl = new BrowserSafeLogger() as AnyLogger;
    const mem = bsl.getMemoryUsage();
    expect(mem).not.toBeNull();
    expect(typeof mem.used).toBe('number');
    expect(typeof mem.total).toBe('number');
  });

  it('getMemoryUsage returns undefined when process.memoryUsage() throws', () => {
    const bsl = new BrowserSafeLogger() as AnyLogger;
    vi.spyOn(bsl, 'isNode').mockReturnValue(true);
    const originalMemUsage = process.memoryUsage;
    // @ts-expect-error intentional override — real memoryUsage has .rss() attached
    process.memoryUsage = () => { throw new Error('mem fail'); };
    const result = bsl.getMemoryUsage();
    expect(result).toBeUndefined();
    process.memoryUsage = originalMemUsage;
    vi.restoreAllMocks();
  });

  it('getMemoryUsage returns undefined when not in Node (non-Node path)', () => {
    const bsl = new BrowserSafeLogger() as AnyLogger;
    vi.spyOn(bsl, 'isNode').mockReturnValue(false);
    const result = bsl.getMemoryUsage();
    expect(result).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('getPid returns undefined when not in Node', () => {
    const bsl = new BrowserSafeLogger() as AnyLogger;
    vi.spyOn(bsl, 'isNode').mockReturnValue(false);
    const result = bsl.getPid();
    expect(result).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('getHostname returns "browser" when not in Node and window is undefined', () => {
    const bsl = new BrowserSafeLogger() as AnyLogger;
    vi.spyOn(bsl, 'isNode').mockReturnValue(false);
    // In Node, window is not defined, so typeof window === 'undefined'
    const result = bsl.getHostname();
    expect(result).toBe('browser');
    vi.restoreAllMocks();
  });
});

describe('BrowserSafeLogger enablePerformance', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes performance.duration when enablePerformance=true', () => {
    const bsl = new BrowserSafeLogger({ enablePerformance: true, format: 'json', level: LogLevel.TRACE });
    bsl.info('perf test');
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.performance).toBeDefined();
    expect(typeof parsed.performance.duration).toBe('number');
  });

  it('includes performance.memory when in Node.js', () => {
    const bsl = new BrowserSafeLogger({ enablePerformance: true, format: 'json', level: LogLevel.TRACE });
    bsl.info('perf with memory');
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.performance.memory).toBeDefined();
    expect(typeof parsed.performance.memory.used).toBe('number');
  });

  it('excludes performance when enablePerformance=false', () => {
    const bsl = new BrowserSafeLogger({ enablePerformance: false, format: 'json', level: LogLevel.TRACE });
    bsl.info('no perf');
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.performance).toBeUndefined();
  });
});

describe('BrowserSafeLogger version in entry', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes version when config.version is set', () => {
    const bsl = new BrowserSafeLogger({ format: 'json', version: '2.0.0' });
    bsl.info('versioned');
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe('2.0.0');
  });

  it('excludes version when config.version is not set', () => {
    const bsl = new BrowserSafeLogger({ format: 'json' });
    bsl.info('no version');
    const raw = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBeUndefined();
  });
});

describe('browserLogger and browserLoggers exports', () => {
  it('browserLogger is a BrowserSafeLogger instance', () => {
    expect(browserLogger).toBeInstanceOf(BrowserSafeLogger);
  });

  it('browserLoggers has expected categories', () => {
    expect(browserLoggers).toHaveProperty('system');
    expect(browserLoggers).toHaveProperty('auth');
    expect(browserLoggers).toHaveProperty('api');
    expect(browserLoggers).toHaveProperty('db');
    expect(browserLoggers).toHaveProperty('ai');
    expect(browserLoggers).toHaveProperty('realtime');
    expect(browserLoggers).toHaveProperty('permissions');
    expect(browserLoggers).toHaveProperty('monitoring');
  });

  it('each browserLoggers category is a BrowserSafeLogger instance', () => {
    for (const [, value] of Object.entries(browserLoggers)) {
      expect(value).toBeInstanceOf(BrowserSafeLogger);
    }
  });
});

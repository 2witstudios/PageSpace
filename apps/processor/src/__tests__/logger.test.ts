import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

describe('processorLogger', () => {
  const consoleSpy = {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };

  beforeEach(() => {
    consoleSpy.log.mockClear();
    consoleSpy.warn.mockClear();
    consoleSpy.error.mockClear();
  });

  afterEach(() => {
    consoleSpy.log.mockRestore();
    consoleSpy.warn.mockRestore();
    consoleSpy.error.mockRestore();
  });

  it('logs info messages with JSON format', async () => {
    const consoleMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { processorLogger } = await import('../logger');
    processorLogger.info('test info message', { key: 'value' });
    expect(consoleMock).toHaveBeenCalledTimes(1);
    const loggedLine = consoleMock.mock.calls[0][0];
    const parsed = JSON.parse(loggedLine);
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('test info message');
    expect(parsed.service).toBe('processor');
    expect(parsed.meta.key).toBe('value');
    consoleMock.mockRestore();
  });

  it('logs warn messages to console.warn', async () => {
    const consoleMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { processorLogger } = await import('../logger');
    processorLogger.warn('test warn', { status: 'warn' });
    expect(consoleMock).toHaveBeenCalledTimes(1);
    const loggedLine = consoleMock.mock.calls[0][0];
    const parsed = JSON.parse(loggedLine);
    expect(parsed.level).toBe('warn');
    consoleMock.mockRestore();
  });

  it('logs debug messages to console.log', async () => {
    const consoleMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { processorLogger } = await import('../logger');
    processorLogger.debug('debug message');
    expect(consoleMock).toHaveBeenCalledTimes(1);
    const loggedLine = consoleMock.mock.calls[0][0];
    const parsed = JSON.parse(loggedLine);
    expect(parsed.level).toBe('debug');
    consoleMock.mockRestore();
  });

  it('logs error messages with Error instance to console.error', async () => {
    const consoleMock = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { processorLogger } = await import('../logger');
    const err = new Error('test error');
    processorLogger.error('error occurred', err, { context: 'test' });
    expect(consoleMock).toHaveBeenCalledTimes(1);
    const loggedLine = consoleMock.mock.calls[0][0];
    const parsed = JSON.parse(loggedLine);
    expect(parsed.level).toBe('error');
    expect(parsed.error.message).toBe('test error');
    expect(parsed.error.name).toBe('Error');
    consoleMock.mockRestore();
  });

  it('logs error messages without Error instance (null)', async () => {
    const consoleMock = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { processorLogger } = await import('../logger');
    processorLogger.error('error occurred', null, { context: 'test' });
    expect(consoleMock).toHaveBeenCalledTimes(1);
    const loggedLine = consoleMock.mock.calls[0][0];
    const parsed = JSON.parse(loggedLine);
    expect(parsed.level).toBe('error');
    expect(parsed.error).toBeUndefined();
    consoleMock.mockRestore();
  });

  it('omits meta when empty', async () => {
    const consoleMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { processorLogger } = await import('../logger');
    processorLogger.info('no meta');
    const loggedLine = consoleMock.mock.calls[0][0];
    const parsed = JSON.parse(loggedLine);
    expect(parsed.meta).toBeUndefined();
    consoleMock.mockRestore();
  });

  it('serializes BigInt values', async () => {
    const consoleMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { processorLogger } = await import('../logger');
    processorLogger.info('bigint test', { bigValue: BigInt(12345) as unknown as number });
    const loggedLine = consoleMock.mock.calls[0][0];
    const parsed = JSON.parse(loggedLine);
    expect(parsed.meta.bigValue).toBe('12345');
    consoleMock.mockRestore();
  });

  it('serializes Map values', async () => {
    const consoleMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { processorLogger } = await import('../logger');
    const myMap = new Map([['key', 'value']]);
    processorLogger.info('map test', { myMap: myMap as unknown as Record<string, unknown> });
    const loggedLine = consoleMock.mock.calls[0][0];
    const parsed = JSON.parse(loggedLine);
    expect(parsed.meta.myMap.key).toBe('value');
    consoleMock.mockRestore();
  });

  it('includes timestamp in output', async () => {
    const consoleMock = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { processorLogger } = await import('../logger');
    processorLogger.info('timestamp test');
    const loggedLine = consoleMock.mock.calls[0][0];
    const parsed = JSON.parse(loggedLine);
    expect(parsed.timestamp).toBeTruthy();
    expect(new Date(parsed.timestamp)).toBeInstanceOf(Date);
    consoleMock.mockRestore();
  });
});

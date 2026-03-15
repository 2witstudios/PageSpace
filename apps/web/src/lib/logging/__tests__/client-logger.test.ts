import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('client-logger', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('should create a logger with all log methods', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_CLIENT_LOG_LEVEL', 'debug');
    vi.stubEnv('NEXT_PUBLIC_CLIENT_DEBUG', 'true');
    const { createClientLogger } = await import('../client-logger');
    const logger = createClientLogger({ namespace: 'test' });

    expect(logger.debug).toBeInstanceOf(Function);
    expect(logger.info).toBeInstanceOf(Function);
    expect(logger.warn).toBeInstanceOf(Function);
    expect(logger.error).toBeInstanceOf(Function);
    vi.unstubAllEnvs();
  });

  it('should log debug messages when debug is enabled', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_CLIENT_LOG_LEVEL', 'debug');
    vi.stubEnv('NEXT_PUBLIC_CLIENT_DEBUG', 'true');
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const { createClientLogger } = await import('../client-logger');
    const logger = createClientLogger({ namespace: 'test' });
    logger.debug('test message');

    expect(debugSpy).toHaveBeenCalled();
    const call = debugSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(call.message).toBe('test message');
    expect(call.namespace).toBe('test');
    expect(call.level).toBe('DEBUG');
    vi.unstubAllEnvs();
  });

  it('should include component in log entry when provided', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_CLIENT_LOG_LEVEL', 'debug');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const { createClientLogger } = await import('../client-logger');
    const logger = createClientLogger({ namespace: 'test', component: 'MyComponent' });
    logger.info('test');

    const call = infoSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(call.component).toBe('MyComponent');
    vi.unstubAllEnvs();
  });

  it('should include sanitized metadata', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_CLIENT_LOG_LEVEL', 'debug');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { createClientLogger } = await import('../client-logger');
    const logger = createClientLogger({ namespace: 'test' });
    const err = new Error('test error');
    logger.warn('warning', { error: err, count: 5 });

    const call = warnSpy.mock.calls[0][0] as Record<string, unknown>;
    const metadata = call.metadata as Record<string, unknown>;
    expect(metadata.count).toBe(5);
    const errorMeta = metadata.error as Record<string, unknown>;
    expect(errorMeta.name).toBe('Error');
    expect(errorMeta.message).toBe('test error');
    vi.unstubAllEnvs();
  });

  it('should not include empty metadata', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_CLIENT_LOG_LEVEL', 'debug');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { createClientLogger } = await import('../client-logger');
    const logger = createClientLogger({ namespace: 'test' });
    logger.error('error msg');

    const call = errorSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(call.metadata).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('should suppress debug in production when debug not enabled', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_CLIENT_LOG_LEVEL', '');
    vi.stubEnv('NEXT_PUBLIC_CLIENT_DEBUG', '');
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const { createClientLogger } = await import('../client-logger');
    const logger = createClientLogger({ namespace: 'test' });
    logger.debug('should not appear');

    expect(debugSpy).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('should handle invalid log level gracefully', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_CLIENT_LOG_LEVEL', 'invalid');
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const { createClientLogger } = await import('../client-logger');
    const logger = createClientLogger({ namespace: 'test' });
    logger.debug('test');

    expect(debugSpy).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('should sanitize nested objects and arrays in metadata', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_CLIENT_LOG_LEVEL', 'debug');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const { createClientLogger } = await import('../client-logger');
    const logger = createClientLogger({ namespace: 'test' });
    logger.info('test', { items: [new Error('e1')], nested: { val: 42 } });

    const call = infoSpy.mock.calls[0][0] as Record<string, unknown>;
    const metadata = call.metadata as Record<string, unknown>;
    expect(Array.isArray(metadata.items)).toBe(true);
    const items = metadata.items as Array<Record<string, unknown>>;
    expect(items[0].name).toBe('Error');
    const nested = metadata.nested as Record<string, unknown>;
    expect(nested.val).toBe(42);
    vi.unstubAllEnvs();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ioredis', () => {
  return {
    default: vi.fn(),
  };
});

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

describe('shared-redis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('should return null when REDIS_URL is not set', async () => {
    const origRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = '';
    const { getSharedRedisClient, resetSharedRedis } = await import('../shared-redis');
    resetSharedRedis();
    const client = await getSharedRedisClient();
    expect(client).toBeNull();
    process.env.REDIS_URL = origRedisUrl;
  });

  it('should report unavailable when not connected', async () => {
    const { isSharedRedisAvailable, resetSharedRedis } = await import('../shared-redis');
    resetSharedRedis();
    expect(isSharedRedisAvailable()).toBe(false);
  });

  it('should handle shutdown when not connected', async () => {
    const { shutdownSharedRedis, resetSharedRedis } = await import('../shared-redis');
    resetSharedRedis();
    await expect(shutdownSharedRedis()).resolves.toBeUndefined();
  });

  it('resetSharedRedis should clear state', async () => {
    const { resetSharedRedis, isSharedRedisAvailable } = await import('../shared-redis');
    resetSharedRedis();
    expect(isSharedRedisAvailable()).toBe(false);
  });
});

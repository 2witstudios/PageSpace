import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock the shared-redis module before importing the module under test
vi.mock('../../services/shared-redis', () => ({
  getSharedRedisClient: vi.fn(),
  isSharedRedisAvailable: vi.fn(),
}));

// Mock the logger
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

import {
  getSecurityRedisClient,
  isSecurityRedisAvailable,
  tryGetSecurityRedisClient,
  recordJTI,
  isJTIRevoked,
  revokeJTI,
  revokeAllUserJTIs,
  checkRateLimit,
  getRateLimitStatus,
  resetRateLimit,
  setSessionData,
  getSessionData,
  deleteSessionData,
  checkSecurityRedisHealth,
} from '../security-redis';
import { getSharedRedisClient, isSharedRedisAvailable } from '../../services/shared-redis';

// Create a mock Redis client with proper sorted set simulation
function createMockRedis() {
  const store = new Map<string, { value: string; expiry?: number }>();
  // Use Map<string, Array<{score: number, member: string}>> for proper sorted set behavior
  const sortedSets = new Map<string, Array<{ score: number; member: string }>>();

  return {
    setex: vi.fn(async (key: string, ttl: number, value: string) => {
      store.set(key, { value, expiry: Date.now() + ttl * 1000 });
      return 'OK';
    }),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiry && Date.now() > entry.expiry) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    ttl: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry || !entry.expiry) return -1;
      const remaining = Math.ceil((entry.expiry - Date.now()) / 1000);
      return remaining > 0 ? remaining : -2;
    }),
    del: vi.fn(async (key: string) => {
      const deleted = store.delete(key) ? 1 : 0;
      sortedSets.delete(key);
      return deleted;
    }),
    ping: vi.fn(async () => 'PONG'),
    pipeline: vi.fn(() => {
      const commands: Array<{ cmd: string; args: unknown[] }> = [];
      const pipe = {
        zremrangebyscore: (key: string, min: number, max: number) => {
          commands.push({ cmd: 'zremrangebyscore', args: [key, min, max] });
          return pipe;
        },
        zadd: (key: string, score: number, member: string) => {
          commands.push({ cmd: 'zadd', args: [key, score, member] });
          return pipe;
        },
        zcard: (key: string) => {
          commands.push({ cmd: 'zcard', args: [key] });
          return pipe;
        },
        pexpire: (key: string, ms: number) => {
          commands.push({ cmd: 'pexpire', args: [key, ms] });
          return pipe;
        },
        exec: vi.fn(async () => {
          const results: Array<[null, unknown]> = [];
          for (const { cmd, args } of commands) {
            const key = args[0] as string;
            if (!sortedSets.has(key)) {
              sortedSets.set(key, []);
            }
            const set = sortedSets.get(key)!;

            switch (cmd) {
              case 'zremrangebyscore': {
                const [, min, max] = args as [string, number, number];
                const before = set.length;
                const filtered = set.filter(e => e.score < min || e.score > max);
                sortedSets.set(key, filtered);
                results.push([null, before - filtered.length]);
                break;
              }
              case 'zadd': {
                const [, score, member] = args as [string, number, string];
                set.push({ score, member });
                results.push([null, 1]);
                break;
              }
              case 'zcard':
                results.push([null, set.length]);
                break;
              case 'pexpire':
                results.push([null, 1]);
                break;
            }
          }
          return results;
        }),
      };
      return pipe;
    }),
    zcount: vi.fn(async (key: string, min: number, max: number) => {
      const set = sortedSets.get(key);
      if (!set) return 0;
      return set.filter(e => e.score >= min && e.score <= max).length;
    }),
    // For test inspection
    _store: store,
    _sortedSets: sortedSets,
  };
}

describe('security-redis', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    mockRedis = createMockRedis();
    vi.mocked(getSharedRedisClient).mockResolvedValue(mockRedis as never);
    vi.mocked(isSharedRedisAvailable).mockReturnValue(true);
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe('getSecurityRedisClient', () => {
    it('returns Redis client when available', async () => {
      const client = await getSecurityRedisClient();
      expect(client).toBe(mockRedis);
    });

    it('throws in production when Redis unavailable', async () => {
      process.env.NODE_ENV = 'production';
      vi.mocked(getSharedRedisClient).mockResolvedValue(null as never);

      await expect(getSecurityRedisClient()).rejects.toThrow(
        'Redis required for security features in production'
      );
    });

    it('throws in development when Redis unavailable', async () => {
      process.env.NODE_ENV = 'development';
      vi.mocked(getSharedRedisClient).mockResolvedValue(null as never);

      await expect(getSecurityRedisClient()).rejects.toThrow('Redis not available');
    });
  });

  describe('isSecurityRedisAvailable', () => {
    it('returns true when shared Redis is available', () => {
      vi.mocked(isSharedRedisAvailable).mockReturnValue(true);
      expect(isSecurityRedisAvailable()).toBe(true);
    });

    it('returns false when shared Redis is unavailable', () => {
      vi.mocked(isSharedRedisAvailable).mockReturnValue(false);
      expect(isSecurityRedisAvailable()).toBe(false);
    });
  });

  describe('tryGetSecurityRedisClient', () => {
    it('returns client when available', async () => {
      const client = await tryGetSecurityRedisClient();
      expect(client).toBe(mockRedis);
    });

    it('returns null when unavailable (no throw)', async () => {
      vi.mocked(getSharedRedisClient).mockResolvedValue(null as never);
      const client = await tryGetSecurityRedisClient();
      expect(client).toBeNull();
    });
  });

  describe('JTI Operations', () => {
    describe('recordJTI', () => {
      it('stores JTI with expiry and user ID', async () => {
        await recordJTI('test-jti-123', 'user-456', 300);

        expect(mockRedis.setex).toHaveBeenCalledWith(
          'sec:jti:test-jti-123',
          300,
          expect.stringContaining('"status":"valid"')
        );
        expect(mockRedis.setex).toHaveBeenCalledWith(
          'sec:jti:test-jti-123',
          300,
          expect.stringContaining('"userId":"user-456"')
        );
      });

      it('includes creation timestamp', async () => {
        const before = Date.now();
        await recordJTI('jti-time', 'user-1', 300);
        const after = Date.now();

        const call = mockRedis.setex.mock.calls[0];
        const stored = JSON.parse(call[2] as string);
        expect(stored.createdAt).toBeGreaterThanOrEqual(before);
        expect(stored.createdAt).toBeLessThanOrEqual(after);
      });
    });

    describe('isJTIRevoked', () => {
      it('returns false for valid JTI', async () => {
        await recordJTI('valid-jti', 'user-1', 300);
        const revoked = await isJTIRevoked('valid-jti');
        expect(revoked).toBe(false);
      });

      it('returns true for non-existent JTI (fail closed)', async () => {
        const revoked = await isJTIRevoked('nonexistent-jti');
        expect(revoked).toBe(true);
      });

      it('returns true for revoked JTI', async () => {
        await recordJTI('to-revoke', 'user-1', 300);
        await revokeJTI('to-revoke', 'test revocation');
        const revoked = await isJTIRevoked('to-revoke');
        expect(revoked).toBe(true);
      });

      it('returns true for corrupted data (fail closed)', async () => {
        mockRedis._store.set('sec:jti:corrupted', { value: 'not-json{{{' });
        const revoked = await isJTIRevoked('corrupted');
        expect(revoked).toBe(true);
      });
    });

    describe('revokeJTI', () => {
      it('marks JTI as revoked with reason', async () => {
        await recordJTI('revoke-test', 'user-1', 300);
        const result = await revokeJTI('revoke-test', 'suspicious activity');

        expect(result).toBe(true);
        const stored = JSON.parse(mockRedis._store.get('sec:jti:revoke-test')!.value);
        expect(stored.status).toBe('revoked');
        expect(stored.reason).toBe('suspicious activity');
        expect(stored.revokedAt).toBeDefined();
      });

      it('logs revocation with JTI redacted for security', async () => {
        const { loggers } = await import('../../logging/logger-config');
        await recordJTI('sensitive-jti-12345', 'user-1', 300);
        await revokeJTI('sensitive-jti-12345', 'test revocation');

        expect(loggers.api.info).toHaveBeenCalledWith('JTI revoked', {
          jti: '[REDACTED]',
          reason: 'test revocation',
        });
      });

      it('preserves original TTL on revocation', async () => {
        await recordJTI('ttl-test', 'user-1', 300);
        await revokeJTI('ttl-test', 'test');

        // setex should be called twice - once for record, once for revoke
        expect(mockRedis.setex).toHaveBeenCalledTimes(2);
      });

      it('returns false for expired/nonexistent JTI', async () => {
        const result = await revokeJTI('nonexistent', 'test');
        expect(result).toBe(false);
      });

      it('preserves userId in revocation record', async () => {
        await recordJTI('user-preserve', 'original-user', 300);
        await revokeJTI('user-preserve', 'test');

        const stored = JSON.parse(mockRedis._store.get('sec:jti:user-preserve')!.value);
        expect(stored.userId).toBe('original-user');
      });
    });

    describe('revokeAllUserJTIs', () => {
      it('logs message about token version bump', async () => {
        const { loggers } = await import('../../logging/logger-config');
        await revokeAllUserJTIs('user-123');

        expect(loggers.api.info).toHaveBeenCalledWith(
          'User token version will be bumped for JTI revocation',
          { userId: 'user-123' }
        );
      });
    });
  });

  describe('Rate Limiting Operations', () => {
    describe('checkRateLimit', () => {
      it('allows requests within limit', async () => {
        const result = await checkRateLimit('rate-test', 5, 60000);

        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(4);
        expect(result.totalCount).toBe(1);
      });

      it('blocks requests when limit exceeded', async () => {
        // Make 5 requests (limit)
        for (let i = 0; i < 5; i++) {
          await checkRateLimit('exceed-test', 5, 60000);
        }

        // 6th should be blocked
        const result = await checkRateLimit('exceed-test', 5, 60000);
        expect(result.allowed).toBe(false);
        expect(result.remaining).toBe(0);
      });

      it('uses sliding window algorithm with sorted sets', async () => {
        await checkRateLimit('sliding-test', 10, 60000);

        // Verify pipeline was used
        expect(mockRedis.pipeline).toHaveBeenCalled();
      });

      it('returns resetAt timestamp', async () => {
        const before = Date.now();
        const result = await checkRateLimit('reset-time', 5, 60000);
        const after = Date.now();

        expect(result.resetAt.getTime()).toBeGreaterThanOrEqual(before + 60000);
        expect(result.resetAt.getTime()).toBeLessThanOrEqual(after + 60000);
      });

      it('uses separate limits for different keys', async () => {
        // Fill up key1
        for (let i = 0; i < 3; i++) {
          await checkRateLimit('key1', 3, 60000);
        }

        // key1 should be blocked
        const result1 = await checkRateLimit('key1', 3, 60000);
        expect(result1.allowed).toBe(false);

        // key2 should still work
        const result2 = await checkRateLimit('key2', 3, 60000);
        expect(result2.allowed).toBe(true);
      });
    });

    describe('getRateLimitStatus', () => {
      it('returns status without incrementing counter', async () => {
        // Make one request
        await checkRateLimit('status-test', 5, 60000);

        // Check status multiple times
        const status1 = await getRateLimitStatus('status-test', 5, 60000);
        const status2 = await getRateLimitStatus('status-test', 5, 60000);

        expect(status1.totalCount).toBe(1);
        expect(status2.totalCount).toBe(1);
        expect(status1.remaining).toBe(4);
      });

      it('correctly reports blocked status', async () => {
        for (let i = 0; i < 5; i++) {
          await checkRateLimit('blocked-status', 5, 60000);
        }

        const status = await getRateLimitStatus('blocked-status', 5, 60000);
        expect(status.allowed).toBe(false);
        expect(status.remaining).toBe(0);
      });
    });

    describe('resetRateLimit', () => {
      it('clears rate limit for key', async () => {
        // Make requests up to limit
        for (let i = 0; i < 5; i++) {
          await checkRateLimit('reset-test', 5, 60000);
        }

        // Reset
        await resetRateLimit('reset-test');

        // Should work again
        const result = await checkRateLimit('reset-test', 5, 60000);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(4);
      });

      it('calls del on correct key', async () => {
        await resetRateLimit('del-test');
        expect(mockRedis.del).toHaveBeenCalledWith('sec:rate:del-test');
      });
    });
  });

  describe('Session Operations', () => {
    describe('setSessionData', () => {
      it('stores session data with expiry', async () => {
        await setSessionData('sess-123', { userId: 'user-1', role: 'admin' }, 3600);

        expect(mockRedis.setex).toHaveBeenCalledWith(
          'sec:session:sess-123',
          3600,
          JSON.stringify({ userId: 'user-1', role: 'admin' })
        );
      });
    });

    describe('getSessionData', () => {
      it('returns session data when exists', async () => {
        await setSessionData('get-sess', { foo: 'bar' }, 3600);
        const data = await getSessionData('get-sess');

        expect(data).toEqual({ foo: 'bar' });
      });

      it('returns null for nonexistent session', async () => {
        const data = await getSessionData('nonexistent');
        expect(data).toBeNull();
      });

      it('returns null for corrupted data', async () => {
        mockRedis._store.set('sec:session:corrupted', { value: 'not-json{{{' });
        const data = await getSessionData('corrupted');
        expect(data).toBeNull();
      });
    });

    describe('deleteSessionData', () => {
      it('removes session data', async () => {
        await setSessionData('delete-sess', { data: 'test' }, 3600);
        await deleteSessionData('delete-sess');

        expect(mockRedis.del).toHaveBeenCalledWith('sec:session:delete-sess');
      });
    });
  });

  describe('Health Check', () => {
    describe('checkSecurityRedisHealth', () => {
      it('returns available true when Redis responds', async () => {
        const health = await checkSecurityRedisHealth();

        expect(health.available).toBe(true);
        expect(health.latencyMs).toBeDefined();
        expect(health.error).toBeUndefined();
      });

      it('returns available false with error when Redis fails', async () => {
        vi.mocked(getSharedRedisClient).mockResolvedValue(null as never);

        const health = await checkSecurityRedisHealth();

        expect(health.available).toBe(false);
        expect(health.error).toBeDefined();
      });

      it('measures latency', async () => {
        const health = await checkSecurityRedisHealth();

        expect(typeof health.latencyMs).toBe('number');
        expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      });
    });
  });
});

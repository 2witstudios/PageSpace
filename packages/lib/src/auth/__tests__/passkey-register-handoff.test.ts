import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../token-utils', () => ({
  hashToken: vi.fn((t: string) => `hashed_${t}`),
}));

vi.mock('../../security/security-redis', () => ({
  tryGetSecurityRedisClient: vi.fn(),
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    auth: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

import {
  createPasskeyRegisterHandoff,
  peekPasskeyRegisterHandoff,
  consumePasskeyRegisterHandoff,
  type PasskeyRegisterHandoffData,
} from '../passkey-register-handoff';
import { tryGetSecurityRedisClient } from '../../security/security-redis';

interface MockRedis {
  setex: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
  store: Map<string, string>;
}

function makeMockRedis(): MockRedis {
  const store = new Map<string, string>();
  const redis: MockRedis = {
    store,
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    eval: vi.fn(async (_script: string, _numKeys: number, key: string) => {
      const value = store.get(key) ?? null;
      if (value !== null) {
        store.delete(key);
      }
      return value;
    }),
  };
  return redis;
}

describe('passkey-register-handoff', () => {
  let mockRedis: MockRedis;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = makeMockRedis();
  });

  describe('createPasskeyRegisterHandoff', () => {
    it('should create a base64url token and store hashed key with 300s TTL', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);

      const token = await createPasskeyRegisterHandoff({ userId: 'user-1' });

      expect(typeof token).toBe('string');
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token.length).toBeGreaterThanOrEqual(42);
      expect(mockRedis.setex).toHaveBeenCalledTimes(1);
      const [key, ttl, value] = mockRedis.setex.mock.calls[0];
      expect(key).toMatch(/^auth:passkey-register-handoff:/);
      expect(ttl).toBe(300);
      const parsed = JSON.parse(value as string);
      expect(parsed.userId).toBe('user-1');
      expect(typeof parsed.createdAt).toBe('number');
    });

    it('should generate a unique token on each call', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);

      const a = await createPasskeyRegisterHandoff({ userId: 'user-1' });
      const b = await createPasskeyRegisterHandoff({ userId: 'user-1' });

      expect(a).not.toBe(b);
    });

    it('should throw in production when Redis is unavailable', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null);

      await expect(createPasskeyRegisterHandoff({ userId: 'user-1' })).rejects.toThrow(
        /Redis unavailable in production/
      );

      process.env.NODE_ENV = origEnv;
    });

    it('should throw in development when Redis is unavailable', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null);

      await expect(createPasskeyRegisterHandoff({ userId: 'user-1' })).rejects.toThrow(
        /Redis required/
      );

      process.env.NODE_ENV = origEnv;
    });
  });

  describe('peekPasskeyRegisterHandoff', () => {
    it('should return the stored data without deleting the key', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);

      const token = await createPasskeyRegisterHandoff({ userId: 'user-42' });
      const peeked = await peekPasskeyRegisterHandoff(token);

      expect(peeked).not.toBeNull();
      expect(peeked?.userId).toBe('user-42');
      expect(typeof peeked?.createdAt).toBe('number');
      expect(mockRedis.store.size).toBe(1);

      const consumed = await consumePasskeyRegisterHandoff(token);
      expect(consumed).not.toBeNull();
      expect(consumed?.userId).toBe('user-42');
    });

    it('should return null for an unknown token', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);

      const result = await peekPasskeyRegisterHandoff('never-issued');
      expect(result).toBeNull();
    });

    it('should return null for empty token', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);

      expect(await peekPasskeyRegisterHandoff('')).toBeNull();
      expect(
        await peekPasskeyRegisterHandoff(null as unknown as string)
      ).toBeNull();
    });

    it('should return null without throwing when stored data is malformed JSON', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);
      mockRedis.store.set('auth:passkey-register-handoff:hashed_bad', 'not-json{');

      const result = await peekPasskeyRegisterHandoff('bad');
      expect(result).toBeNull();
    });

    it('should return null when Redis is unavailable in production (no throw)', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null);

      const result = await peekPasskeyRegisterHandoff('any');
      expect(result).toBeNull();

      process.env.NODE_ENV = origEnv;
    });

    it('should return null when Redis is unavailable in development (no throw)', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null);

      const result = await peekPasskeyRegisterHandoff('any');
      expect(result).toBeNull();

      process.env.NODE_ENV = origEnv;
    });
  });

  describe('consumePasskeyRegisterHandoff', () => {
    it('should return parsed data and delete the key on first call', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);

      const token = await createPasskeyRegisterHandoff({ userId: 'user-7' });
      expect(mockRedis.store.size).toBe(1);

      const result = await consumePasskeyRegisterHandoff(token);
      expect(result).not.toBeNull();
      expect(result?.userId).toBe('user-7');
      expect(mockRedis.store.size).toBe(0);
    });

    it('should be one-time-use: second consume returns null', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);

      const token = await createPasskeyRegisterHandoff({ userId: 'user-9' });

      const first = await consumePasskeyRegisterHandoff(token);
      const second = await consumePasskeyRegisterHandoff(token);

      expect(first?.userId).toBe('user-9');
      expect(second).toBeNull();
    });

    it('should use an atomic Lua GET+DEL script (not a plain get/del pair)', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);

      const token = await createPasskeyRegisterHandoff({ userId: 'user-atomic' });
      await consumePasskeyRegisterHandoff(token);

      expect(mockRedis.eval).toHaveBeenCalledTimes(1);
      const [script] = mockRedis.eval.mock.calls[0];
      expect(script).toContain('GET');
      expect(script).toContain('DEL');
    });

    it('should return null for empty or non-string token', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);

      expect(await consumePasskeyRegisterHandoff('')).toBeNull();
      expect(
        await consumePasskeyRegisterHandoff(null as unknown as string)
      ).toBeNull();
    });

    it('should return null for an unknown/expired token', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);

      const result = await consumePasskeyRegisterHandoff('never-issued');
      expect(result).toBeNull();
    });

    it('should return null without throwing when stored JSON is malformed', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);
      mockRedis.store.set('auth:passkey-register-handoff:hashed_bad', 'not-json{');

      const result = await consumePasskeyRegisterHandoff('bad');
      expect(result).toBeNull();
    });

    it('should return null when Redis is unavailable in production (no throw)', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null);

      const result = await consumePasskeyRegisterHandoff('any');
      expect(result).toBeNull();

      process.env.NODE_ENV = origEnv;
    });

    it('should return null when Redis is unavailable in development (no throw)', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null);

      const result = await consumePasskeyRegisterHandoff('any');
      expect(result).toBeNull();

      process.env.NODE_ENV = origEnv;
    });
  });

  describe('type shape', () => {
    it('should expose the expected interface', () => {
      const data: PasskeyRegisterHandoffData = {
        userId: 'u',
        createdAt: 1,
      };
      expect(data.userId).toBe('u');
    });
  });
});

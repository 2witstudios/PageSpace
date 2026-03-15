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

import { createExchangeCode, consumeExchangeCode, type ExchangeCodeData } from '../exchange-codes';
import { tryGetSecurityRedisClient } from '../../security/security-redis';

const mockRedis = {
  setex: vi.fn(),
  eval: vi.fn(),
};

const testData: ExchangeCodeData = {
  sessionToken: 'sess-token',
  csrfToken: 'csrf-token',
  deviceToken: 'dev-token',
  provider: 'google',
  userId: 'user-1',
  createdAt: Date.now(),
};

describe('exchange-codes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createExchangeCode', () => {
    it('should create exchange code when Redis is available', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);

      const code = await createExchangeCode(testData);
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(0);
      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.stringContaining('auth:exchange:'),
        300,
        expect.any(String)
      );
    });

    it('should throw in production when Redis is unavailable', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null);

      await expect(createExchangeCode(testData)).rejects.toThrow(
        'Cannot create exchange code: Redis unavailable in production'
      );
      process.env.NODE_ENV = origEnv;
    });

    it('should throw in development when Redis is unavailable', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null);

      await expect(createExchangeCode(testData)).rejects.toThrow(
        'Redis required for exchange codes'
      );
      process.env.NODE_ENV = origEnv;
    });
  });

  describe('consumeExchangeCode', () => {
    it('should return null for empty code', async () => {
      const result = await consumeExchangeCode('');
      expect(result).toBeNull();
    });

    it('should return null for non-string code', async () => {
      const result = await consumeExchangeCode(null as unknown as string);
      expect(result).toBeNull();
    });

    it('should return null when Redis is unavailable in production', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null);

      const result = await consumeExchangeCode('valid-code');
      expect(result).toBeNull();
      process.env.NODE_ENV = origEnv;
    });

    it('should return null when Redis is unavailable in non-production', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(null);

      const result = await consumeExchangeCode('valid-code');
      expect(result).toBeNull();
      process.env.NODE_ENV = origEnv;
    });

    it('should return null when code not found in Redis', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);
      mockRedis.eval.mockResolvedValue(null);

      const result = await consumeExchangeCode('expired-code');
      expect(result).toBeNull();
    });

    it('should return parsed data when code is valid', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);
      mockRedis.eval.mockResolvedValue(JSON.stringify(testData));

      const result = await consumeExchangeCode('valid-code');
      expect(result).toEqual(testData);
    });

    it('should return null when Redis data is invalid JSON', async () => {
      vi.mocked(tryGetSecurityRedisClient).mockResolvedValue(mockRedis as never);
      mockRedis.eval.mockResolvedValue('not-json{');

      const result = await consumeExchangeCode('bad-data-code');
      expect(result).toBeNull();
    });
  });
});

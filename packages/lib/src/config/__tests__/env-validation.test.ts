import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateEnv,
  getEnvErrors,
  isEnvValid,
  serverEnvSchema,
} from '../env-validation';

describe('env-validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    // Reset to minimal deterministic env to avoid host pollution
    process.env = { NODE_ENV: 'test' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('serverEnvSchema', () => {
    it('given valid required env vars, should parse successfully', () => {
      const validEnv = {
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        CSRF_SECRET: 'b'.repeat(32),
        ENCRYPTION_KEY: 'c'.repeat(32),
      };

      const result = serverEnvSchema.safeParse(validEnv);

      expect(result.success).toBe(true);
    });

    it('given missing DATABASE_URL, should fail validation', () => {
      const invalidEnv = {
        CSRF_SECRET: 'b'.repeat(32),
        ENCRYPTION_KEY: 'c'.repeat(32),
      };

      const result = serverEnvSchema.safeParse(invalidEnv);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('DATABASE_URL'))).toBe(true);
      }
    });

    it('given invalid DATABASE_URL format, should fail validation', () => {
      const invalidEnv = {
        DATABASE_URL: 'not-a-valid-url',
        CSRF_SECRET: 'b'.repeat(32),
        ENCRYPTION_KEY: 'c'.repeat(32),
      };

      const result = serverEnvSchema.safeParse(invalidEnv);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('DATABASE_URL'))).toBe(true);
      }
    });

    it('given optional vars missing, should still parse successfully with defaults', () => {
      const minimalEnv = {
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        CSRF_SECRET: 'b'.repeat(32),
        ENCRYPTION_KEY: 'c'.repeat(32),
      };

      const result = serverEnvSchema.safeParse(minimalEnv);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NODE_ENV).toBe('development');
        expect(result.data.LOG_LEVEL).toBe('info');
      }
    });

    it('given NODE_ENV=production, should accept valid value', () => {
      const prodEnv = {
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        CSRF_SECRET: 'b'.repeat(32),
        ENCRYPTION_KEY: 'c'.repeat(32),
        NODE_ENV: 'production',
      };

      const result = serverEnvSchema.safeParse(prodEnv);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NODE_ENV).toBe('production');
      }
    });

    it('given NODE_ENV=test without CSRF_SECRET, should parse successfully', () => {
      const testEnv = {
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        NODE_ENV: 'test',
      };

      const result = serverEnvSchema.safeParse(testEnv);

      expect(result.success).toBe(true);
    });

    it('given NODE_ENV=production without CSRF_SECRET, should fail validation', () => {
      const prodEnv = {
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        NODE_ENV: 'production',
      };

      const result = serverEnvSchema.safeParse(prodEnv);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('CSRF_SECRET'))).toBe(true);
      }
    });
  });

  describe('validateEnv', () => {
    it('given valid environment, should return parsed env object', () => {
      process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
      process.env.CSRF_SECRET = 'b'.repeat(32);
      process.env.ENCRYPTION_KEY = 'c'.repeat(32);

      const result = validateEnv();

      expect(result.DATABASE_URL).toBe('postgresql://user:pass@localhost:5432/db');
    });

    it('given invalid environment, should throw with descriptive error', () => {
      process.env.DATABASE_URL = '';

      expect(() => validateEnv()).toThrow(/Environment validation failed/);
    });
  });

  describe('getEnvErrors', () => {
    it('given valid environment, should return empty array', () => {
      process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
      process.env.CSRF_SECRET = 'b'.repeat(32);
      process.env.ENCRYPTION_KEY = 'c'.repeat(32);

      const errors = getEnvErrors();

      expect(errors).toEqual([]);
    });

    it('given multiple missing vars, should return all errors', () => {
      process.env.DATABASE_URL = '';
      process.env.CSRF_SECRET = '';

      const errors = getEnvErrors();

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes('DATABASE_URL'))).toBe(true);
    });
  });

  describe('isEnvValid', () => {
    it('given valid environment, should return true', () => {
      process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
      process.env.CSRF_SECRET = 'b'.repeat(32);
      process.env.ENCRYPTION_KEY = 'c'.repeat(32);

      expect(isEnvValid()).toBe(true);
    });

    it('given invalid environment, should return false', () => {
      process.env.DATABASE_URL = '';

      expect(isEnvValid()).toBe(false);
    });
  });
});

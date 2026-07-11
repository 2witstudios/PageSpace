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

    it('given a blank SANDBOX_SESSION_SECRET placeholder, should still parse (fail-closed at runtime, not at startup)', () => {
      const env = {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        SANDBOX_SESSION_SECRET: '',
      };

      const result = serverEnvSchema.safeParse(env);

      expect(result.success).toBe(true);
    });

    it('given a too-short non-empty SANDBOX_SESSION_SECRET, should fail validation', () => {
      const env = {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        SANDBOX_SESSION_SECRET: 'short',
      };

      const result = serverEnvSchema.safeParse(env);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) => i.path.includes('SANDBOX_SESSION_SECRET')),
        ).toBe(true);
      }
    });

    it('given CLICKHOUSE_* vars absent, should parse successfully (analytics tier is off by default, #890 Phase 3)', () => {
      const env = {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      };

      const result = serverEnvSchema.safeParse(env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.CLICKHOUSE_ENABLED).toBeUndefined();
      }
    });

    it('given a stray CLICKHOUSE_ENABLED value (e.g. "0"), should still parse — the exact-match gate lives in clickhouse-env, not app-wide validation', () => {
      const env = {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        CLICKHOUSE_ENABLED: '0',
      };

      const result = serverEnvSchema.safeParse(env);

      expect(result.success).toBe(true);
    });

    it('given full CLICKHOUSE_* connection config, should parse and pass the values through', () => {
      const env = {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        CLICKHOUSE_ENABLED: 'true',
        CLICKHOUSE_HOST: 'https://my-cluster.clickhouse.cloud:8443',
        CLICKHOUSE_USER: 'default',
        CLICKHOUSE_PASSWORD: 'secret',
        CLICKHOUSE_DATABASE: 'pagespace_analytics',
      };

      const result = serverEnvSchema.safeParse(env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.CLICKHOUSE_HOST).toBe('https://my-cluster.clickhouse.cloud:8443');
        expect(result.data.CLICKHOUSE_DATABASE).toBe('pagespace_analytics');
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

  describe('Admin Postgres (trust plane) config', () => {
    const baseEnv = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    };

    it('given a valid postgresql:// ADMIN_DATABASE_URL, should parse and expose it (connect path)', () => {
      const env = {
        ...baseEnv,
        ADMIN_DATABASE_URL: 'postgresql://user:pass@postgres-admin:5432/pagespace_admin',
      };

      const result = serverEnvSchema.safeParse(env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ADMIN_DATABASE_URL).toBe(
          'postgresql://user:pass@postgres-admin:5432/pagespace_admin',
        );
      }
    });

    it('given a valid postgres:// ADMIN_DATABASE_URL, should parse successfully', () => {
      const env = {
        ...baseEnv,
        ADMIN_DATABASE_URL: 'postgres://user:pass@postgres-admin:5432/pagespace_admin',
      };

      const result = serverEnvSchema.safeParse(env);

      expect(result.success).toBe(true);
    });

    it('given a non-postgres ADMIN_DATABASE_URL (http://), should fail with a clear message', () => {
      const env = {
        ...baseEnv,
        ADMIN_DATABASE_URL: 'http://postgres-admin:5432/pagespace_admin',
      };

      const result = serverEnvSchema.safeParse(env);

      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.includes('ADMIN_DATABASE_URL'));
        expect(issue).toBeDefined();
        expect(issue?.message).toMatch(/PostgreSQL connection string/);
      }
    });

    it('given an empty-string ADMIN_DATABASE_URL, should fail validation', () => {
      const env = {
        ...baseEnv,
        ADMIN_DATABASE_URL: '',
      };

      const result = serverEnvSchema.safeParse(env);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) => i.path.includes('ADMIN_DATABASE_URL')),
        ).toBe(true);
      }
    });

    it('given a valid ADMIN_ERASER_DATABASE_URL, should parse and expose it (GDPR eraser identity, #890 leaf 6)', () => {
      const env = {
        ...baseEnv,
        ADMIN_ERASER_DATABASE_URL:
          'postgresql://admin_gdpr_eraser_user:pw@postgres-admin:5432/pagespace_admin',
      };

      const result = serverEnvSchema.safeParse(env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ADMIN_ERASER_DATABASE_URL).toBe(env.ADMIN_ERASER_DATABASE_URL);
      }
    });

    it('given a non-postgres ADMIN_ERASER_DATABASE_URL, should fail; unset should parse (route-level refusal, not boot-level)', () => {
      const bad = serverEnvSchema.safeParse({
        ...baseEnv,
        ADMIN_ERASER_DATABASE_URL: 'http://nope',
      });
      expect(bad.success).toBe(false);

      const unset = serverEnvSchema.safeParse(baseEnv);
      expect(unset.success).toBe(true);
    });

    it('given ADMIN_DATABASE_URL unset with ADMIN_DB_BREAK_GLASS=true, should parse and expose the flag (degrade-loudly path)', () => {
      const env = {
        ...baseEnv,
        ADMIN_DB_BREAK_GLASS: 'true',
      };

      const result = serverEnvSchema.safeParse(env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ADMIN_DATABASE_URL).toBeUndefined();
        expect(result.data.ADMIN_DB_BREAK_GLASS).toBe('true');
      }
    });

    it('given ADMIN_DATABASE_URL unset and no break-glass flag, should parse at the schema level with both undefined (fail-fast lives in adminDb init)', () => {
      const result = serverEnvSchema.safeParse(baseEnv);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ADMIN_DATABASE_URL).toBeUndefined();
        expect(result.data.ADMIN_DB_BREAK_GLASS).toBeUndefined();
      }
    });

    it('given a stray ADMIN_DB_BREAK_GLASS value (e.g. "1"), should still parse — only the exact value "true" arms break-glass downstream', () => {
      const env = {
        ...baseEnv,
        ADMIN_DB_BREAK_GLASS: '1',
      };

      const result = serverEnvSchema.safeParse(env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ADMIN_DB_BREAK_GLASS).toBe('1');
      }
    });

    it('given ADMIN_DATABASE_SSL=true or false, should parse successfully', () => {
      for (const value of ['true', 'false']) {
        const result = serverEnvSchema.safeParse({
          ...baseEnv,
          ADMIN_DATABASE_SSL: value,
        });

        expect(result.success).toBe(true);
      }
    });

    it('given an invalid ADMIN_DATABASE_SSL value, should fail validation', () => {
      const result = serverEnvSchema.safeParse({
        ...baseEnv,
        ADMIN_DATABASE_SSL: 'maybe',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) => i.path.includes('ADMIN_DATABASE_SSL')),
        ).toBe(true);
      }
    });

    it('given a numeric ADMIN_DB_POOL_MAX, should coerce it to a positive integer', () => {
      const result = serverEnvSchema.safeParse({
        ...baseEnv,
        ADMIN_DB_POOL_MAX: '10',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ADMIN_DB_POOL_MAX).toBe(10);
      }
    });

    it('given a non-numeric or non-positive ADMIN_DB_POOL_MAX, should fail validation', () => {
      for (const value of ['abc', '0', '-5', '2.5']) {
        const result = serverEnvSchema.safeParse({
          ...baseEnv,
          ADMIN_DB_POOL_MAX: value,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(
            result.error.issues.some((i) => i.path.includes('ADMIN_DB_POOL_MAX')),
          ).toBe(true);
        }
      }
    });

    it('given ADMIN_DB_POOL_MAX unset, should parse with it undefined', () => {
      const result = serverEnvSchema.safeParse(baseEnv);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ADMIN_DB_POOL_MAX).toBeUndefined();
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

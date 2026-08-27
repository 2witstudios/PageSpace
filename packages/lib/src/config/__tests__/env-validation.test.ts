import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateEnv,
  getEnvErrors,
  isEnvValid,
  serverEnvSchema,
  requireSentryDsn,
} from '../env-validation';

vi.mock('../../deployment-mode', () => ({
  isOnPrem: vi.fn(() => false),
}));

import { isOnPrem } from '../../deployment-mode';

describe('env-validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    // Reset to minimal deterministic env to avoid host pollution
    process.env = { NODE_ENV: 'test' };
    vi.mocked(isOnPrem).mockReturnValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.mocked(isOnPrem).mockReset();
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
        SENTRY_DSN: 'https://abc123@o0.ingest.sentry.io/0',
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

  describe('SENTRY_DSN fail-loud validation (onprem-exempt)', () => {
    const prodEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      CSRF_SECRET: 'b'.repeat(32),
      ENCRYPTION_KEY: 'c'.repeat(32),
    };

    it('given NODE_ENV=production, cloud/tenant (isOnPrem false), and SENTRY_DSN unset, should fail validation', () => {
      vi.mocked(isOnPrem).mockReturnValue(false);

      const result = serverEnvSchema.safeParse(prodEnv);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('SENTRY_DSN'))).toBe(true);
      }
    });

    it('given NODE_ENV=production and SENTRY_DSN set, should parse successfully', () => {
      vi.mocked(isOnPrem).mockReturnValue(false);

      const result = serverEnvSchema.safeParse({
        ...prodEnv,
        SENTRY_DSN: 'https://abc123@o0.ingest.sentry.io/0',
      });

      expect(result.success).toBe(true);
    });

    it('given NODE_ENV=production and isOnPrem() true, should parse successfully even with SENTRY_DSN unset (onprem exempt)', () => {
      vi.mocked(isOnPrem).mockReturnValue(true);

      const result = serverEnvSchema.safeParse(prodEnv);

      expect(result.success).toBe(true);
    });

    it('given NODE_ENV=development and SENTRY_DSN unset, should parse successfully (only production is fail-loud)', () => {
      vi.mocked(isOnPrem).mockReturnValue(false);

      const result = serverEnvSchema.safeParse({
        ...prodEnv,
        NODE_ENV: 'development',
      });

      expect(result.success).toBe(true);
    });

    it('given NODE_ENV=test and SENTRY_DSN unset, should parse successfully', () => {
      vi.mocked(isOnPrem).mockReturnValue(false);

      const result = serverEnvSchema.safeParse({
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        NODE_ENV: 'test',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('requireSentryDsn', () => {
    it('given NODE_ENV=production, isOnPrem() false, and SENTRY_DSN unset, should throw naming the service', () => {
      vi.mocked(isOnPrem).mockReturnValue(false);
      process.env = { NODE_ENV: 'production' };

      expect(() => requireSentryDsn('realtime')).toThrow(/realtime/);
      expect(() => requireSentryDsn('realtime')).toThrow(/SENTRY_DSN/);
    });

    it('given NODE_ENV=production, isOnPrem() false, and SENTRY_DSN set, should not throw', () => {
      vi.mocked(isOnPrem).mockReturnValue(false);
      process.env = { NODE_ENV: 'production', SENTRY_DSN: 'https://abc123@o0.ingest.sentry.io/0' };

      expect(() => requireSentryDsn('processor')).not.toThrow();
    });

    it('given NODE_ENV=production and isOnPrem() true, should not throw even with SENTRY_DSN unset', () => {
      vi.mocked(isOnPrem).mockReturnValue(true);
      process.env = { NODE_ENV: 'production' };

      expect(() => requireSentryDsn('admin')).not.toThrow();
    });

    it('given NODE_ENV=development and SENTRY_DSN unset, should not throw', () => {
      vi.mocked(isOnPrem).mockReturnValue(false);
      process.env = { NODE_ENV: 'development' };

      expect(() => requireSentryDsn('control-plane')).not.toThrow();
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

    it('given an empty-string ADMIN_DATABASE_URL, should PARSE (empty is treated as unset — must not crash boot)', () => {
      // #890 prod audit-write incident: instrumentation.ts calls validateEnv()
      // at boot. Rejecting '' here would exit the process BEFORE
      // resolveAdminDbMode (which maps '' → unset → the silent 'main-db'
      // default) ever runs — defeating the incident fix for the common
      // `ADMIN_DATABASE_URL=` blank-value form.
      const env = {
        ...baseEnv,
        ADMIN_DATABASE_URL: '',
      };

      const result = serverEnvSchema.safeParse(env);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ADMIN_DATABASE_URL).toBe('');
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

    it('given an empty-string ADMIN_ERASER_DATABASE_URL, should PARSE (empty is treated as unset — mirrors ADMIN_DATABASE_URL, must not crash boot)', () => {
      const result = serverEnvSchema.safeParse({
        ...baseEnv,
        ADMIN_ERASER_DATABASE_URL: '',
      });
      expect(result.success).toBe(true);
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

    it('given a blank ADMIN_DATABASE_URL and no flags, validateEnv should PASS at boot (the #890 incident-fix boot gate)', () => {
      // The boot half of the incident fix: validateEnv() (called from
      // apps/web/src/instrumentation.ts) must NOT throw for the common
      // `ADMIN_DATABASE_URL=` blank form — otherwise the process exits before
      // resolveAdminDbMode ever runs. The runtime half (blank '' → the silent
      // 'main-db' default) is pinned in packages/db's admin-db-mode.test.ts
      // ("given an empty-string URL and no flag, should resolve main-db"); it
      // is NOT re-imported here on purpose — pulling in @pagespace/db/admin-db
      // would construct its module-level DATABASE_URL pool against this test's
      // placeholder connection string and poison sibling integration tests.
      process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
      process.env.CSRF_SECRET = 'b'.repeat(32);
      process.env.ENCRYPTION_KEY = 'c'.repeat(32);
      process.env.ADMIN_DATABASE_URL = '';

      expect(() => validateEnv()).not.toThrow();
    });
  });

  describe('app hosting — the apex and the proxy secret are gated at boot', () => {
    const bootable = () => {
      process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
      process.env.CSRF_SECRET = 'b'.repeat(32);
      process.env.ENCRYPTION_KEY = 'c'.repeat(32);
    };

    // The apex carries customer-authored SERVER code on its subdomains, so it
    // must be on the PSL before it does — a prerequisite no code can check.
    // What code CAN do is refuse to let a deployment inherit the apex silently:
    // validateEnv() runs from instrumentation.ts and throws, so enabling hosting
    // without naming the apex stops the process rather than serving on a default.
    it('given APP_HOSTING_ENABLED=true and no PUBLISHED_APPS_APEX, should refuse to boot', () => {
      bootable();
      process.env.APP_HOSTING_ENABLED = 'true';

      expect(() => validateEnv()).toThrow(/PUBLISHED_APPS_APEX must be set explicitly/);
    });

    it.each([
      ['blank', ''],
      ['whitespace only', '   '],
    ])('given APP_HOSTING_ENABLED=true and a %s apex, should refuse to boot', (_label, value) => {
      bootable();
      process.env.APP_HOSTING_ENABLED = 'true';
      process.env.PUBLISHED_APPS_APEX = value;

      expect(() => validateEnv()).toThrow(/PUBLISHED_APPS_APEX must be set explicitly/);
    });

    it('given APP_HOSTING_ENABLED=true and an explicit apex, should boot', () => {
      bootable();
      process.env.APP_HOSTING_ENABLED = 'true';
      process.env.PUBLISHED_APPS_APEX = 'pagespace.app';

      expect(() => validateEnv()).not.toThrow();
    });

    it('given a MALFORMED runtime knob, should still boot — the resolvers fall back, app-wide validation does not', () => {
      // Declared as plain strings rather than coerced numbers on purpose. These
      // three knobs bound machine lifetime and per-app daily spend, and their
      // resolvers take the documented default for anything that is not a
      // non-negative integer — a typo must not switch off the reaper (leaving the
      // fleet awake) or the cap, and it must not take the whole process down
      // either, on a feature that is dark by default.
      bootable();
      process.env.APP_HOSTING_ENABLED = 'true';
      process.env.PUBLISHED_APPS_APEX = 'pagespace.app';
      process.env.PUBLISHED_APP_IDLE_STOP_SECONDS = '15m';
      process.env.PUBLISHED_APP_HIT_STAMP_INTERVAL_SECONDS = 'sixty';
      process.env.PUBLISHED_APP_DAILY_AWAKE_SECONDS_CAP = '-1';

      expect(() => validateEnv()).not.toThrow();
    });

    // The gate is on ENABLING hosting, not on the variable: while hosting is
    // dark the apex is unused, and requiring it would fail every deployment
    // that has never heard of app hosting.
    it.each([
      ['unset', undefined],
      ['not exactly "true"', '1'],
    ])('given APP_HOSTING_ENABLED is %s, should boot without an apex', (_label, value) => {
      bootable();
      if (value === undefined) delete process.env.APP_HOSTING_ENABLED;
      else process.env.APP_HOSTING_ENABLED = value;
      delete process.env.PUBLISHED_APPS_APEX;

      expect(() => validateEnv()).not.toThrow();
    });

    // A guessable proxy secret leaves the router endpoint a world-callable
    // fly-replay emitter, so it is rejected rather than accepted-but-weak. The
    // blank form still passes: that is read as "refuse everything", not "no check".
    it('given a configured APP_ROUTER_PROXY_SECRET below 32 chars, should refuse to boot', () => {
      bootable();
      process.env.APP_ROUTER_PROXY_SECRET = 'a';

      expect(() => validateEnv()).toThrow(/APP_ROUTER_PROXY_SECRET/);
    });

    it('given a blank APP_ROUTER_PROXY_SECRET, should boot — the router reads it as refuse-everything', () => {
      bootable();
      process.env.APP_ROUTER_PROXY_SECRET = '';

      expect(() => validateEnv()).not.toThrow();
    });

    it('given a 32-char APP_ROUTER_PROXY_SECRET, should boot', () => {
      bootable();
      process.env.APP_ROUTER_PROXY_SECRET = 'p'.repeat(32);

      expect(() => validateEnv()).not.toThrow();
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

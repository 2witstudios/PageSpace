/**
 * Pure-core tests for the Admin PG (trust plane) connection registry decision
 * logic (#890). The FIVE-state contract (post prod audit-write incident):
 *
 *   URL set + VALID postgres URL                    → 'dedicated'
 *   URL set + INVALID URL                           → 'fail'   (positive misconfig)
 *   URL unset + AUDIT_TRUST_PLANE_REQUIRED='true'   → 'fail'   (declared, not configured)
 *   URL unset + ADMIN_DB_BREAK_GLASS='true'         → 'break-glass' (main DB + LOUD alert)
 *   URL unset + neither flag                        → 'main-db' (NEW DEFAULT: main DB, SILENT)
 *
 * Precedence when several apply:
 *   invalid-URL fail > TRUST_PLANE_REQUIRED fail > break-glass > main-db.
 *
 * The 'main-db' default is the incident fix: before this, an unconfigured
 * ADMIN_DATABASE_URL resolved to 'fail', so every prod audit write threw and
 * was swallowed by the fire-and-forget audit() wrapper — security audit
 * logging was silently broken. Unconfigured now means silent, pre-epic
 * main-DB behavior; loud failure is opt-in via AUDIT_TRUST_PLANE_REQUIRED.
 *
 * Both flags are fail-closed: only the exact string 'true' arms them
 * ('TRUE', '1', ' true ', '' do not).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveAdminDbMode,
  resolveAdminPoolConfig,
} from '../admin-db-mode';

describe('resolveAdminDbMode', () => {
  describe('dedicated mode', () => {
    it('given ADMIN_DATABASE_URL set (postgresql://), should resolve dedicated', () => {
      const decision = resolveAdminDbMode({
        ADMIN_DATABASE_URL: 'postgresql://admin:pw@host:5432/pagespace_admin',
      });
      expect(decision.mode).toBe('dedicated');
    });

    it('given ADMIN_DATABASE_URL set (postgres://), should resolve dedicated', () => {
      const decision = resolveAdminDbMode({
        ADMIN_DATABASE_URL: 'postgres://admin:pw@host:5432/pagespace_admin',
      });
      expect(decision.mode).toBe('dedicated');
    });

    it('given ADMIN_DATABASE_URL set AND break-glass armed, should still resolve dedicated (URL wins)', () => {
      const decision = resolveAdminDbMode({
        ADMIN_DATABASE_URL: 'postgresql://admin:pw@host:5432/pagespace_admin',
        ADMIN_DB_BREAK_GLASS: 'true',
      });
      expect(decision.mode).toBe('dedicated');
    });

    it('given ADMIN_DATABASE_URL set AND AUDIT_TRUST_PLANE_REQUIRED armed, should resolve dedicated (the trust plane IS configured)', () => {
      const decision = resolveAdminDbMode({
        ADMIN_DATABASE_URL: 'postgresql://admin:pw@host:5432/pagespace_admin',
        AUDIT_TRUST_PLANE_REQUIRED: 'true',
      });
      expect(decision.mode).toBe('dedicated');
    });
  });

  describe('URL validation (validate-on-init)', () => {
    it('given a non-postgres scheme, should fail with a reason naming ADMIN_DATABASE_URL', () => {
      const decision = resolveAdminDbMode({
        ADMIN_DATABASE_URL: 'mysql://admin:pw@host:3306/admin',
      });
      expect(decision.mode).toBe('fail');
      expect(decision.reason).toContain('ADMIN_DATABASE_URL');
    });

    it('given an http:// URL, should fail even when break-glass is armed (invalid config is never silently degraded)', () => {
      const decision = resolveAdminDbMode({
        ADMIN_DATABASE_URL: 'http://host/db',
        ADMIN_DB_BREAK_GLASS: 'true',
      });
      expect(decision.mode).toBe('fail');
    });

    it('given an invalid URL, should fail even when neither flag is set (positive misconfig beats the main-db default)', () => {
      const decision = resolveAdminDbMode({ ADMIN_DATABASE_URL: 'mysql://host/db' });
      expect(decision.mode).toBe('fail');
    });

    it('given an empty-string URL and no flag, should resolve main-db (empty is treated as unset → silent default)', () => {
      const decision = resolveAdminDbMode({ ADMIN_DATABASE_URL: '' });
      expect(decision.mode).toBe('main-db');
    });

    it('given an empty-string URL and armed break-glass, should resolve break-glass (empty is treated as unset)', () => {
      const decision = resolveAdminDbMode({
        ADMIN_DATABASE_URL: '',
        ADMIN_DB_BREAK_GLASS: 'true',
      });
      expect(decision.mode).toBe('break-glass');
    });
  });

  describe('main-db default (THE incident fix — unconfigured is silent, not fatal)', () => {
    it('given URL unset and no flags, should resolve main-db (pre-epic silent behavior)', () => {
      const decision = resolveAdminDbMode({});
      expect(decision.mode).toBe('main-db');
    });

    it('given main-db, reason should describe the silent unconfigured default without demanding an alert', () => {
      const decision = resolveAdminDbMode({});
      expect(decision.mode).toBe('main-db');
      expect(decision.reason).toContain('ADMIN_DATABASE_URL');
      expect(decision.reason.toLowerCase()).toContain('main');
    });

    it.each(['TRUE', 'True', '1', ' true ', 'yes', 'false', ''])(
      "given URL unset and a non-'true' break-glass value %j, should resolve main-db (flag not armed, silent default)",
      (flag) => {
        const decision = resolveAdminDbMode({ ADMIN_DB_BREAK_GLASS: flag });
        expect(decision.mode).toBe('main-db');
      },
    );

    it.each(['TRUE', '1', ' true ', 'yes', 'false', ''])(
      "given a non-'true' AUDIT_TRUST_PLANE_REQUIRED value %j, should NOT force fail (fail-closed → main-db)",
      (flag) => {
        const decision = resolveAdminDbMode({ AUDIT_TRUST_PLANE_REQUIRED: flag });
        expect(decision.mode).toBe('main-db');
      },
    );
  });

  describe('break-glass arming (fail-closed)', () => {
    it("given URL unset and flag exactly 'true', should resolve break-glass", () => {
      const decision = resolveAdminDbMode({ ADMIN_DB_BREAK_GLASS: 'true' });
      expect(decision.mode).toBe('break-glass');
    });
  });

  describe("AUDIT_TRUST_PLANE_REQUIRED='true' (operator DECLARED enforcement but did not configure)", () => {
    it('given URL unset and required armed, should fail loudly', () => {
      const decision = resolveAdminDbMode({ AUDIT_TRUST_PLANE_REQUIRED: 'true' });
      expect(decision.mode).toBe('fail');
      expect(decision.reason).toContain('AUDIT_TRUST_PLANE_REQUIRED');
      expect(decision.reason).toContain('ADMIN_DATABASE_URL');
    });

    it('given required armed AND break-glass armed (no URL), fail should win — the stricter declared intent is honored', () => {
      const decision = resolveAdminDbMode({
        AUDIT_TRUST_PLANE_REQUIRED: 'true',
        ADMIN_DB_BREAK_GLASS: 'true',
      });
      expect(decision.mode).toBe('fail');
      expect(decision.reason).toContain('AUDIT_TRUST_PLANE_REQUIRED');
    });
  });
});

describe('resolveAdminPoolConfig', () => {
  const URL = 'postgresql://admin:pw@host:5432/pagespace_admin';

  it('given the env URL, should use it as the connection string', () => {
    const config = resolveAdminPoolConfig({ ADMIN_DATABASE_URL: URL });
    expect(config.connectionString).toBe(URL);
  });

  describe('ssl (mirrors db.ts DATABASE_SSL semantics)', () => {
    it("given ADMIN_DATABASE_SSL 'true', should disable certificate verification like the main pool", () => {
      const config = resolveAdminPoolConfig({
        ADMIN_DATABASE_URL: URL,
        ADMIN_DATABASE_SSL: 'true',
      });
      expect(config.ssl).toEqual({ rejectUnauthorized: false });
    });

    it.each(['false', 'TRUE', undefined])(
      'given ADMIN_DATABASE_SSL %j, should disable ssl',
      (ssl) => {
        const config = resolveAdminPoolConfig({
          ADMIN_DATABASE_URL: URL,
          ADMIN_DATABASE_SSL: ssl,
        });
        expect(config.ssl).toBe(false);
      },
    );
  });

  describe('max (ADMIN_DB_POOL_MAX)', () => {
    it('given a positive integer string, should use it', () => {
      const config = resolveAdminPoolConfig({
        ADMIN_DATABASE_URL: URL,
        ADMIN_DB_POOL_MAX: '7',
      });
      expect(config.max).toBe(7);
    });

    it.each([undefined, '', '0', '-3', 'abc'])(
      'given ADMIN_DB_POOL_MAX %j, should fall back to the default of 10',
      (max) => {
        const config = resolveAdminPoolConfig({
          ADMIN_DATABASE_URL: URL,
          ADMIN_DB_POOL_MAX: max,
        });
        expect(config.max).toBe(10);
      },
    );
  });

  it('should mirror the remaining db.ts pool settings (keepAlive + timeouts)', () => {
    const config = resolveAdminPoolConfig({ ADMIN_DATABASE_URL: URL });
    expect(config.keepAlive).toBe(true);
    expect(config.keepAliveInitialDelayMillis).toBe(10000);
    expect(config.idleTimeoutMillis).toBe(600000);
    expect(config.connectionTimeoutMillis).toBe(10000);
  });
});

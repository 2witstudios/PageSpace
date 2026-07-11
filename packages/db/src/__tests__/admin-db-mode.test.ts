/**
 * Pure-core tests for the Admin PG (trust plane) connection registry decision
 * logic (#890 Phase 1). The three-state contract:
 *
 *   ADMIN_DATABASE_URL set               → 'dedicated'  (connect to Admin PG)
 *   URL unset + ADMIN_DB_BREAK_GLASS
 *     exactly 'true'                     → 'break-glass' (degrade to main DB, alert)
 *   URL unset + no armed flag            → 'fail'        (fail-fast at init)
 *
 * Break-glass arming is fail-closed: any value other than the exact string
 * 'true' ('TRUE', '1', ' true ', '') does NOT arm the fallback.
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

    it('given an empty-string URL and no flag, should fail (empty is treated as unset)', () => {
      const decision = resolveAdminDbMode({ ADMIN_DATABASE_URL: '' });
      expect(decision.mode).toBe('fail');
    });

    it('given an empty-string URL and armed break-glass, should resolve break-glass (empty is treated as unset)', () => {
      const decision = resolveAdminDbMode({
        ADMIN_DATABASE_URL: '',
        ADMIN_DB_BREAK_GLASS: 'true',
      });
      expect(decision.mode).toBe('break-glass');
    });
  });

  describe('break-glass arming (fail-closed)', () => {
    it("given URL unset and flag exactly 'true', should resolve break-glass", () => {
      const decision = resolveAdminDbMode({ ADMIN_DB_BREAK_GLASS: 'true' });
      expect(decision.mode).toBe('break-glass');
    });

    it.each(['TRUE', 'True', '1', ' true ', 'yes', 'false', ''])(
      "given URL unset and flag %j, should NOT arm break-glass (fail-closed)",
      (flag) => {
        const decision = resolveAdminDbMode({ ADMIN_DB_BREAK_GLASS: flag });
        expect(decision.mode).toBe('fail');
      },
    );
  });

  describe('fail-fast mode', () => {
    it('given URL unset and no flag, should fail', () => {
      const decision = resolveAdminDbMode({});
      expect(decision.mode).toBe('fail');
    });

    it('given fail, reason should name both ADMIN_DATABASE_URL and ADMIN_DB_BREAK_GLASS so the operator knows both exits', () => {
      const decision = resolveAdminDbMode({});
      expect(decision.mode).toBe('fail');
      expect(decision.reason).toContain('ADMIN_DATABASE_URL');
      expect(decision.reason).toContain('ADMIN_DB_BREAK_GLASS');
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

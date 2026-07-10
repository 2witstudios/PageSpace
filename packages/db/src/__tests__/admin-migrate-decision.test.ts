/**
 * Pure decision tests for db:migrate:admin (#890 Phase 1, leaf 3).
 *
 * Migrations target ONLY a dedicated Admin PG. Break-glass is a runtime
 * degradation for audit WRITES — running admin migrations against the main
 * DB would plant the drizzle_admin journal in the app plane, so the migrate
 * decision refuses everything except 'dedicated'.
 */
import { describe, it, expect } from 'vitest';
import { resolveAdminMigrateDecision } from '../admin-db-mode';

describe('resolveAdminMigrateDecision', () => {
  it('given ADMIN_DATABASE_URL set, should permit migration with the resolved pool config', () => {
    const decision = resolveAdminMigrateDecision({
      ADMIN_DATABASE_URL: 'postgresql://admin:pw@host:5432/pagespace_admin',
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.poolConfig.connectionString).toBe(
        'postgresql://admin:pw@host:5432/pagespace_admin',
      );
    }
  });

  it('given break-glass armed but no URL, should refuse — migrations never run under break-glass', () => {
    const decision = resolveAdminMigrateDecision({ ADMIN_DB_BREAK_GLASS: 'true' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/break-glass/i);
      expect(decision.reason).toMatch(/ADMIN_DATABASE_URL/);
    }
  });

  it('given no URL and no flag, should refuse with the fail-fast reason', () => {
    const decision = resolveAdminMigrateDecision({});
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/ADMIN_DATABASE_URL/);
    }
  });

  it('given an invalid URL scheme, should refuse even with break-glass armed', () => {
    const decision = resolveAdminMigrateDecision({
      ADMIN_DATABASE_URL: 'mysql://root@host:3306/nope',
      ADMIN_DB_BREAK_GLASS: 'true',
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/postgres/);
    }
  });

  // Phase 2 leaf 0 (gate): the runtime ADMIN_DATABASE_URL becomes a
  // least-privilege LOGIN (admin_app etc.), so the migrate/provision path —
  // which needs the OWNER role — takes a dedicated ADMIN_DATABASE_URL_MIGRATE
  // that never reaches any runtime service.
  describe('ADMIN_DATABASE_URL_MIGRATE preference', () => {
    it('given both URLs set, should migrate against the dedicated migrate URL, not the runtime one', () => {
      const decision = resolveAdminMigrateDecision({
        ADMIN_DATABASE_URL: 'postgresql://admin_app_user:app-pw@host:5432/pagespace_admin',
        ADMIN_DATABASE_URL_MIGRATE: 'postgresql://owner:owner-pw@host:5432/pagespace_admin',
      });
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.poolConfig.connectionString).toBe(
          'postgresql://owner:owner-pw@host:5432/pagespace_admin',
        );
      }
    });

    it('given only ADMIN_DATABASE_URL_MIGRATE set, should migrate against it', () => {
      const decision = resolveAdminMigrateDecision({
        ADMIN_DATABASE_URL_MIGRATE: 'postgresql://owner:owner-pw@host:5432/pagespace_admin',
      });
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.poolConfig.connectionString).toBe(
          'postgresql://owner:owner-pw@host:5432/pagespace_admin',
        );
      }
    });

    it('given an empty-string migrate URL, should fall back to ADMIN_DATABASE_URL (compose path unchanged)', () => {
      const decision = resolveAdminMigrateDecision({
        ADMIN_DATABASE_URL: 'postgresql://owner:owner-pw@postgres-admin:5432/pagespace_admin',
        ADMIN_DATABASE_URL_MIGRATE: '',
      });
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.poolConfig.connectionString).toBe(
          'postgresql://owner:owner-pw@postgres-admin:5432/pagespace_admin',
        );
      }
    });

    it('given an invalid migrate URL scheme, should refuse rather than silently fall back to the runtime URL', () => {
      const decision = resolveAdminMigrateDecision({
        ADMIN_DATABASE_URL: 'postgresql://admin_app_user:app-pw@host:5432/pagespace_admin',
        ADMIN_DATABASE_URL_MIGRATE: 'mysql://root@host:3306/nope',
      });
      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.reason).toMatch(/postgres/);
      }
    });
  });
});

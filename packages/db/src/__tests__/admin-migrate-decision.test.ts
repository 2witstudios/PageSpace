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
});

/**
 * Migration smoke test for the Admin PG pipeline (#890 Phase 1, leaf 3).
 *
 * Acceptance: given a fresh empty Postgres and ADMIN_DATABASE_URL pointing at
 * it, `db:migrate:admin` ALONE reaches the full admin schema, with a journal
 * fully separate from the main DB's.
 *
 * Requires a running scratch Postgres (never the app DB):
 *   docker run --rm -d --name pagespace-admin-smoke -p 55432:5432 \
 *     -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e POSTGRES_DB=pagespace_admin postgres:16
 *   ADMIN_DATABASE_URL=postgresql://admin:admin@localhost:55432/pagespace_admin \
 *     bunx vitest run --config vitest.integration.config.ts src/__tests__/admin-migrate.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { migrateAdminDb } from '../migrate-admin';

const url = process.env.ADMIN_DATABASE_URL;

describe.skipIf(!url)('db:migrate:admin against a scratch Admin PG', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 });
    // Fresh-DB guarantee: reset public + journal schemas on the SCRATCH db.
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle_admin CASCADE');
    await pool.query('CREATE SCHEMA public');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('should reach the full admin schema from a fresh empty database in one run', async () => {
    await migrateAdminDb({ ADMIN_DATABASE_URL: url });

    // Logical tables only — since leaf 6 the chain tables are partitioned
    // parents whose monthly partitions would also show up in
    // information_schema.tables, so filter on relispartition.
    const { rows } = await pool.query(
      `SELECT c.relname AS table_name FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       ORDER BY c.relname`,
    );
    expect(rows.map((r: { table_name: string }) => r.table_name)).toEqual([
      'security_audit_anchors',
      'security_audit_ingest',
      'security_audit_log',
      'siem_delivery_cursors',
      'siem_delivery_receipts',
    ]);
  });

  it('should create security_audit_log with NO foreign keys (no users table in the trust plane)', async () => {
    const { rows } = await pool.query(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = 'public' AND table_name = 'security_audit_log'
         AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('should not create any app-plane table (users stays in the main DB)', async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'users'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('should keep its journal in drizzle_admin, never in the main drizzle schema', async () => {
    const journal = await pool.query(
      `SELECT count(*)::int AS applied FROM drizzle_admin.__drizzle_migrations`,
    );
    expect(journal.rows[0].applied).toBeGreaterThanOrEqual(1);

    const mainJournal = await pool.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'drizzle'`,
    );
    expect(mainJournal.rows).toHaveLength(0);
  });

  it('should create the securityAuditLog indexes', async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'security_audit_log'`,
    );
    const names = rows.map((r: { indexname: string }) => r.indexname);
    expect(names).toContain('idx_security_audit_chain_seq');
    expect(names).toContain('idx_security_audit_event_hash');
  });

  it('should be idempotent — a second run applies nothing new', async () => {
    const before = await pool.query(
      `SELECT count(*)::int AS applied FROM drizzle_admin.__drizzle_migrations`,
    );
    await migrateAdminDb({ ADMIN_DATABASE_URL: url });
    const after = await pool.query(
      `SELECT count(*)::int AS applied FROM drizzle_admin.__drizzle_migrations`,
    );
    expect(after.rows[0].applied).toBe(before.rows[0].applied);
  });
});

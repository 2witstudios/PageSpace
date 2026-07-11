/**
 * Static invariants of the monthly-partitioning migration (#890 Phase 1, leaf 6).
 *
 * The live behavior (routing, EXPLAIN plans, real 42501 denials) is proven by
 * admin-partition.integration.test.ts and admin-grants.integration.test.ts
 * against a scratch Postgres. These tests pin the migration SQL itself so CI
 * catches a regressed invariant (a drop path sneaking into the maintenance
 * function, a lost grant, a partition key dropped from a PK, …) without
 * needing a database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const ADMIN_MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle-admin');

const migrationFile = readdirSync(ADMIN_MIGRATIONS_DIR).find((f) =>
  /^0002_.*\.sql$/.test(f),
);
const sql = migrationFile
  ? readFileSync(path.join(ADMIN_MIGRATIONS_DIR, migrationFile), 'utf8')
  : '';
/** SQL with line comments stripped, so assertions never match prose. */
function stripComments(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}
const code = stripComments(sql);

describe('drizzle-admin/0002 monthly-partitioning migration', () => {
  it('should exist in the admin journal as migration 0002', () => {
    expect(migrationFile).toBe('0002_partition_chain_tables.sql');
    const journal = JSON.parse(
      readFileSync(path.join(ADMIN_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === 2)?.tag).toBe('0002_partition_chain_tables');
  });

  it('should re-create security_audit_log as monthly RANGE-partitioned on timestamp with a composite PK', () => {
    expect(code).toMatch(
      /CREATE TABLE "security_audit_log" \([\s\S]+?\) PARTITION BY RANGE \("timestamp"\)/,
    );
    expect(code).toContain(
      'CONSTRAINT "security_audit_log_pkey" PRIMARY KEY ("id", "timestamp")',
    );
  });

  it('should re-create siem_delivery_receipts as monthly RANGE-partitioned on deliveredAt with a composite PK', () => {
    expect(code).toMatch(
      /CREATE TABLE "siem_delivery_receipts" \([\s\S]+?\) PARTITION BY RANGE \("deliveredAt"\)/,
    );
    expect(code).toContain(
      'CONSTRAINT "siem_delivery_receipts_pkey" PRIMARY KEY ("receiptId", "deliveredAt")',
    );
  });

  it('should never touch siem_delivery_cursors (tiny, upserted — stays plain)', () => {
    const statements = code.split(';');
    for (const stmt of statements) {
      if (/^\s*(CREATE|ALTER|DROP)\b/.test(stmt)) {
        expect(stmt).not.toContain('siem_delivery_cursors');
      }
    }
  });

  it('should preserve the chain_seq sequence across the re-create (values continue, grants survive)', () => {
    // Detached before the old table is dropped, reused as the new default,
    // re-owned by the new column — the sequence OBJECT survives.
    expect(code).toContain('ALTER SEQUENCE "security_audit_log_chain_seq_seq" OWNED BY NONE');
    expect(code).toContain(`DEFAULT nextval('security_audit_log_chain_seq_seq')`);
    expect(code).toContain(
      'ALTER SEQUENCE "security_audit_log_chain_seq_seq" OWNED BY "security_audit_log"."chain_seq"',
    );
  });

  it('should copy existing rows into the partitioned tables before dropping the old ones', () => {
    expect(code).toMatch(
      /INSERT INTO "security_audit_log" \([\s\S]+?\)\s*SELECT[\s\S]+?FROM "security_audit_log_unpartitioned"/,
    );
    expect(code).toMatch(
      /INSERT INTO "siem_delivery_receipts" \([\s\S]+?\)\s*SELECT[\s\S]+?FROM "siem_delivery_receipts_unpartitioned"/,
    );
  });

  it('should contain NO drop statement except swapping out the two copied unpartitioned tables', () => {
    const drops = code.match(/\bDROP\s+\w+[^;]*/g) ?? [];
    expect(drops).toHaveLength(2);
    for (const drop of drops) {
      expect(drop).toMatch(/^DROP TABLE "(security_audit_log|siem_delivery_receipts)_unpartitioned"/);
    }
  });

  it('should re-create every security_audit_log index on the partitioned parent', () => {
    const indexes = [
      'idx_security_audit_timestamp',
      'idx_security_audit_user_timestamp',
      'idx_security_audit_event_type',
      'idx_security_audit_resource',
      'idx_security_audit_ip',
      'idx_security_audit_ip_bidx',
      'idx_security_audit_event_hash',
      'idx_security_audit_chain_seq',
      'idx_security_audit_risk_score',
      'idx_security_audit_session',
    ];
    for (const name of indexes) {
      expect(code).toContain(`CREATE INDEX "${name}" ON "security_audit_log"`);
    }
  });

  it('should re-create every siem_delivery_receipts index, widening the unique key by the partition key', () => {
    // Partitioned unique indexes MUST include the partition key; the dup guard
    // weakens from (deliveryId, source) to (deliveryId, source, deliveredAt) —
    // acceptable: the writer (siem-receipt-writer.ts) never relies on
    // ON CONFLICT, deliveryIds are minted per delivery attempt.
    expect(code).toContain(
      'CREATE UNIQUE INDEX "siem_delivery_receipts_delivery_source_unique" ON "siem_delivery_receipts" USING btree ("deliveryId","source","deliveredAt")',
    );
    for (const name of [
      'idx_siem_receipts_delivery_id',
      'idx_siem_receipts_first_entry',
      'idx_siem_receipts_last_entry',
      'idx_siem_receipts_delivered_at',
      'idx_siem_receipts_source_range',
    ]) {
      expect(code).toContain(`CREATE INDEX "${name}" ON "siem_delivery_receipts"`);
    }
  });

  it('should create the admin_maintenance role guarded and NOLOGIN', () => {
    expect(code).toContain(
      `IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin_maintenance')`,
    );
    expect(code).toContain('CREATE ROLE admin_maintenance NOLOGIN');
  });

  it('should define the create-ahead function as SECURITY DEFINER with a pinned search_path', () => {
    expect(code).toContain('CREATE OR REPLACE FUNCTION admin_ensure_partitions(months_ahead integer DEFAULT 3)');
    expect(code).toContain('SECURITY DEFINER');
    expect(code).toContain('SET search_path = public, pg_temp');
    // Safety net: a DEFAULT partition catches anything outside created ranges.
    expect(code).toContain('PARTITION OF %I DEFAULT');
  });

  it('should grant EXECUTE on the maintenance function to admin_maintenance ONLY', () => {
    expect(code).toContain(
      'REVOKE ALL ON FUNCTION admin_ensure_partitions(integer) FROM PUBLIC',
    );
    expect(code).toContain(
      'GRANT EXECUTE ON FUNCTION admin_ensure_partitions(integer) TO admin_maintenance',
    );
    // admin_maintenance holds schema USAGE (name resolution only) plus the
    // function, and NOTHING else — it must never gain table privileges.
    const maintenanceGrants = (code.match(/GRANT[^;]+;/g) ?? []).filter((g) =>
      g.includes('admin_maintenance'),
    );
    expect(maintenanceGrants).toHaveLength(2);
    expect(maintenanceGrants.some((g) => g.includes('USAGE ON SCHEMA public'))).toBe(true);
    expect(maintenanceGrants.some((g) => g.includes('EXECUTE ON FUNCTION'))).toBe(true);
  });

  it('should seed initial partitions from the migration itself (current + 3 months ahead)', () => {
    expect(code).toContain('SELECT admin_ensure_partitions(3)');
  });

  it('should re-apply the full leaf-4 grant matrix on the re-created parents', () => {
    // Table grants die with DROP TABLE; grants on the partitioned parent
    // cascade to partitions, so one re-apply per parent suffices.
    const expected = [
      'REVOKE ALL ON security_audit_log, siem_delivery_receipts FROM PUBLIC;',
      'GRANT SELECT, INSERT ON security_audit_log TO admin_app;',
      'GRANT SELECT, INSERT ON security_audit_log TO admin_chainer;',
      'GRANT USAGE ON SEQUENCE security_audit_log_chain_seq_seq TO admin_app, admin_chainer;',
      'GRANT SELECT ON security_audit_log TO admin_gdpr_eraser;',
      'GRANT UPDATE (user_id, session_id, ip_address, ip_bidx, user_agent, geo_location) ON security_audit_log TO admin_gdpr_eraser;',
      'GRANT SELECT ON security_audit_log, siem_delivery_receipts TO admin_reader;',
      'GRANT SELECT ON security_audit_log, siem_delivery_receipts TO admin_siem;',
      'GRANT INSERT ON siem_delivery_receipts TO admin_siem;',
    ];
    for (const grant of expected) {
      expect(code).toContain(grant);
    }
  });

  it('should grant DELETE and TRUNCATE to nobody, and never GRANT ALL on a table', () => {
    const grants = code.match(/GRANT[^;]+;/g) ?? [];
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant).not.toMatch(/\bDELETE\b/);
      expect(grant).not.toMatch(/\bTRUNCATE\b/);
      expect(grant).not.toMatch(/\bGRANT\s+ALL\b/);
    }
  });
});

describe('drizzle-admin/0003 per-month exception hardening of admin_ensure_partitions', () => {
  // REVIEW 2026-07-10 MINOR: one poisoned month (rows for month M sitting in
  // the DEFAULT partition) aborted the ENTIRE create-ahead call, rolling back
  // every other month — after a long cron outage this self-perpetuates. 0003
  // replaces the function so each partition CREATE is its own plpgsql
  // exception scope: a poisoned month fails ALONE and is reported via
  // WARNING; every other month is still created.
  const hardeningFile = readdirSync(ADMIN_MIGRATIONS_DIR).find((f) =>
    /^0003_.*\.sql$/.test(f),
  );
  const hardeningCode = stripComments(
    hardeningFile ? readFileSync(path.join(ADMIN_MIGRATIONS_DIR, hardeningFile), 'utf8') : '',
  );

  it('should exist in the admin journal as migration 0003 (never edit an applied migration)', () => {
    expect(hardeningFile).toBeDefined();
    const journal = JSON.parse(
      readFileSync(path.join(ADMIN_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(`${journal.entries.find((e) => e.idx === 3)?.tag}.sql`).toBe(hardeningFile);
  });

  it('should CREATE OR REPLACE the function with the same signature, SECURITY DEFINER, and pinned search_path', () => {
    expect(hardeningCode).toContain(
      'CREATE OR REPLACE FUNCTION admin_ensure_partitions(months_ahead integer DEFAULT 3)',
    );
    expect(hardeningCode).toContain('RETURNS integer');
    expect(hardeningCode).toContain('SECURITY DEFINER');
    expect(hardeningCode).toContain('SET search_path = public, pg_temp');
  });

  it('should wrap each partition CREATE in its own exception scope so one poisoned month fails alone', () => {
    // One handler for the DEFAULT safety net, one inside the month loop.
    const handlers = hardeningCode.match(/EXCEPTION WHEN OTHERS THEN/g) ?? [];
    expect(handlers.length).toBeGreaterThanOrEqual(2);
  });

  it('should report every failed partition by name via WARNING (visible to the cron log)', () => {
    const warnings = hardeningCode.match(/RAISE WARNING[^;]+;/g) ?? [];
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.includes('part_name') || w.includes('failed'))).toBe(true);
  });

  it('should keep the horizon guard and still return the created count', () => {
    expect(hardeningCode).toContain('months_ahead < 0 OR months_ahead > 120');
    expect(hardeningCode).toContain('RETURN created');
  });

  it('should contain NO drop path and NO grant changes (CREATE OR REPLACE preserves the 0002 ACL)', () => {
    expect(hardeningCode).not.toMatch(/\bDROP\b/);
    expect(hardeningCode).not.toMatch(/\bGRANT\b/);
    expect(hardeningCode).not.toMatch(/\bREVOKE\b/);
  });
});

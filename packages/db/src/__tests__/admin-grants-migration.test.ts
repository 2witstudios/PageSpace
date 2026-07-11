/**
 * Static invariants of the zero-trust grants migration (#890 Phase 1, leaf 4).
 *
 * The live behavior (actual 42501 denials per role) is proven by
 * admin-grants.integration.test.ts against a scratch Postgres. These tests
 * pin the migration SQL itself so CI catches a regressed grant matrix
 * (someone adding a DELETE grant, widening the eraser's column list, …)
 * without needing a database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const ADMIN_MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle-admin');

const migrationFile = readdirSync(ADMIN_MIGRATIONS_DIR).find((f) =>
  /^0001_.*\.sql$/.test(f),
);
const sql = readFileSync(path.join(ADMIN_MIGRATIONS_DIR, migrationFile ?? ''), 'utf8');
/** SQL with line comments stripped, so assertions never match prose. */
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

const ROLES = ['admin_app', 'admin_chainer', 'admin_gdpr_eraser', 'admin_reader', 'admin_siem'];

describe('drizzle-admin/0001 zero-trust grants migration', () => {
  it('should exist in the admin journal as migration 0001', () => {
    expect(migrationFile).toBe('0001_zero_trust_roles.sql');
    const journal = JSON.parse(
      readFileSync(path.join(ADMIN_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === 1)?.tag).toBe('0001_zero_trust_roles');
  });

  it('should create every role guarded (pre-existing roles survive a re-run) and NOLOGIN', () => {
    for (const role of ROLES) {
      expect(code).toContain(`IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}')`);
      expect(code).toContain(`CREATE ROLE ${role} NOLOGIN`);
    }
  });

  it('should grant DELETE and TRUNCATE to nobody, and never GRANT ALL', () => {
    const grants = code.match(/GRANT[^;]+;/g) ?? [];
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant).not.toMatch(/\bDELETE\b/);
      expect(grant).not.toMatch(/\bTRUNCATE\b/);
      expect(grant).not.toMatch(/\bGRANT\s+ALL\b/);
    }
  });

  it('should scope the eraser UPDATE to exactly the six hash-excluded PII columns', () => {
    const eraserUpdate = code.match(/GRANT UPDATE \(([^)]*)\) ON security_audit_log TO admin_gdpr_eraser/);
    expect(eraserUpdate).not.toBeNull();
    expect(eraserUpdate![1].split(',').map((c) => c.trim()).sort()).toEqual(
      ['geo_location', 'ip_address', 'ip_bidx', 'session_id', 'user_agent', 'user_id'].sort(),
    );
    // ...and the eraser holds nothing beyond schema USAGE, SELECT, and that
    // column-scoped UPDATE.
    const eraserGrants = (code.match(/GRANT[^;]+;/g) ?? []).filter((g) =>
      g.includes('admin_gdpr_eraser'),
    );
    expect(eraserGrants).toHaveLength(3);
    expect(eraserGrants.some((g) => g.includes('USAGE ON SCHEMA public'))).toBe(true);
    expect(eraserGrants.some((g) => /^GRANT SELECT ON security_audit_log TO admin_gdpr_eraser/.test(g))).toBe(true);
  });

  it('should revoke every ambient PUBLIC privilege on the trust-plane tables', () => {
    expect(code).toContain(
      'REVOKE ALL ON security_audit_log, siem_delivery_cursors, siem_delivery_receipts FROM PUBLIC',
    );
  });

  it('should grant the chain_seq sequence only to the two inserting identities', () => {
    expect(code).toContain(
      'GRANT USAGE ON SEQUENCE security_audit_log_chain_seq_seq TO admin_app, admin_chainer',
    );
    const sequenceGrants = code.match(/GRANT[^;]+ON SEQUENCE[^;]+;/g) ?? [];
    expect(sequenceGrants).toHaveLength(1);
  });
});

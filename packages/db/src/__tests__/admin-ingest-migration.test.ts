/**
 * Static invariants of the ingest-table migration (#890 Phase 2, leaf 1).
 *
 * The live behavior (actual 42501 denials per role) is proven by
 * admin-grants.integration.test.ts against a scratch Postgres. These tests
 * pin the migration SQL itself so CI catches a regressed grant matrix
 * (someone adding admin_app SELECT, widening the chainer's DELETE beyond
 * the queue, …) without needing a database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const ADMIN_MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle-admin');

const migrationFile = readdirSync(ADMIN_MIGRATIONS_DIR).find((f) =>
  /^0004_.*\.sql$/.test(f),
);
const sql = readFileSync(path.join(ADMIN_MIGRATIONS_DIR, migrationFile ?? ''), 'utf8');
/** SQL with line comments stripped, so assertions never match prose. */
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('drizzle-admin/0004 security_audit_ingest migration', () => {
  it('should exist in the admin journal as migration 0004', () => {
    expect(migrationFile).toBe('0004_security_audit_ingest.sql');
    const journal = JSON.parse(
      readFileSync(path.join(ADMIN_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === 4)?.tag).toBe('0004_security_audit_ingest');
  });

  it('should create a PLAIN table (transient queue — no PARTITION BY) with emission_hash and emitted_at NOT NULL', () => {
    expect(code).toContain('CREATE TABLE IF NOT EXISTS "security_audit_ingest"');
    expect(code).not.toContain('PARTITION BY');
    expect(code).toContain('"emission_hash" text NOT NULL');
    expect(code).toContain('"emitted_at" timestamp with time zone DEFAULT now() NOT NULL');
  });

  it('should carry no chain columns — chain_seq/previous_hash/event_hash belong to security_audit_log only', () => {
    for (const chainColumn of ['chain_seq', 'previous_hash', 'event_hash']) {
      expect(code).not.toContain(chainColumn);
    }
  });

  it('should index (emitted_at, id) for the FIFO drain', () => {
    expect(code).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_security_audit_ingest_drain" ON "security_audit_ingest" USING btree ("emitted_at","id")',
    );
  });

  it('should revoke every ambient PUBLIC privilege on the ingest table', () => {
    expect(code).toContain('REVOKE ALL ON security_audit_ingest FROM PUBLIC');
  });

  it('should grant admin_app INSERT and nothing else (fire-and-forget: not even SELECT)', () => {
    const appGrants = (code.match(/GRANT[^;]+;/g) ?? []).filter((g) => g.includes('admin_app'));
    expect(appGrants).toEqual(['GRANT INSERT ON security_audit_ingest TO admin_app;']);
  });

  it('should grant admin_chainer exactly SELECT + DELETE on the queue (the drain) and touch no other table', () => {
    const chainerGrants = (code.match(/GRANT[^;]+;/g) ?? []).filter((g) => g.includes('admin_chainer'));
    expect(chainerGrants).toEqual(['GRANT SELECT, DELETE ON security_audit_ingest TO admin_chainer;']);
  });

  it('should grant admin_reader SELECT only', () => {
    const readerGrants = (code.match(/GRANT[^;]+;/g) ?? []).filter((g) => g.includes('admin_reader'));
    expect(readerGrants).toEqual(['GRANT SELECT ON security_audit_ingest TO admin_reader;']);
  });

  it('should grant NOTHING to admin_gdpr_eraser, admin_siem, or admin_maintenance, and never GRANT ALL or TRUNCATE', () => {
    const grants = code.match(/GRANT[^;]+;/g) ?? [];
    expect(grants).toHaveLength(3);
    for (const grant of grants) {
      expect(grant).not.toMatch(/admin_gdpr_eraser|admin_siem|admin_maintenance/);
      expect(grant).not.toMatch(/\bTRUNCATE\b/);
      expect(grant).not.toMatch(/\bGRANT\s+ALL\b/);
    }
    // The queue's DELETE grant goes to the chainer alone.
    const deleteGrants = grants.filter((g) => /\bDELETE\b/.test(g));
    expect(deleteGrants).toEqual(['GRANT SELECT, DELETE ON security_audit_ingest TO admin_chainer;']);
  });
});

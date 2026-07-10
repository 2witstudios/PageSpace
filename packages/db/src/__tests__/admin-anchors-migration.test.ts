/**
 * Static invariants of the anchor-receipt-table migration (#890 Phase 2,
 * leaf 3).
 *
 * security_audit_anchors is the SECOND witness surface beside S3 Object-Lock:
 * the chainer's receipt publisher INSERTs one signed head per anchor. The
 * grant matrix makes it append-only for every role — an attacker holding any
 * provisioned trust-plane credential cannot rewrite or delete a published
 * anchor. Live 42501 denials are proven by the chainer integration suite;
 * these tests pin the migration SQL so CI catches a regressed matrix without
 * a database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const ADMIN_MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle-admin');

const migrationFile = readdirSync(ADMIN_MIGRATIONS_DIR).find((f) =>
  /^0006_.*\.sql$/.test(f),
);
const sql = readFileSync(path.join(ADMIN_MIGRATIONS_DIR, migrationFile ?? ''), 'utf8');
/** SQL with line comments stripped, so assertions never match prose. */
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('drizzle-admin/0006 security_audit_anchors migration', () => {
  it('should exist in the admin journal as migration 0006', () => {
    expect(migrationFile).toBe('0006_security_audit_anchors.sql');
    const journal = JSON.parse(
      readFileSync(path.join(ADMIN_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === 6)?.tag).toBe('0006_security_audit_anchors');
  });

  it('should create a PLAIN table (anchors are few and forever — no PARTITION BY) with every signed field NOT NULL', () => {
    expect(code).toContain('CREATE TABLE IF NOT EXISTS "security_audit_anchors"');
    expect(code).not.toContain('PARTITION BY');
    expect(code).toContain('"version" integer NOT NULL');
    expect(code).toContain('"chain_seq" bigint NOT NULL');
    expect(code).toContain('"head_hash" text NOT NULL');
    expect(code).toContain('"anchored_at" timestamp with time zone NOT NULL');
    expect(code).toContain('"signature" text NOT NULL');
    expect(code).toContain('"created_at" timestamp with time zone DEFAULT now() NOT NULL');
  });

  it('should index chain_seq for the verifier’s anchor-vs-chain matching', () => {
    expect(code).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_security_audit_anchors_chain_seq" ON "security_audit_anchors" USING btree ("chain_seq")',
    );
  });

  it('should revoke every ambient PUBLIC privilege on the anchors table', () => {
    expect(code).toContain('REVOKE ALL ON security_audit_anchors FROM PUBLIC');
  });

  it('should grant admin_chainer INSERT and nothing else (fire-and-forget receipt: not even SELECT)', () => {
    const chainerGrants = (code.match(/GRANT[^;]+;/g) ?? []).filter((g) =>
      g.includes('admin_chainer'),
    );
    expect(chainerGrants).toEqual(['GRANT INSERT ON security_audit_anchors TO admin_chainer;']);
  });

  it('should grant admin_reader SELECT only (the verifier reads anchors back)', () => {
    const readerGrants = (code.match(/GRANT[^;]+;/g) ?? []).filter((g) =>
      g.includes('admin_reader'),
    );
    expect(readerGrants).toEqual(['GRANT SELECT ON security_audit_anchors TO admin_reader;']);
  });

  it('should grant NOBODY UPDATE, DELETE, TRUNCATE, or ALL — the witness surface is append-only for every role', () => {
    const grants = code.match(/GRANT[^;]+;/g) ?? [];
    expect(grants).toHaveLength(2);
    for (const grant of grants) {
      expect(grant).not.toMatch(/admin_app|admin_gdpr_eraser|admin_siem|admin_maintenance/);
      expect(grant).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/);
      expect(grant).not.toMatch(/\bGRANT\s+ALL\b/);
    }
  });
});

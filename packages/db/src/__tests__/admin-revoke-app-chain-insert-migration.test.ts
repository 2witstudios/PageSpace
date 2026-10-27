/**
 * Static invariants of the admin_app chain-table revoke migration (#890
 * Phase 2 FIX — REVIEW finding: zero-trust hole).
 *
 * Post-cutover admin_app INSERTs ONLY into security_audit_ingest; the
 * chainer (admin_chainer) is the single writer of security_audit_log. The
 * Phase-1 `GRANT SELECT, INSERT … TO admin_app` became excess privilege at
 * the leaf-5 cutover: a compromised web credential could append chain-valid
 * forged rows directly (no ingest, no emission discipline, no co-stream
 * witness) and the chainer would link onto and anchor-witness them. 0008
 * revokes exactly that — INSERT on the chain table and USAGE on its
 * chain_seq sequence — while SELECT (readers, verifier) survives.
 * Break-glass is unaffected: it writes the MAIN db.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const ADMIN_MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle-admin');

const migrationFile = readdirSync(ADMIN_MIGRATIONS_DIR).find((f) =>
  /^0008_.*\.sql$/.test(f),
);
const sql = readFileSync(path.join(ADMIN_MIGRATIONS_DIR, migrationFile ?? ''), 'utf8');
/** SQL with line comments stripped, so assertions never match prose. */
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('drizzle-admin/0008 revoke admin_app chain-table INSERT', () => {
  it('should exist in the admin journal as migration 0008', () => {
    expect(migrationFile).toBe('0008_revoke_app_chain_insert.sql');
    const journal = JSON.parse(
      readFileSync(path.join(ADMIN_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === 8)?.tag).toBe('0008_revoke_app_chain_insert');
  });

  it('should revoke exactly INSERT on security_audit_log and USAGE on its chain_seq sequence from admin_app, and grant nothing', () => {
    const statements = (code.match(/(GRANT|REVOKE)[^;]+;/g) ?? []).map((s) =>
      s.replace(/\s+/g, ' ').trim(),
    );
    expect(statements).toEqual([
      'REVOKE INSERT ON security_audit_log FROM admin_app;',
      'REVOKE USAGE ON SEQUENCE security_audit_log_chain_seq_seq FROM admin_app;',
    ]);
  });

  it('should never revoke SELECT (readers/verifier keep reading the chain)', () => {
    expect(code).not.toMatch(/REVOKE[^;]*SELECT/i);
  });

  it('should touch no other role — the chainer stays the single writer', () => {
    expect(code).not.toMatch(/admin_chainer|admin_reader|admin_gdpr_eraser|admin_siem|admin_maintenance/);
  });

  it('should touch no other table', () => {
    expect(code).not.toMatch(/security_audit_ingest|security_audit_anchors|siem_delivery/);
  });
});

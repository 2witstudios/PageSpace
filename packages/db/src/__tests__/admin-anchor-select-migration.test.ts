/**
 * Static invariants of the anchor-readback grant migration (#890 Phase 2,
 * leaf 5 — runtime cutover).
 *
 * The periodic chain verifier (apps/web cron, connecting as admin_app) now
 * matches published anchors against the chain, so admin_app gains exactly one
 * privilege: SELECT on security_audit_anchors. The append-only invariant of
 * the witness surface must survive untouched — no role may ever hold UPDATE,
 * DELETE, or TRUNCATE on it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const ADMIN_MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle-admin');

const migrationFile = readdirSync(ADMIN_MIGRATIONS_DIR).find((f) =>
  /^0007_.*\.sql$/.test(f),
);
const sql = readFileSync(path.join(ADMIN_MIGRATIONS_DIR, migrationFile ?? ''), 'utf8');
/** SQL with line comments stripped, so assertions never match prose. */
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('drizzle-admin/0007 anchor SELECT for the periodic verifier', () => {
  it('should exist in the admin journal as migration 0007', () => {
    expect(migrationFile).toBe('0007_anchor_select_for_verifier.sql');
    const journal = JSON.parse(
      readFileSync(path.join(ADMIN_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === 7)?.tag).toBe('0007_anchor_select_for_verifier');
  });

  it('should grant exactly SELECT on security_audit_anchors to admin_app and nothing else', () => {
    const statements = (code.match(/(GRANT|REVOKE)[^;]+;/g) ?? []).map((s) =>
      s.replace(/\s+/g, ' ').trim(),
    );
    expect(statements).toEqual(['GRANT SELECT ON security_audit_anchors TO admin_app;']);
  });

  it('should keep the witness surface append-only — no UPDATE/DELETE/TRUNCATE appears anywhere', () => {
    expect(code).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE)\b/i);
    expect(code).not.toMatch(/\bGRANT\s+ALL\b/i);
  });

  it('should touch no other table or role', () => {
    expect(code).not.toMatch(/security_audit_log\b|security_audit_ingest|siem_delivery/);
    expect(code).not.toMatch(/admin_chainer|admin_reader|admin_gdpr_eraser|admin_siem/);
  });
});

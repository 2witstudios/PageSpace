/**
 * Static invariants of the emission-hash column migration (#890 Phase 2, leaf 2).
 *
 * The chainer copies each drained ingest row's emission_hash onto the chained
 * security_audit_log row so verify-on-append (and the later dual-era full
 * verifier) can recompute chainHash = H(emissionHash, prevHash) from storage.
 * The column is NULLABLE by design: NULL marks a legacy-era row (written
 * pre-cutover or backfilled) whose event_hash was computed by the advisory-lock
 * path — the dual-era verifier is the backfill leaf's scope.
 *
 * ADMIN PLANE ONLY: the main-plane security_audit_log keeps its current shape;
 * the main db:generate pipeline must stay no-drift.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const ADMIN_MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle-admin');
const MAIN_MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');

const migrationFile = readdirSync(ADMIN_MIGRATIONS_DIR).find((f) =>
  /^0005_.*\.sql$/.test(f),
);
const sql = readFileSync(path.join(ADMIN_MIGRATIONS_DIR, migrationFile ?? ''), 'utf8');
/** SQL with line comments stripped, so assertions never match prose. */
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('drizzle-admin/0005 emission_hash column migration', () => {
  it('should exist in the admin journal as migration 0005', () => {
    expect(migrationFile).toBe('0005_emission_hash_column.sql');
    const journal = JSON.parse(
      readFileSync(path.join(ADMIN_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === 5)?.tag).toBe('0005_emission_hash_column');
  });

  it('should add emission_hash to security_audit_log as NULLABLE text (NULL = legacy-era row)', () => {
    expect(code).toContain('ALTER TABLE "security_audit_log" ADD COLUMN "emission_hash" text');
    expect(code).not.toMatch(/emission_hash"?\s+text\s+NOT NULL/i);
  });

  it('should touch nothing else — no grants, no other tables, no drops', () => {
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b/);
    expect(code).not.toContain('security_audit_ingest');
    expect(code).not.toContain('DROP');
  });

  it('should leave the MAIN plane untouched — no main migration mentions emission_hash', () => {
    const mainMentions = readdirSync(MAIN_MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) =>
        readFileSync(path.join(MAIN_MIGRATIONS_DIR, f), 'utf8').includes('emission_hash'),
      );
    expect(mainMentions).toEqual([]);
  });
});

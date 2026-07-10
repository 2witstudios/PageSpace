/**
 * Pins the DEFERRED drop migration for the 4 analytics PG tables
 * (#890 Phase 3 leaf 4 → executed by Phase 6 task kws85p45pvjnivoz3uxs83yp).
 *
 * The invariants under test:
 *  - the script is authored but NOT wired into the drizzle migration chain
 *    (prepared-not-executed — orchestrator ruling: no backfill of pre-cutover
 *    history exists, so dropping now would lose [start→cutover] analytics);
 *  - an unconditional RAISE EXCEPTION guard precedes the first DROP, so an
 *    accidental psql -f cannot destroy the tables;
 *  - it drops exactly the 4 cutover tables — never error_resolutions,
 *    ai_usage_logs, or activity_logs (which stay in main PG).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT_PATH = path.join(
  REPO_ROOT,
  'scripts/deferred-migrations/0890-phase6-drop-analytics-pg-tables.sql',
);
const DRIZZLE_DIR = path.resolve(__dirname, '../../drizzle');
const DROPPED_TABLES = ['api_metrics', 'system_logs', 'user_activities', 'error_logs'];

/** SQL with line comments stripped, so assertions never match prose. */
function stripComments(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const sql = stripComments(readFileSync(SCRIPT_PATH, 'utf8'));

describe('deferred analytics drop migration (#890 Phase 3 leaf 4)', () => {
  it('given the do-not-run gate, an unconditional RAISE EXCEPTION should precede the first DROP', () => {
    const guardIndex = sql.indexOf('RAISE EXCEPTION');
    const firstDropIndex = sql.indexOf('DROP TABLE');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(firstDropIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(firstDropIndex);
  });

  it('given psql -f autocommit semantics, the guard and ALL drops must live in ONE DO block — separate statements would run the drops anyway (#890 Phase 3 FIX)', () => {
    // psql's default ON_ERROR_STOP=off reports a failed statement then
    // CONTINUES; a guard that is its own statement blocks nothing. Inside a
    // single DO block, RAISE EXCEPTION makes the drops genuinely unreachable.
    const doStart = sql.indexOf('DO $$');
    const doEnd = sql.indexOf('$$;', doStart);
    expect(doStart).toBeGreaterThan(-1);
    expect(doEnd).toBeGreaterThan(doStart);

    const guardIndex = sql.indexOf('RAISE EXCEPTION');
    expect(guardIndex).toBeGreaterThan(doStart);
    expect(guardIndex).toBeLessThan(doEnd);

    let dropIndex = sql.indexOf('DROP TABLE');
    expect(dropIndex).toBeGreaterThan(-1);
    while (dropIndex !== -1) {
      expect(dropIndex, 'every DROP must be inside the guarded DO block').toBeGreaterThan(guardIndex);
      expect(dropIndex, 'every DROP must be inside the guarded DO block').toBeLessThan(doEnd);
      dropIndex = sql.indexOf('DROP TABLE', dropIndex + 1);
    }

    // Exactly one DO block — a second one would reintroduce statement splits.
    expect(sql.indexOf('DO $$', doStart + 1)).toBe(-1);
  });

  it('given the cutover set, should drop exactly the 4 analytics tables', () => {
    const drops = sql.match(/DROP TABLE IF EXISTS "(\w+)"/g) ?? [];
    const dropped = drops.map((d) => /"(\w+)"/.exec(d)?.[1]).sort();
    expect(dropped).toEqual([...DROPPED_TABLES].sort());
  });

  it('given the tables that STAY in main PG, should never touch them', () => {
    for (const kept of ['error_resolutions', 'ai_usage_logs', 'activity_logs']) {
      expect(sql).not.toMatch(new RegExp(`DROP TABLE[^;]*"${kept}"`));
    }
  });

  it('given prepared-not-executed, no drizzle migration should drop any of the 4 tables', () => {
    const migrationFiles = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith('.sql'));
    expect(migrationFiles.length).toBeGreaterThan(0);
    for (const file of migrationFiles) {
      const migration = stripComments(readFileSync(path.join(DRIZZLE_DIR, file), 'utf8'));
      for (const table of DROPPED_TABLES) {
        expect(migration, `${file} must not drop ${table}`).not.toMatch(
          new RegExp(`DROP TABLE[^;]*"${table}"`),
        );
      }
    }
  });
});

/**
 * Pins the migration that drops the dead `page_tags` table (Content Tags epic,
 * Phase 2).
 *
 * `page_tags` was created by migration 0000 and never written since: the only
 * reference anywhere in the repo was a cascade delete in the trash route,
 * removing rows nothing ever inserted. It is replaced by `content_tags`, which
 * a composite-PK join table could not have become — one tag attaches to a page
 * many times, at different targets.
 *
 * The invariants under test, following
 * `drop-legacy-permissions-table.test.ts`'s shape:
 *  - exactly ONE migration drops `page_tags`, and it IS wired into the chain
 *    (`meta/_journal.json`) rather than prepared-but-deferred;
 *  - it drops exactly that table and NOTHING else — asserted with `toEqual`,
 *    never `includes`, so the test proves `tags` (reclaimed in the migration
 *    immediately before it, not dropped) survived;
 *  - a RAISE NOTICE carrying the row count precedes the drop inside a single
 *    DO block, so the count reaches the deploy log and psql's statement-level
 *    error handling (ON_ERROR_STOP=off) cannot separate the two;
 *  - the ADDITIVE migration that reclaims `tags` drops nothing at all, which is
 *    why the two are separate files: `migration-sql-analysis.ts` sets
 *    `singleDoBlock: false` as soon as a SECOND `DO $$` appears in a file, so
 *    the reclaim's guarded pre-step and this drop cannot share one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { analyzeDropMigration, stripSqlComments } from '../migration-sql-analysis';

const DRIZZLE_DIR = path.resolve(__dirname, '../../drizzle');
const JOURNAL_PATH = path.join(DRIZZLE_DIR, 'meta/_journal.json');

const DROPPED_TABLE = 'page_tags';
/** Tables the content-tags work must never take with it. */
const PROTECTED_TABLES = ['tags', 'content_tags', 'pages', 'channel_messages', 'messages'];

const migrationFiles = readdirSync(DRIZZLE_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

function sqlOf(file: string): string {
  return stripSqlComments(readFileSync(path.join(DRIZZLE_DIR, file), 'utf8'));
}

const droppers = migrationFiles.filter((file) =>
  analyzeDropMigration(sqlOf(file)).droppedTables.includes(DROPPED_TABLE),
);

describe('page_tags drop migration (content tags, phase 2)', () => {
  it('given a one-time drop, exactly one migration should drop the table', () => {
    expect(droppers).toEqual([expect.stringMatching(/\.sql$/)]);
  });

  it('given the drop is not deferred, its tag should be registered in _journal.json', () => {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')) as {
      entries: { tag: string }[];
    };
    const tag = path.basename(droppers[0], '.sql');
    expect(journal.entries.map((e) => e.tag)).toContain(tag);
  });

  describe('the migration SQL', () => {
    /** Read lazily so a missing migration fails the count assertion above, not collection. */
    const analysis = () => analyzeDropMigration(sqlOf(droppers[0]));

    it('should drop exactly the one dead join table', () => {
      // `toEqual`, not `toContain`: `tags` is RECLAIMED by the migration
      // immediately before this one, and a drop that took it along would be
      // silent data loss for the table this whole epic is built on.
      expect(analysis().droppedTables).toEqual([DROPPED_TABLE]);
    });

    it('should drop no PG enum types', () => {
      // `page_tags` had none of its own; the three `ContentTag*` types are
      // CREATEd by the additive migration, never dropped here.
      expect(analysis().droppedTypes).toEqual([]);
    });

    it('given the row count must reach the deploy log, RAISE NOTICE should precede the drop', () => {
      expect(analysis().noticeBeforeFirstDrop).toBe(true);
    });

    it('given psql statement semantics, the NOTICE and the DROP must share one DO block', () => {
      expect(analysis().singleDoBlock).toBe(true);
      expect(analysis().allDropsInsideDoBlock).toBe(true);
    });
  });

  it('keeps the additive half free of drops, which is why it is its own file', () => {
    const tag = path.basename(droppers[0], '.sql');
    const index = migrationFiles.indexOf(`${tag}.sql`);
    expect(index).toBeGreaterThan(0);
    const additive = migrationFiles[index - 1];
    const additiveAnalysis = analyzeDropMigration(sqlOf(additive));
    expect(additiveAnalysis.droppedTables).toEqual([]);
    expect(additiveAnalysis.droppedTypes).toEqual([]);
    // It creates the replacement table in the same release, so the drop is
    // never live without its successor.
    expect(sqlOf(additive)).toMatch(/CREATE TABLE "content_tags"/);
  });

  it('given the live tag tables, no migration should ever drop them', () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
    for (const file of migrationFiles) {
      const { droppedTables } = analyzeDropMigration(sqlOf(file));
      for (const protectedTable of PROTECTED_TABLES) {
        expect(droppedTables, `${file} must not drop ${protectedTable}`).not.toContain(protectedTable);
      }
    }
  });
});

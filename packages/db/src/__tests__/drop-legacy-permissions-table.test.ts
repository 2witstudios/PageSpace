/**
 * Pins the migration that drops the dormant legacy `permissions` table (#2160).
 *
 * The table (`schema/permissions.ts`, present since "Open Beta Init" and never
 * written since) had zero readers and zero writers — every live permission check
 * goes through `pagePermissions` in `schema/members.ts`. Residual rows were
 * frozen misinformation about access control.
 *
 * The invariants under test:
 *  - exactly ONE drizzle migration drops "permissions", and it IS wired into the
 *    migration chain (`meta/_journal.json`) — the inverse of the deferred
 *    prepared-not-executed script pinned by `deferred-drop-analytics-tables.test.ts`;
 *  - it drops exactly that one table — never `page_permissions` or any other
 *    table whose name merely contains "permissions";
 *  - it drops the two now-orphaned PG enum types, which drizzle-kit 0.23 does
 *    not emit on its own (precedent: 0105, 0116);
 *  - a RAISE NOTICE carrying the row count precedes the first DROP inside a
 *    single DO block, so the count is captured in the deploy log and psql's
 *    statement-level error handling cannot reorder the two.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { analyzeDropMigration, stripSqlComments } from '../migration-sql-analysis';

const DRIZZLE_DIR = path.resolve(__dirname, '../../drizzle');
const JOURNAL_PATH = path.join(DRIZZLE_DIR, 'meta/_journal.json');

const DROPPED_TABLE = 'permissions';
const DROPPED_TYPES = ['PermissionAction', 'SubjectType'];
/** Live permission tables that must never be touched by this migration. */
const PROTECTED_TABLES = [
  'page_permissions',
  'drive_roles',
  'drive_members',
  'share_links',
  'pending_page_invites',
];

const migrationFiles = readdirSync(DRIZZLE_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

/** Every migration that drops the bare "permissions" table, by filename. */
const droppers = migrationFiles.filter((file) => {
  const sql = stripSqlComments(readFileSync(path.join(DRIZZLE_DIR, file), 'utf8'));
  return analyzeDropMigration(sql).droppedTables.includes(DROPPED_TABLE);
});

describe('legacy permissions table drop migration (#2160)', () => {
  it('given a one-time drop, exactly one migration should drop the table', () => {
    expect(droppers).toHaveLength(1);
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
    const analysis = () =>
      analyzeDropMigration(stripSqlComments(readFileSync(path.join(DRIZZLE_DIR, droppers[0]), 'utf8')));

    it('should drop exactly the one legacy table', () => {
      expect(analysis().droppedTables).toEqual([DROPPED_TABLE]);
    });

    it('should drop both now-orphaned PG enum types', () => {
      expect(analysis().droppedTypes.sort()).toEqual([...DROPPED_TYPES].sort());
    });

    it('given the row count must reach the deploy log, RAISE NOTICE should precede the first DROP', () => {
      expect(analysis().noticeBeforeFirstDrop).toBe(true);
    });

    it('given psql statement semantics, the NOTICE and every DROP must share one DO block', () => {
      expect(analysis().singleDoBlock).toBe(true);
      expect(analysis().allDropsInsideDoBlock).toBe(true);
    });
  });

  it('given the live permission tables, no migration should ever drop them', () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
    for (const file of migrationFiles) {
      const sql = stripSqlComments(readFileSync(path.join(DRIZZLE_DIR, file), 'utf8'));
      const { droppedTables } = analyzeDropMigration(sql);
      for (const protectedTable of PROTECTED_TABLES) {
        expect(droppedTables, `${file} must not drop ${protectedTable}`).not.toContain(protectedTable);
      }
    }
  });
});

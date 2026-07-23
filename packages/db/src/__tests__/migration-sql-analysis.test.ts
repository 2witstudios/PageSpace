/**
 * Unit tests for the pure migration-SQL analyser (#2160).
 *
 * `analyzeDropMigration` is the pure core behind
 * `drop-legacy-permissions-table.test.ts`: it takes raw SQL text and returns a
 * structured summary. No filesystem, no database — the caller injects the text.
 * Gated at 100% branch coverage in vitest.config.ts.
 */
import { describe, it, expect } from 'vitest';
import { analyzeDropMigration, stripSqlComments } from '../migration-sql-analysis';

describe('stripSqlComments', () => {
  it('given a leading line comment, should drop the whole line', () => {
    expect(stripSqlComments('-- DROP TABLE "decoy";\nSELECT 1;')).toBe('SELECT 1;');
  });

  it('given an indented line comment, should still drop it', () => {
    expect(stripSqlComments('   -- prose\nSELECT 1;')).toBe('SELECT 1;');
  });

  it('given no comments, should return the SQL unchanged', () => {
    expect(stripSqlComments('SELECT 1;')).toBe('SELECT 1;');
  });
});

describe('analyzeDropMigration', () => {
  it('given empty SQL, should report nothing dropped and no guards', () => {
    const analysis = analyzeDropMigration('');
    expect(analysis).toEqual({
      droppedTables: [],
      droppedTypes: [],
      noticeBeforeFirstDrop: false,
      singleDoBlock: false,
      allDropsInsideDoBlock: false,
    });
  });

  it('given comment-only SQL, should ignore drops mentioned in prose', () => {
    const analysis = analyzeDropMigration(
      stripSqlComments('-- DROP TABLE "permissions";\n-- DROP TYPE "SubjectType";'),
    );
    expect(analysis.droppedTables).toEqual([]);
    expect(analysis.droppedTypes).toEqual([]);
  });

  it('given plain drops with no DO block, should collect names but flag no guard', () => {
    const analysis = analyzeDropMigration('DROP TABLE "permissions";\nDROP TYPE "SubjectType";');
    expect(analysis.droppedTables).toEqual(['permissions']);
    expect(analysis.droppedTypes).toEqual(['SubjectType']);
    expect(analysis.singleDoBlock).toBe(false);
    expect(analysis.allDropsInsideDoBlock).toBe(false);
    expect(analysis.noticeBeforeFirstDrop).toBe(false);
  });

  it('given IF EXISTS variants, should still capture the names', () => {
    const analysis = analyzeDropMigration(
      'DROP TABLE IF EXISTS "permissions";\nDROP TYPE IF EXISTS "PermissionAction";',
    );
    expect(analysis.droppedTables).toEqual(['permissions']);
    expect(analysis.droppedTypes).toEqual(['PermissionAction']);
  });

  it('given schema-qualified drops, should resolve to the bare name', () => {
    const analysis = analyzeDropMigration(
      'DROP TABLE IF EXISTS "public"."permissions";\nDROP TYPE IF EXISTS "public"."SubjectType";',
    );
    expect(analysis.droppedTables).toEqual(['permissions']);
    expect(analysis.droppedTypes).toEqual(['SubjectType']);
  });

  it('given a guarded single DO block, should report every guard satisfied', () => {
    const analysis = analyzeDropMigration(
      [
        'DO $$',
        'BEGIN',
        "  RAISE NOTICE 'count = %', n;",
        '  DROP TABLE IF EXISTS "permissions";',
        '  DROP TYPE IF EXISTS "PermissionAction";',
        '  DROP TYPE IF EXISTS "SubjectType";',
        'END $$;',
      ].join('\n'),
    );
    expect(analysis.droppedTables).toEqual(['permissions']);
    expect(analysis.droppedTypes).toEqual(['PermissionAction', 'SubjectType']);
    expect(analysis.noticeBeforeFirstDrop).toBe(true);
    expect(analysis.singleDoBlock).toBe(true);
    expect(analysis.allDropsInsideDoBlock).toBe(true);
  });

  it('given a NOTICE that follows the first drop, should flag the ordering', () => {
    const analysis = analyzeDropMigration(
      ['DO $$', 'BEGIN', '  DROP TABLE "permissions";', "  RAISE NOTICE 'too late';", 'END $$;'].join('\n'),
    );
    expect(analysis.noticeBeforeFirstDrop).toBe(false);
  });

  it('given two DO blocks, should flag the statement split', () => {
    const analysis = analyzeDropMigration(
      [
        'DO $$',
        'BEGIN',
        "  RAISE NOTICE 'count';",
        'END $$;',
        'DO $$',
        'BEGIN',
        '  DROP TABLE "permissions";',
        'END $$;',
      ].join('\n'),
    );
    expect(analysis.singleDoBlock).toBe(false);
    expect(analysis.allDropsInsideDoBlock).toBe(false);
  });

  it('given a DO block that never terminates, should not claim a single block', () => {
    const analysis = analyzeDropMigration('DO $$\nBEGIN\n  DROP TABLE "permissions";\n');
    expect(analysis.singleDoBlock).toBe(false);
    expect(analysis.allDropsInsideDoBlock).toBe(false);
  });

  it('given a drop that escapes the DO block, should flag it as outside', () => {
    const analysis = analyzeDropMigration(
      [
        'DO $$',
        'BEGIN',
        "  RAISE NOTICE 'count';",
        '  DROP TABLE "permissions";',
        'END $$;',
        'DROP TYPE "SubjectType";',
      ].join('\n'),
    );
    expect(analysis.singleDoBlock).toBe(true);
    expect(analysis.allDropsInsideDoBlock).toBe(false);
  });

  it('given a guarded block with no drops at all, should not claim drops are contained', () => {
    const analysis = analyzeDropMigration("DO $$\nBEGIN\n  RAISE NOTICE 'nothing';\nEND $$;");
    expect(analysis.droppedTables).toEqual([]);
    expect(analysis.singleDoBlock).toBe(true);
    expect(analysis.allDropsInsideDoBlock).toBe(false);
  });
});

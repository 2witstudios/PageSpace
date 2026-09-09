/**
 * Static invariants of the multi-attachment migration (0292 DDL + 0293 backfill).
 *
 * These pin the migration SQL itself so CI catches a regression without needing
 * a database. Two properties matter enough to assert here:
 *
 *  - 0292 must stay UNEDITED drizzle-kit output. Generated DDL is not
 *    re-runnable (bare CREATE TABLE), which is fine only while nobody edits it
 *    — and the runner keys applied migrations by file hash, so an edit re-runs
 *    it on databases that already applied it.
 *  - 0293 is hand-written and therefore MUST be idempotent, because the same
 *    hash-keyed replay applies to it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const DRIZZLE_DIR = path.resolve(__dirname, '../../drizzle');

const read = (file: string) => readFileSync(path.join(DRIZZLE_DIR, file), 'utf8');
/** SQL with line comments stripped, so assertions never match prose. */
const stripComments = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

const ddl = stripComments(read('0292_cold_the_phantom.sql'));
const backfill = read('0293_backfill_message_attachments.sql');
const backfillCode = stripComments(backfill);

const TABLES = ['channel_message_attachments', 'direct_message_attachments'] as const;

/**
 * Just the statements that mention one table, so a per-table assertion cannot
 * be satisfied by the OTHER table's DDL. The two CREATE TABLEs are separate
 * statements, and searching all of `ddl` for `"position"` or `< 10` would pass
 * on a migration that dropped the column or the CHECK from one of them.
 */
const ddlFor = (table: string) =>
  ddl
    .split('--> statement-breakpoint')
    .filter((statement) => statement.includes(`"${table}"`))
    .join('\n');

describe('0292 multi-attachment DDL', () => {
  it('should be registered in the journal', () => {
    const journal = JSON.parse(
      readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === 292)?.tag).toBe('0292_cold_the_phantom');
    expect(journal.entries.find((e) => e.idx === 293)?.tag).toBe(
      '0293_backfill_message_attachments',
    );
  });

  for (const table of TABLES) {
    const tableDdl = ddlFor(table);

    it(`should create ${table} with the columns the repositories read`, () => {
      expect(tableDdl).toContain(`CREATE TABLE "${table}"`);
      for (const column of ['id', 'messageId', 'fileId', 'attachmentMeta', 'position', 'createdAt']) {
        expect(tableDdl).toContain(`"${column}"`);
      }
    });

    it(`should cascade ${table} from its message and SET NULL from its file`, () => {
      // Cascade: deleting a message takes its attachments with it.
      expect(tableDdl).toMatch(
        new RegExp(`ALTER TABLE "${table}"[\\s\\S]*?FOREIGN KEY \\("messageId"\\)[\\s\\S]*?ON DELETE cascade`),
      );
      // SET NULL, not cascade: a hard file delete must leave the row (and its
      // meta) behind so the message keeps rendering, one tile short.
      expect(tableDdl).toMatch(
        new RegExp(`ALTER TABLE "${table}"[\\s\\S]*?FOREIGN KEY \\("fileId"\\)[\\s\\S]*?ON DELETE set null`),
      );
    });

    it(`should cap ${table} cardinality in the database itself`, () => {
      // The CHECK and the unique index together are the cap — no trigger, no
      // counter column. MAX_MESSAGE_ATTACHMENTS in @pagespace/lib must agree;
      // attachment-upload-core.test.ts pins that side.
      expect(tableDdl).toContain(`CONSTRAINT "${table}_position_range" CHECK`);
      expect(tableDdl).toContain('< 10');
      expect(tableDdl).toContain(
        `CREATE UNIQUE INDEX "${table}_message_position_idx" ON "${table}" USING btree ("messageId","position")`,
      );
    });

    it(`should index ${table} by fileId for the orphan and purge checks`, () => {
      expect(tableDdl).toContain(`CREATE INDEX "${table}_file_id_idx"`);
    });

    it(`should NOT constrain ${table} to carry a file or metadata`, () => {
      // A CHECK (fileId IS NOT NULL OR attachmentMeta IS NOT NULL) reads like
      // an obvious guard and is a trap: a row backfilled from a legacy fileId
      // with no meta satisfies it only by the fileId, so the ON DELETE SET NULL
      // that follows a hard file delete re-evaluates the CHECK, fails it, and
      // aborts the DELETE on `files`. Deleting a file must not depend on
      // whether some old message recorded metadata beside it.
      expect(tableDdl).not.toContain(`CONSTRAINT "${table}_not_empty"`);
    });
  }

  it('should remain unedited generator output', () => {
    // Generated DDL is not re-runnable. Keeping it pristine is the whole reason
    // the backfill lives in a separate file; a hand-added guard here would mean
    // someone edited it, which re-runs the CREATE TABLEs in production.
    expect(ddl).not.toContain('IF NOT EXISTS');
    expect(ddl).not.toContain('DO $$');
    expect(ddl).not.toContain('INSERT INTO');
  });

  it('should be additive — it must not drop the legacy attachment columns', () => {
    // Readers we have not migrated (SDK, CLI, processor) still read them.
    expect(ddl).not.toContain('DROP COLUMN');
  });
});

describe('0293 attachment backfill', () => {
  for (const [table, source] of [
    ['channel_message_attachments', 'channel_messages'],
    ['direct_message_attachments', 'direct_messages'],
  ] as const) {
    it(`should copy ${source}'s legacy attachment into ${table}`, () => {
      expect(backfillCode).toContain(`INSERT INTO "${table}"`);
      expect(backfillCode).toContain(`FROM "${source}"`);
    });
  }

  it('should be a no-op when replayed', () => {
    // The runner keys migrations by file hash, so ANY later edit re-runs this
    // file wherever it already applied.
    expect(backfillCode).toContain("'legacy_' || cm.\"id\"");
    expect(backfillCode).toContain("'legacy_' || dm.\"id\"");
    expect(backfillCode).not.toContain('gen_random_uuid');
  });

  it('should skip messages that already have an attachment row', () => {
    // The load-bearing half of replay safety, and NOT interchangeable with a
    // primary-key conflict target. A message the new application wrote after
    // this migration ran carries both the dual-written legacy columns and a
    // real attachment row at position 0 with a cuid2 id. On replay the id
    // would not collide, but the (messageId, position) unique index would, and
    // ON CONFLICT ("id") does not suppress that — the migration would abort.
    expect(backfillCode).toContain(
      'NOT EXISTS (\n    SELECT 1 FROM "channel_message_attachments" a WHERE a."messageId" = cm."id"\n  )',
    );
    expect(backfillCode).toContain(
      'NOT EXISTS (\n    SELECT 1 FROM "direct_message_attachments" a WHERE a."messageId" = dm."id"\n  )',
    );
    // Untargeted, so it covers the position index too — not just the PK.
    expect((backfillCode.match(/ON CONFLICT DO NOTHING/g) ?? []).length).toBe(2);
    expect(backfillCode).not.toContain('ON CONFLICT ("id")');
  });

  it('should copy rows carrying either a fileId or metadata, not only both', () => {
    // A legacy row can hold a fileId with a null attachmentMeta, or metadata
    // with no surviving file. An AND here would silently skip those, leaving
    // live attachments invisible to the purge's orphan check — which is what
    // deletes the blob from S3.
    expect(backfillCode).toContain('cm."fileId" IS NOT NULL OR cm."attachmentMeta" IS NOT NULL');
    expect(backfillCode).toContain('dm."fileId" IS NOT NULL OR dm."attachmentMeta" IS NOT NULL');
  });

  it('should fail loudly rather than ship a partial backfill', () => {
    expect(backfillCode).toContain('RAISE EXCEPTION');
    expect(backfillCode).toContain('backfill incomplete');
  });
});

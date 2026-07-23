/**
 * Pure analysis of migration SQL text (#2160).
 *
 * Destructive migrations are worth pinning with tests, but the assertions must
 * never match prose in a migration's header comment, and they must be able to
 * tell "the DROP is inside the guarded DO block" from "the DROP is a bare
 * statement psql will happily run after the guard failed".
 *
 * This module is the pure core: text in, structured summary out. No filesystem
 * and no database — the caller reads the file and injects the string.
 */

export interface DropMigrationAnalysis {
  /** Table names appearing in `DROP TABLE [IF EXISTS] "name"`, in source order. */
  droppedTables: string[];
  /** Type names appearing in `DROP TYPE [IF EXISTS] "Name"`, in source order. */
  droppedTypes: string[];
  /** A `RAISE NOTICE` appears before the first DROP of any kind. */
  noticeBeforeFirstDrop: boolean;
  /** Exactly one complete `DO $$ … $$;` block is present. */
  singleDoBlock: boolean;
  /** At least one DROP exists and every DROP sits inside that single block. */
  allDropsInsideDoBlock: boolean;
}

const DROP_TABLE_RE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi;
const DROP_TYPE_RE = /DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi;
const ANY_DROP_RE = /DROP\s+(?:TABLE|TYPE)\s/gi;

/**
 * Strips whole `--` line-comment lines so assertions never match a migration's
 * prose header (the `deferred-drop-analytics-tables.test.ts` precedent).
 */
export function stripSqlComments(rawSql: string): string {
  return rawSql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** All match offsets for `pattern` in `sql`. */
function offsetsOf(sql: string, pattern: RegExp): number[] {
  const re = new RegExp(pattern.source, pattern.flags);
  const offsets: number[] = [];
  let match = re.exec(sql);
  while (match !== null) {
    offsets.push(match.index);
    match = re.exec(sql);
  }
  return offsets;
}

/** All capture-group-1 values for `pattern` in `sql`, in source order. */
function namesOf(sql: string, pattern: RegExp): string[] {
  const re = new RegExp(pattern.source, pattern.flags);
  const names: string[] = [];
  let match = re.exec(sql);
  while (match !== null) {
    names.push(match[1]);
    match = re.exec(sql);
  }
  return names;
}

/**
 * Summarises what a (comment-stripped) migration drops and how well guarded the
 * drops are. Callers are expected to pass `stripSqlComments(raw)`.
 */
export function analyzeDropMigration(sql: string): DropMigrationAnalysis {
  const droppedTables = namesOf(sql, DROP_TABLE_RE);
  const droppedTypes = namesOf(sql, DROP_TYPE_RE);
  const dropOffsets = offsetsOf(sql, ANY_DROP_RE);

  const noticeIndex = sql.indexOf('RAISE NOTICE');
  const noticeBeforeFirstDrop =
    noticeIndex !== -1 && dropOffsets.length > 0 && noticeIndex < dropOffsets[0];

  const doStart = sql.indexOf('DO $$');
  const doEnd = doStart === -1 ? -1 : sql.indexOf('$$;', doStart);
  const hasSecondDoBlock = doStart !== -1 && sql.indexOf('DO $$', doStart + 1) !== -1;
  const singleDoBlock = doStart !== -1 && doEnd !== -1 && !hasSecondDoBlock;

  const allDropsInsideDoBlock =
    singleDoBlock &&
    dropOffsets.length > 0 &&
    dropOffsets.every((offset) => offset > doStart && offset < doEnd);

  return {
    droppedTables,
    droppedTypes,
    noticeBeforeFirstDrop,
    singleDoBlock,
    allDropsInsideDoBlock,
  };
}

#!/usr/bin/env bun
/**
 * Post-migration validation tool.
 *
 * Compares source (shared) and target (tenant) databases to verify
 * migration integrity: row counts, ID presence, and file checksums.
 *
 * Usage:
 *   tsx scripts/tenant-validate.ts \
 *     --source-url postgres://shared:5432/pagespace \
 *     --target-url postgres://tenant:5432/pagespace \
 *     --users user1,user2 \
 *     [--source-file-path /data/shared/files] \
 *     [--target-file-path /data/tenant/files]
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { existsSync } from 'fs';
import path from 'path';
import { resolvePathWithin } from '@pagespace/lib/security/path-validator';
import type { ValidateOptions, ValidationResult, DbClient } from './lib/migration-types';
import { TABLE_IMPORT_ORDER } from './lib/migration-types';
import {
  fileChecksum,
  toSqlInList,
  validateIds,
  conversationSelectionWhere,
  contentTagSelectionWhere,
  workspaceSelectionWhere,
} from './lib/migration-utils';

async function queryIds(
  db: DbClient,
  query: ReturnType<typeof sql>,
): Promise<string[]> {
  const result = await db.execute(query);
  return (result.rows as Record<string, unknown>[]).map((r) => r.id as string);
}

/**
 * Compare a single table between source and target by ID.
 */
async function validateTable(
  sourceDb: DbClient,
  targetDb: DbClient,
  tableName: string,
  idQuery: ReturnType<typeof sql>,
): Promise<ValidationResult> {
  const sourceIds = await queryIds(sourceDb, idQuery);
  const sourceIdSet = new Set(sourceIds);

  const targetIds = await queryIds(targetDb, idQuery);
  const targetIdSet = new Set(targetIds);

  const missingIds = [...sourceIdSet].filter((id) => !targetIdSet.has(id));
  const extraIds = [...targetIdSet].filter((id) => !sourceIdSet.has(id));

  return {
    passed: missingIds.length === 0 && extraIds.length === 0,
    table: tableName,
    sourceCount: sourceIds.length,
    targetCount: targetIds.length,
    missingIds,
    extraIds,
  };
}

/**
 * Compare a table with a composite primary key using row counts.
 */
async function validateTableCount(
  sourceDb: DbClient,
  targetDb: DbClient,
  tableName: string,
  countQuery: ReturnType<typeof sql>,
): Promise<ValidationResult> {
  const srcResult = await sourceDb.execute(countQuery);
  const tgtResult = await targetDb.execute(countQuery);
  const sourceCount = Number((srcResult.rows as Record<string, unknown>[])[0]?.count ?? 0);
  const targetCount = Number((tgtResult.rows as Record<string, unknown>[])[0]?.count ?? 0);

  return {
    passed: sourceCount === targetCount,
    table: tableName,
    sourceCount,
    targetCount,
    missingIds: [],
    extraIds: sourceCount !== targetCount
      ? [`count mismatch: source=${sourceCount}, target=${targetCount}`]
      : [],
  };
}

export interface FullValidationResult {
  passed: boolean;
  tableResults: ValidationResult[];
  fileResults: {
    passed: boolean;
    mismatches: { file: string; reason: string }[];
    /**
     * Blobs the validator declined to compare, mirroring a skip the export
     * made. Reported because `passed: true` otherwise means only "everything I
     * chose to compare matched", with no machine-readable record of how much
     * was declined — and the skips exist precisely where the export and the
     * validator could disagree about a file. A run that compared nothing now
     * says so instead of looking identical to a run that compared everything.
     */
    skipped: { file: string; reason: string }[];
  };
}

/**
 * The SOURCE storage root, derived exactly the way tenant-export.ts:692 and
 * tenant-import.ts:137 derive theirs.
 *
 * Extracted and exported so the mirror is ASSERTED rather than assumed. This
 * file used to read `getArg('source-file-path') || './uploads'`, omitting
 * `FILE_STORAGE_PATH` — so in any deployment that sets the variable, which is
 * the normal one, the export built its bundle from `/data/shared/files` while
 * the validator compared `./uploads`. Mirroring the `resolvePathWithin` CALL
 * while deriving its BASE differently is half a mirror, and the half that was
 * missing is the one that decides which directory is being talked about.
 *
 * SOURCE only, deliberately: the export runs on the source host and the import
 * on the target host, so each sees its own `FILE_STORAGE_PATH`. One variable
 * cannot give a validator comparing both hosts its two roots, so
 * `--target-file-path` stays explicit.
 */
export function resolveSourceStorageRoot(
  argValue: string | undefined,
  envValue: string | undefined,
): string {
  return argValue || envValue || './uploads';
}

/**
 * Run full validation comparing source and target databases.
 */
export async function runValidation(
  options: ValidateOptions,
): Promise<FullValidationResult> {
  const sourcePool = new Pool({ connectionString: options.sourceDatabaseUrl });
  const targetPool = new Pool({ connectionString: options.targetDatabaseUrl });
  const sourceDb = drizzle(sourcePool);
  const targetDb = drizzle(targetPool);

  try {
    return await validateData(sourceDb, targetDb, options);
  } finally {
    await sourcePool.end();
    await targetPool.end();
  }
}

export async function validateData(
  sourceDb: DbClient,
  targetDb: DbClient,
  options: ValidateOptions,
): Promise<FullValidationResult> {
  const { userIds, sourceFileStoragePath, targetFileStoragePath } = options;
  const userIn = toSqlInList(userIds);

  // Discover drives from source
  const driveRows = await sourceDb.execute(
    sql.raw(`SELECT DISTINCT "driveId" FROM drive_members WHERE "userId" IN (${userIn})`),
  );
  const driveIds = (driveRows.rows as Record<string, unknown>[]).map((r) => r.driveId as string);
  const driveIn = toSqlInList(driveIds);

  // Get page IDs from source
  const pageRows = await sourceDb.execute(
    sql.raw(`SELECT id FROM pages WHERE "driveId" IN (${driveIn})`),
  );
  const pageIds = (pageRows.rows as Record<string, unknown>[]).map((r) => r.id as string);
  const pageIn = toSqlInList(pageIds);

  // Get channel message IDs for reaction validation
  const channelMsgRows = await sourceDb.execute(
    sql.raw(`SELECT id FROM channel_messages WHERE "pageId" IN (${pageIn})`),
  );
  const channelMsgIds = (channelMsgRows.rows as Record<string, unknown>[]).map((r) => r.id as string);
  const channelMsgIn = toSqlInList(channelMsgIds);

  // THE CONVERSATIONS THE EXPORT ACTUALLY CARRIED — the shared predicate, not
  // a re-typed subset of it. This was `WHERE "userId" IN (userIn)` alone, which
  // silently dropped the two page arms the exporter has always had, so every
  // downstream list built from it (messages, workspaces, shells) validated a
  // NARROWER population than the bundle contained. Rows outside it were
  // compared on neither the source nor the target side, which is not a missed
  // check but a false PASS: `[PASS] messages` printed even when the import had
  // dropped every message of a page chat started by a drive member outside
  // `--user-ids`.
  const convoRows = await sourceDb.execute(
    sql.raw(`SELECT id FROM conversations WHERE ${conversationSelectionWhere(userIn, pageIn)}`),
  );
  const convoIds = (convoRows.rows as Record<string, unknown>[]).map((r) => r.id as string);
  const convoIn = toSqlInList(convoIds);

  // The export's `allExportedUserIdSet` — the requested users PLUS everyone
  // DISCOVERED alongside them. Validating on the requested set alone left a
  // discovered user's workspace, and its shells' `coldTail` terminal
  // scrollback, carried but never checked.
  // BOTH discovery arms, which the comment above already claimed and the code
  // did not do: tenant-export.ts seeds `referencedUserIds` from the CHANNEL
  // MESSAGE authors as well as the conversation owners. Omitting the channel arm
  // made this set strictly narrower than the one the exporter scopes on, so
  // anything checked against it asks a narrower question than the bundle
  // answers — the same drift the shared selection helpers exist to prevent.
  const discoveredUserRows = await sourceDb.execute(
    sql.raw(
      `SELECT DISTINCT "userId" AS id FROM conversations WHERE id IN (${convoIn})`
      + ` UNION SELECT DISTINCT "userId" AS id FROM channel_messages WHERE "pageId" IN (${pageIn})`,
    ),
  );
  const exportedUserIds = new Set<string>(userIds);
  for (const row of discoveredUserRows.rows as Record<string, unknown>[]) {
    if (row.id) exportedUserIds.add(row.id as string);
  }
  const exportedUserIn = toSqlInList(exportedUserIds);

  // The exporter's rule, IMPORTED rather than restated — see
  // `contentTagSelectionWhere`, whose docblock records the divergence that
  // happens when this is re-typed here instead.
  const contentTagWhere = contentTagSelectionWhere(pageIn, driveIn, channelMsgIn, convoIn, exportedUserIn);

  /**
   * ID-based queries for tables with a single PK.
   *
   * EVERY query here must reproduce its counterpart in tenant-export.ts IN
   * FULL — not "plus the user filter", which is how the first sweep was framed
   * and is why it missed two of these.
   *
   * Six were wrong. Five under-filtered relative to the export
   * (`messages`, `page_permissions`, `user_mentions`,
   * `channel_message_reactions` on the row's USER; `mentions` on its TARGET
   * PAGE), so the source side counted rows the bundle deliberately never
   * carried, they showed up as MISSING, and `allTablesPassed` turned a CORRECT
   * migration into a reported failure.
   *
   * `users` was wrong in the OPPOSITE and more dangerous direction: it checked
   * only the REQUESTED users while the bundle carries the discovered ones too,
   * so a discovered user's row was compared on neither side and a dropped row
   * would still have printed [PASS].
   *
   * Same defect the shared `conversationSelectionWhere` /
   * `workspaceSelectionWhere` / `contentTagSelectionWhere` helpers exist to
   * stop, in the queries that never got a helper. When adding a query here,
   * read the exporter's line for that table and copy every arm of it.
   *
   * `exportedUserIn` is the exporter's `allExportedUserIdSet` — requested users
   * plus everyone discovered with them — which is why it is built above rather
   * than using the narrower requested-only `userIn`.
   */
  const idQueries: Record<string, ReturnType<typeof sql>> = {
    // `exportedUserIn`, NOT `userIn`. The bundle carries the requested users
    // PLUS everyone discovered with them, so checking only the requested set
    // leaves a discovered user's row compared on NEITHER side: if the import
    // dropped it, this still prints [PASS]. That is the opposite and more
    // dangerous direction from the rest of this map — a false pass rather than
    // a false failure — and it is the same scar `workspaceSelectionWhere`
    // records for `agent_workspaces`.
    users: sql.raw(`SELECT id FROM users WHERE id IN (${exportedUserIn})`),
    user_profiles: sql.raw(`SELECT "userId" AS id FROM user_profiles WHERE "userId" IN (${userIn})`),
    drives: sql.raw(`SELECT id FROM drives WHERE id IN (${driveIn})`),
    drive_roles: sql.raw(`SELECT id FROM drive_roles WHERE "driveId" IN (${driveIn})`),
    drive_members: sql.raw(`SELECT id FROM drive_members WHERE "driveId" IN (${driveIn}) AND "userId" IN (${userIn})`),
    pages: sql.raw(`SELECT id FROM pages WHERE "driveId" IN (${driveIn})`),
    // Mirrors the exporter's tag rules exactly (tenant-export.ts): the
    // VOCABULARY travels by drive, whether or not anything still references an
    // entry; the ASSIGNMENTS are taken by page, then narrowed to those whose
    // message FK — if it has one — points at a message the bundle also carries.
    // The assignment rule is written as one shared predicate so the two files
    // cannot drift into disagreeing about what the bundle contains.
    tags: sql.raw(`SELECT id FROM tags WHERE "driveId" IN (${driveIn})`),
    content_tags: sql.raw(`SELECT id FROM content_tags WHERE ${contentTagWhere}`),
    channel_messages: sql.raw(`SELECT id FROM channel_messages WHERE "pageId" IN (${pageIn})`),
    channel_message_reactions: sql.raw(
      `SELECT id FROM channel_message_reactions WHERE "messageId" IN (${channelMsgIn})`
      + ` AND "userId" IN (${exportedUserIn})`,
    ),
    // The export's rule, from the shared helper: the sessions the EXPORTED
    // conversations are bound to, owned by an EXPORTED user (requested or
    // discovered) — matching `allExportedUserIdSet` on the export side.
    agent_workspaces: sql.raw(
      `SELECT id FROM agent_workspaces WHERE ${workspaceSelectionWhere(exportedUserIn, convoIn)}`,
    ),
    // The shells of those same sessions, owned by an exported user.
    agent_workspace_shells: sql.raw(
      `SELECT id FROM agent_workspace_shells WHERE "ownerId" IN (${exportedUserIn})`
      + ` AND "workspaceId" IN (SELECT id FROM agent_workspaces WHERE ${workspaceSelectionWhere(exportedUserIn, convoIn)})`,
    ),
    // The trees of those same sessions — every row, since the exporter takes a
    // workspace's nodes whole. Identity here is the COMPOUND key: node ids are
    // client-minted and unique per workspace only, so two sessions may
    // legitimately hold the same `id` and comparing on `id` alone would report
    // one of them missing. Rendering `rootId:id` as the compared value keeps
    // this a per-ROW comparison rather than the weaker count check the other
    // composite-key tables settle for.
    agent_workspace_nodes: sql.raw(
      `SELECT "rootId" || ':' || id AS id FROM agent_workspace_nodes`
      + ` WHERE "rootId" IN (SELECT id FROM agent_workspaces WHERE ${workspaceSelectionWhere(exportedUserIn, convoIn)})`,
    ),
    // The same shared predicate the exporter and `convoIn` above both use, so
    // these three can no longer disagree about what the bundle contains.
    conversations: sql.raw(
      `SELECT id FROM conversations WHERE ${conversationSelectionWhere(userIn, pageIn)}`,
    ),
    messages: sql.raw(
      `SELECT id FROM messages WHERE "conversationId" IN (${convoIn})`
      + ` AND ("userId" IS NULL OR "userId" IN (${exportedUserIn}))`,
    ),
    files: sql.raw(`SELECT id FROM files WHERE "driveId" IN (${driveIn})`),
    page_permissions: sql.raw(
      `SELECT id FROM page_permissions WHERE "pageId" IN (${pageIn})`
      + ` AND "userId" IN (${exportedUserIn})`,
    ),
    // Both endpoints, as the exporter requires. A mention pointing OUT of the
    // exported page set is deliberately not carried, so selecting on the source
    // page alone counts a row the bundle never held and fails a correct
    // migration. This one is a PAGE filter, which is why framing the previous
    // sweep as "the exporter's user filter" missed it.
    mentions: sql.raw(
      `SELECT id FROM mentions WHERE "sourcePageId" IN (${pageIn})`
      + ` AND "targetPageId" IN (${pageIn})`,
    ),
    user_mentions: sql.raw(
      `SELECT id FROM user_mentions WHERE "sourcePageId" IN (${pageIn})`
      + ` AND "targetUserId" IN (${exportedUserIn})`,
    ),
    favorites: sql.raw(`SELECT id FROM favorites WHERE "userId" IN (${userIn})`),
  };

  // Count-based queries for composite-key tables
  const countQueries: Record<string, ReturnType<typeof sql>> = {
    file_pages: sql.raw(`SELECT count(*) AS count FROM file_pages WHERE "fileId" IN (SELECT id FROM files WHERE "driveId" IN (${driveIn}))`),
    channel_read_status: sql.raw(`SELECT count(*) AS count FROM channel_read_status WHERE "userId" IN (${userIn}) AND "channelId" IN (${pageIn})`),
  };

  // Validate all tables in import order
  const tableResults: ValidationResult[] = [];

  for (const table of TABLE_IMPORT_ORDER) {
    if (idQueries[table]) {
      tableResults.push(await validateTable(sourceDb, targetDb, table, idQueries[table]));
    } else if (countQueries[table]) {
      tableResults.push(await validateTableCount(sourceDb, targetDb, table, countQueries[table]));
    }
  }

  // Validate file blobs
  const fileMismatches: { file: string; reason: string }[] = [];

  const fileStorageRows = await sourceDb.execute(
    sql.raw(`SELECT id, "storagePath" FROM files WHERE "driveId" IN (${driveIn}) AND "storagePath" IS NOT NULL`),
  );
  const fileStorageData = fileStorageRows.rows as Record<string, unknown>[];

  // ONE ARM OF THE EXPORT'S FILE SKIPPING IS NOT MIRRORED, and cannot be from
  // here: the export also skips a row whose DESTINATION path fails
  // `resolvePathWithin(outputDir/files, storagePath)`, and `validateData` is
  // not given the bundle directory, so it cannot ask that question. It is only
  // reachable once the source resolve and the source `existsSync` have both
  // passed.
  //
  // The durable fix for this whole comparison is to validate against
  // `manifest.fileChecksums` — the export's own record of exactly what it
  // carried, already written and already readable via `validateChecksums` —
  // rather than re-deriving the decision from the source database and disk.
  // That is the move the shared selection helpers made for the queries, and it
  // needs the bundle dir in `ValidateOptions`, so it belongs to a change that
  // owns that API rather than being smuggled in here.

  // A missing storage ROOT is a MISCONFIGURATION, not a per-row skip.
  //
  // `resolvePathWithin` returns null for every path under a base that does not
  // exist, so without this check a typo'd `--source-file-path` argument skips every
  // row and reports `passed: true` with zero mismatches: a green validation
  // that compared nothing. That is the false-PASS direction, which is the one
  // that hides a real problem rather than merely crying wolf.
  //
  // The target root needs no equivalent: if it is missing, every `tgtPath`
  // check already fails and each row is reported 'missing in target'.
  const fileSkips: { file: string; reason: string }[] = [];

  if (fileStorageData.length > 0 && !existsSync(sourceFileStoragePath)) {
    fileMismatches.push({
      file: sourceFileStoragePath,
      reason: 'source file storage path does not exist — nothing could be compared',
    });
  }

  for (const file of fileStorageData) {
    const storagePath = file.storagePath as string;
    // `resolvePathWithin`, not `path.join`, because that is what the EXPORT
    // uses to resolve the source blob. It returns null for `..`/`.` segments,
    // absolute paths, malformed encodings, and — the case that actually bites —
    // a symlink escaping the storage root, and the export SKIPS such a row
    // ("WARNING: skipping file with path traversal in storagePath").
    //
    // A raw join here follows the symlink, finds the file, and then faults the
    // row as 'missing in target': the bundle correctly did not carry it, and
    // the migration is reported as broken. Same class as everything else in
    // this file — the validator re-deriving a decision instead of reproducing
    // the exporter's.
    const resolvedSrc = await resolvePathWithin(sourceFileStoragePath, storagePath);
    if (!resolvedSrc) {
      console.warn(`WARNING: storagePath does not resolve inside the storage root, not compared: ${storagePath}`);
      fileSkips.push({ file: storagePath, reason: 'storagePath does not resolve inside the storage root' });
      continue;
    }
    const srcPath = resolvedSrc;
    const tgtPath = path.join(targetFileStoragePath, storagePath);

    // SOURCE FIRST. If the source blob is not on disk, tenant-export.ts skipped
    // this row outright ("WARNING: source file not found, skipping"), so the
    // bundle legitimately does not carry it and there is nothing to compare.
    //
    // Testing the TARGET first reported exactly that row as 'missing in
    // target' and failed a correct migration — the same false-failure class as
    // the query asymmetries above, in the one check that is not a query, which
    // is why sweeping the query maps did not reach it. An orphaned `files` row
    // (row present, blob long gone) is common enough that this was not
    // hypothetical.
    if (!existsSync(srcPath)) {
      console.warn(`WARNING: source file not found, not compared: ${srcPath}`);
      fileSkips.push({ file: storagePath, reason: 'source blob not on disk (the export skips these rows)' });
      continue;
    }

    if (!existsSync(tgtPath)) {
      fileMismatches.push({ file: storagePath, reason: 'missing in target' });
      continue;
    }

    const srcHash = await fileChecksum(srcPath);
    const tgtHash = await fileChecksum(tgtPath);
    if (srcHash !== tgtHash) {
      fileMismatches.push({ file: storagePath, reason: `checksum mismatch (source: ${srcHash}, target: ${tgtHash})` });
    }
  }

  const allTablesPassed = tableResults.every((r) => r.passed);
  const filesPassed = fileMismatches.length === 0;

  return {
    passed: allTablesPassed && filesPassed,
    tableResults,
    fileResults: {
      passed: filesPassed,
      mismatches: fileMismatches,
      skipped: fileSkips,
    },
  };
}

// ─── CLI entry point ──────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const sourceDatabaseUrl = getArg('source-url');
  const targetDatabaseUrl = getArg('target-url');
  const usersArg = getArg('users');
  const sourceFileStoragePath = resolveSourceStorageRoot(getArg('source-file-path'), process.env.FILE_STORAGE_PATH);
  const targetFileStoragePath = getArg('target-file-path') || './uploads';

  if (!sourceDatabaseUrl || !targetDatabaseUrl || !usersArg) {
    console.error('Usage: tenant-validate.ts --source-url ... --target-url ... --users user1,user2');
    process.exit(1);
  }

  const userIds = usersArg.split(',').map((s) => s.trim()).filter(Boolean);
  validateIds(userIds, 'user ID');

  console.log('Validating migration integrity...');

  const result = await runValidation({
    sourceDatabaseUrl,
    targetDatabaseUrl,
    userIds,
    sourceFileStoragePath,
    targetFileStoragePath,
  });

  console.log('\nValidation results:');
  for (const tr of result.tableResults) {
    const status = tr.passed ? 'PASS' : 'FAIL';
    console.log(`  [${status}] ${tr.table}: source=${tr.sourceCount}, target=${tr.targetCount}`);
    if (tr.missingIds.length > 0) {
      console.log(`    Missing IDs: ${tr.missingIds.join(', ')}`);
    }
    if (tr.extraIds.length > 0) {
      console.log(`    Extra IDs: ${tr.extraIds.join(', ')}`);
    }
  }

  if (result.fileResults.mismatches.length > 0) {
    console.log('\n  File mismatches:');
    for (const m of result.fileResults.mismatches) {
      console.log(`    ${m.file}: ${m.reason}`);
    }
  }

  // Printed even on a PASS: "0 mismatches" over 400 skipped blobs is not the
  // same result as "0 mismatches" over 400 compared ones, and the operator is
  // the only one who can tell which they meant.
  if (result.fileResults.skipped.length > 0) {
    console.log(`\n  Files not compared (${result.fileResults.skipped.length}):`);
    for (const m of result.fileResults.skipped) {
      console.log(`    ${m.file}: ${m.reason}`);
    }
  }

  if (result.passed) {
    console.log('\nMigration validated successfully');
  } else {
    console.error('\nValidation FAILED - see details above');
    process.exit(1);
  }
}

const isDirectExecution = process.argv[1]?.endsWith('tenant-validate.ts');
if (isDirectExecution) {
  main().catch((err) => {
    console.error('Validation failed:', err);
    process.exit(1);
  });
}

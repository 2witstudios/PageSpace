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
import type { ValidateOptions, ValidationResult, DbClient } from './lib/migration-types';
import { TABLE_IMPORT_ORDER } from './lib/migration-types';
import {
  fileChecksum,
  toSqlInList,
  validateIds,
  conversationSelectionWhere,
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
  };
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

  // The owners of those conversations, which is what the export scopes
  // workspaces and shells on (`allExportedUserIdSet`) — the requested users
  // PLUS the ones DISCOVERED through the page arms. Validating on the
  // requested set alone left a discovered user's workspace, and its shells'
  // `coldTail` terminal scrollback, carried but never checked.
  const convoOwnerRows = await sourceDb.execute(
    sql.raw(`SELECT DISTINCT "userId" AS id FROM conversations WHERE id IN (${convoIn})`),
  );
  const exportedUserIds = new Set<string>(userIds);
  for (const row of convoOwnerRows.rows as Record<string, unknown>[]) {
    if (row.id) exportedUserIds.add(row.id as string);
  }
  const exportedUserIn = toSqlInList(exportedUserIds);

  // ID-based queries for tables with a single PK
  const idQueries: Record<string, ReturnType<typeof sql>> = {
    users: sql.raw(`SELECT id FROM users WHERE id IN (${userIn})`),
    user_profiles: sql.raw(`SELECT "userId" AS id FROM user_profiles WHERE "userId" IN (${userIn})`),
    drives: sql.raw(`SELECT id FROM drives WHERE id IN (${driveIn})`),
    drive_roles: sql.raw(`SELECT id FROM drive_roles WHERE "driveId" IN (${driveIn})`),
    drive_members: sql.raw(`SELECT id FROM drive_members WHERE "driveId" IN (${driveIn}) AND "userId" IN (${userIn})`),
    pages: sql.raw(`SELECT id FROM pages WHERE "driveId" IN (${driveIn})`),
    tags: sql.raw(`SELECT id FROM tags WHERE id IN (SELECT DISTINCT "tagId" FROM page_tags WHERE "pageId" IN (${pageIn}))`),
    channel_messages: sql.raw(`SELECT id FROM channel_messages WHERE "pageId" IN (${pageIn})`),
    channel_message_reactions: sql.raw(`SELECT id FROM channel_message_reactions WHERE "messageId" IN (${channelMsgIn})`),
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
    messages: sql.raw(`SELECT id FROM messages WHERE "conversationId" IN (${convoIn})`),
    files: sql.raw(`SELECT id FROM files WHERE "driveId" IN (${driveIn})`),
    page_permissions: sql.raw(`SELECT id FROM page_permissions WHERE "pageId" IN (${pageIn})`),
    mentions: sql.raw(`SELECT id FROM mentions WHERE "sourcePageId" IN (${pageIn})`),
    user_mentions: sql.raw(`SELECT id FROM user_mentions WHERE "sourcePageId" IN (${pageIn})`),
    favorites: sql.raw(`SELECT id FROM favorites WHERE "userId" IN (${userIn})`),
  };

  // Count-based queries for composite-key tables
  const countQueries: Record<string, ReturnType<typeof sql>> = {
    page_tags: sql.raw(`SELECT count(*) AS count FROM page_tags WHERE "pageId" IN (${pageIn})`),
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

  for (const file of fileStorageData) {
    const storagePath = file.storagePath as string;
    const srcPath = path.join(sourceFileStoragePath, storagePath);
    const tgtPath = path.join(targetFileStoragePath, storagePath);

    if (!existsSync(tgtPath)) {
      fileMismatches.push({ file: storagePath, reason: 'missing in target' });
      continue;
    }

    if (existsSync(srcPath)) {
      const srcHash = await fileChecksum(srcPath);
      const tgtHash = await fileChecksum(tgtPath);
      if (srcHash !== tgtHash) {
        fileMismatches.push({ file: storagePath, reason: `checksum mismatch (source: ${srcHash}, target: ${tgtHash})` });
      }
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
  const sourceFileStoragePath = getArg('source-file-path') || './uploads';
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

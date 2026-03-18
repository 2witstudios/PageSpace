#!/usr/bin/env tsx
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
import type { ValidateOptions, ValidationResult } from './lib/migration-types';
import { TABLE_IMPORT_ORDER } from './lib/migration-types';
import { fileChecksum } from './lib/migration-utils';

type DbClient = ReturnType<typeof drizzle>;

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
  const sourcePool = new Pool({ connectionString: options.sourceDatabaseUrl, ssl: false });
  const targetPool = new Pool({ connectionString: options.targetDatabaseUrl, ssl: false });
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
  const userIdPlaceholders = userIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');

  // Discover drives from source
  const driveRows = await sourceDb.execute(
    sql.raw(`SELECT DISTINCT "driveId" FROM drive_members WHERE "userId" IN (${userIdPlaceholders})`),
  );
  const driveIds = (driveRows.rows as Record<string, unknown>[]).map((r) => r.driveId as string);
  const driveIdPlaceholders = driveIds.map((id) => `'${id}'`).join(', ') || "''";

  // Get page IDs from source
  const pageRows = await sourceDb.execute(
    sql.raw(`SELECT id FROM pages WHERE "driveId" IN (${driveIdPlaceholders})`),
  );
  const pageIds = (pageRows.rows as Record<string, unknown>[]).map((r) => r.id as string);
  const pageIdPlaceholders = pageIds.map((id) => `'${id}'`).join(', ') || "''";

  // Get channel message IDs for reaction validation
  const channelMsgRows = await sourceDb.execute(
    sql.raw(`SELECT id FROM channel_messages WHERE "pageId" IN (${pageIdPlaceholders})`),
  );
  const channelMsgIds = (channelMsgRows.rows as Record<string, unknown>[]).map((r) => r.id as string);
  const channelMsgIdPlaceholders = channelMsgIds.map((id) => `'${id}'`).join(', ') || "''";

  // Get conversation IDs for message validation
  const convoRows = await sourceDb.execute(
    sql.raw(`SELECT id FROM conversations WHERE "userId" IN (${userIdPlaceholders})`),
  );
  const convoIds = (convoRows.rows as Record<string, unknown>[]).map((r) => r.id as string);
  const convoIdPlaceholders = convoIds.map((id) => `'${id}'`).join(', ') || "''";

  // ID-based queries for tables with a single PK
  const idQueries: Record<string, ReturnType<typeof sql>> = {
    users: sql.raw(`SELECT id FROM users WHERE id IN (${userIdPlaceholders})`),
    user_profiles: sql.raw(`SELECT "userId" AS id FROM user_profiles WHERE "userId" IN (${userIdPlaceholders})`),
    drives: sql.raw(`SELECT id FROM drives WHERE id IN (${driveIdPlaceholders})`),
    drive_roles: sql.raw(`SELECT id FROM drive_roles WHERE "driveId" IN (${driveIdPlaceholders})`),
    drive_members: sql.raw(`SELECT id FROM drive_members WHERE "driveId" IN (${driveIdPlaceholders}) AND "userId" IN (${userIdPlaceholders})`),
    pages: sql.raw(`SELECT id FROM pages WHERE "driveId" IN (${driveIdPlaceholders})`),
    tags: sql.raw(`SELECT id FROM tags WHERE id IN (SELECT DISTINCT "tagId" FROM page_tags WHERE "pageId" IN (${pageIdPlaceholders}))`),
    chat_messages: sql.raw(`SELECT id FROM chat_messages WHERE "pageId" IN (${pageIdPlaceholders})`),
    channel_messages: sql.raw(`SELECT id FROM channel_messages WHERE "pageId" IN (${pageIdPlaceholders})`),
    channel_message_reactions: sql.raw(`SELECT id FROM channel_message_reactions WHERE "messageId" IN (${channelMsgIdPlaceholders})`),
    conversations: sql.raw(`SELECT id FROM conversations WHERE "userId" IN (${userIdPlaceholders})`),
    messages: sql.raw(`SELECT id FROM messages WHERE "conversationId" IN (${convoIdPlaceholders})`),
    files: sql.raw(`SELECT id FROM files WHERE "driveId" IN (${driveIdPlaceholders})`),
    permissions: sql.raw(`SELECT id FROM permissions WHERE "pageId" IN (${pageIdPlaceholders})`),
    page_permissions: sql.raw(`SELECT id FROM page_permissions WHERE "pageId" IN (${pageIdPlaceholders})`),
    mentions: sql.raw(`SELECT id FROM mentions WHERE "sourcePageId" IN (${pageIdPlaceholders})`),
    user_mentions: sql.raw(`SELECT id FROM user_mentions WHERE "sourcePageId" IN (${pageIdPlaceholders})`),
    favorites: sql.raw(`SELECT id FROM favorites WHERE "userId" IN (${userIdPlaceholders})`),
  };

  // Count-based queries for composite-key tables
  const countQueries: Record<string, ReturnType<typeof sql>> = {
    page_tags: sql.raw(`SELECT count(*) AS count FROM page_tags WHERE "pageId" IN (${pageIdPlaceholders})`),
    file_pages: sql.raw(`SELECT count(*) AS count FROM file_pages WHERE "fileId" IN (SELECT id FROM files WHERE "driveId" IN (${driveIdPlaceholders}))`),
    channel_read_status: sql.raw(`SELECT count(*) AS count FROM channel_read_status WHERE "userId" IN (${userIdPlaceholders}) AND "channelId" IN (${pageIdPlaceholders})`),
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
    sql.raw(`SELECT id, "storagePath" FROM files WHERE "driveId" IN (${driveIdPlaceholders}) AND "storagePath" IS NOT NULL`),
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

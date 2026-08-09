#!/usr/bin/env bun
/**
 * Tenant data export script.
 *
 * Exports a team's data from the shared PageSpace SaaS database
 * into a portable bundle (data.sql + files/ + manifest.json).
 *
 * Usage:
 *   tsx scripts/tenant-export.ts \
 *     --users user1,user2 \
 *     --output ./export-bundle/ \
 *     [--database-url postgres://...] \
 *     [--file-storage-path /data/files] \
 *     [--dry-run]
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { mkdir, writeFile, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { resolvePathWithin } from '@pagespace/lib/security/path-validator';
import type {
  ExportOptions,
  ExportManifest,
  ManifestTableCounts,
  DbClient,
} from './lib/migration-types';
import {
  buildInsert,
  buildDeferredUpdate,
  computeFileChecksum,
  writeManifest,
  toSqlInList,
  validateIds,
  conversationSelectionWhere,
} from './lib/migration-utils';
import {
  exportColumns as cols,
  deferredColumns,
} from './lib/tenant-export-columns';

// ─── Column definitions per table ──────────────────────────────
// The per-table column lists live in ./lib/tenant-export-columns.ts, and are
// checked against the live Drizzle schema by the drift guard in
// scripts/__tests__/tenant-export-columns.test.ts. Add a column to the schema
// without deciding there — carried or explicitly excluded — and that test goes
// red. Do NOT re-introduce hand-maintained lists in this file.

// ─── Query helpers ──────────────────────────────

async function queryRows(db: DbClient, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await db.execute(query);
  return result.rows as Record<string, unknown>[];
}

// ─── Export logic ──────────────────────────────

/**
 * Discover all drive IDs where any of the specified users is a member.
 */
export async function discoverDrives(
  db: DbClient,
  userIds: string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await queryRows(
    db,
    sql.raw(`SELECT DISTINCT "driveId" FROM drive_members WHERE "userId" IN (${toSqlInList(userIds)})`),
  );
  return rows.map((r) => r.driveId as string);
}

/**
 * Null out nullable FK references that point outside the export set.
 * A ref that survives into the bundle but names a row the bundle does not
 * carry aborts the whole import on its FK, so every carried FK column has to
 * be either filtered, nulled here, or provably in-set.
 */
function nullifyOrphanedRefs(
  rows: Record<string, unknown>[],
  idSet: Set<string>,
  ...columns: string[]
): void {
  for (const row of rows) {
    for (const col of columns) {
      if (row[col] && !idSet.has(row[col] as string)) {
        row[col] = null;
      }
    }
  }
}

/** Null out FK references to users not in the export set. */
const nullifyOrphanedUserRefs = nullifyOrphanedRefs;

/** Null out FK references to pages not in the export set. */
const nullifyOrphanedPageRefs = nullifyOrphanedRefs;

export interface ExportResult {
  manifest: ExportManifest;
  sqlStatements: string;
}

/**
 * Run the full export pipeline.
 * Returns the manifest and SQL content (useful for testing).
 */
export async function runExport(options: ExportOptions): Promise<ExportResult> {
  const pool = new Pool({ connectionString: options.databaseUrl });
  const db = drizzle(pool);

  try {
    return await exportData(db, options);
  } finally {
    await pool.end();
  }
}

export async function exportData(
  db: DbClient,
  options: ExportOptions,
): Promise<ExportResult> {
  const { userIds, outputDir, fileStoragePath, dryRun } = options;
  const userIdSet = new Set(userIds);

  // 1. Discover drives
  const driveIds = await discoverDrives(db, userIds);
  if (driveIds.length === 0) {
    throw new Error('No drives found for the specified users');
  }

  const driveIn = toSqlInList(driveIds);
  const userIn = toSqlInList(userIds);

  // 2. Query all data
  const usersData = await queryRows(db, sql.raw(
    `SELECT * FROM users WHERE id IN (${userIn})`,
  ));

  const userProfilesData = await queryRows(db, sql.raw(
    `SELECT * FROM user_profiles WHERE "userId" IN (${userIn})`,
  ));

  const drivesData = await queryRows(db, sql.raw(
    `SELECT * FROM drives WHERE id IN (${driveIn})`,
  ));

  const driveRolesData = await queryRows(db, sql.raw(
    `SELECT * FROM drive_roles WHERE "driveId" IN (${driveIn})`,
  ));

  const driveMembersData = await queryRows(db, sql.raw(
    `SELECT * FROM drive_members WHERE "driveId" IN (${driveIn}) AND "userId" IN (${userIn})`,
  ));
  nullifyOrphanedUserRefs(driveMembersData, userIdSet, 'invitedBy');

  const pagesData = await queryRows(db, sql.raw(
    `SELECT * FROM pages WHERE "driveId" IN (${driveIn})`,
  ));
  const pageIdSet = new Set(pagesData.map((r) => r.id as string));
  const pageIn = toSqlInList(pageIdSet);

  // Null out parentId / originalParentId if they point outside exported pages
  nullifyOrphanedPageRefs(pagesData, pageIdSet, 'parentId', 'originalParentId');

  // `drives.homePageId` / `drives.not_found_page_id` point FORWARD at pages,
  // which is why they ride a trailing UPDATE rather than the drives INSERT
  // (see `deferredColumns` in ./lib/tenant-export-columns.ts). Same orphan
  // rule as any other page ref.
  nullifyOrphanedPageRefs(drivesData, pageIdSet, 'homePageId', 'not_found_page_id');

  const channelMessagesData = await queryRows(db, sql.raw(
    `SELECT * FROM channel_messages WHERE "pageId" IN (${pageIn})`,
  ));

  /**
   * Conversations: the ones the requested users own, PLUS every conversation
   * ATTACHED TO AN EXPORTED PAGE.
   *
   * The second half is not optional. The two sets are gathered along different
   * axes — conversations by OWNER, pages by DRIVE — so a page chat started by
   * a drive member outside `userIds` would otherwise be exported as messages
   * with no parent row, and `messages.conversationId` is NOT NULL and FK'd, so
   * the import of that bundle aborts. Their owners are pulled into the user
   * set below, since `conversations.userId` is NOT NULL and FK'd too.
   *
   * The page predicate is `unifiedPageScope`'s pair, in SQL: a `type='page'`
   * thread names its page in `contextId`, a `type='client'` API thread in
   * `agentPageId`. It used to be derived from `chat_messages.pageId` — asking
   * the conversation directly is both narrower and correct now that a
   * message's page IS its conversation's page.
   *
   * The rule lives in `conversationSelectionSql` (shared with `tenant-validate`)
   * so the validator cannot drift into asking a narrower question than the
   * export answered and then print PASS for rows it never compared.
   */
  const conversationsData = await queryRows(db, sql.raw(
    `SELECT * FROM conversations WHERE ${conversationSelectionWhere(userIn, pageIn)}`,
  ));
  const conversationIds = conversationsData.map((r) => r.id as string);

  // For channel messages from non-exported users, we need to include those user records
  const referencedUserIds = new Set(userIds);
  for (const msg of channelMessagesData) {
    if (msg.userId) referencedUserIds.add(msg.userId as string);
  }
  // …and the owners of the conversations pulled in above (NOT NULL + FK'd)
  for (const conversation of conversationsData) {
    if (conversation.userId) referencedUserIds.add(conversation.userId as string);
  }

  // Fetch any additional referenced users not in original set
  const additionalUserIds = [...referencedUserIds].filter((id) => !userIdSet.has(id));
  if (additionalUserIds.length > 0) {
    const additionalUsers = await queryRows(db, sql.raw(
      `SELECT * FROM users WHERE id IN (${toSqlInList(additionalUserIds)})`,
    ));
    usersData.push(...additionalUsers);
  }

  // Strip suspension flags — these may be set as a migration read-only lock
  // on the shared instance and must not leak into the tenant
  for (const user of usersData) {
    user.suspendedAt = null;
    user.suspendedReason = null;
  }

  // Build the authoritative set of all users in the export (initial + discovered)
  const allExportedUserIdSet = new Set(usersData.map((u) => u.id as string));
  const allUserIn = toSqlInList(allExportedUserIdSet);

  // `pages.createdBy` (ON DELETE SET NULL) — the author may be a drive member
  // who is not part of this migration.
  nullifyOrphanedUserRefs(pagesData, allExportedUserIdSet, 'createdBy');

  const channelMessageIds = channelMessagesData.map((r) => r.id as string);
  const channelMessageIdSet = new Set(channelMessageIds);
  /**
   * The three channel-message self-references. `parentId` and `mirroredFromId`
   * stay inside one channel by construction, but a QUOTE can name a message in
   * a channel this migration does not carry, so all three are checked. Refs
   * that DO resolve need no ordering care: Postgres queues RI checks as
   * AFTER-ROW triggers fired once the statement finishes, so a self-reference
   * inside a single multi-row INSERT resolves regardless of row order.
   */
  nullifyOrphanedRefs(
    channelMessagesData,
    channelMessageIdSet,
    'parentId',
    'mirroredFromId',
    'quotedMessageId',
  );
  // Filter reactions to only include those from exported users (userId is NOT NULL)
  const channelReactionsDataRaw = channelMessageIds.length > 0
    ? await queryRows(db, sql.raw(
        `SELECT * FROM channel_message_reactions WHERE "messageId" IN (${toSqlInList(channelMessageIds)})`,
      ))
    : [];
  const channelReactionsData = channelReactionsDataRaw.filter(
    (r) => allExportedUserIdSet.has(r.userId as string),
  );

  const channelReadStatusData = await queryRows(db, sql.raw(
    `SELECT * FROM channel_read_status WHERE "userId" IN (${userIn}) AND "channelId" IN (${pageIn})`,
  ));

  /**
   * Agent sessions — the working contexts the exported conversations are bound
   * to (`conversations.workspaceId`).
   *
   * Carried because the binding is otherwise unrecoverable: a session owns a
   * thread's filesystem and its pane layout, and `workspaceId` is write-once by
   * design (moving a thread is a fork, never a rebind), so a migration that
   * drops it cannot be repaired afterwards. Only the sessions an exported
   * conversation actually names are pulled — a session is never empty, so
   * this is the whole set that matters — and only those whose `ownerId`
   * (NOT NULL, FK'd) is already in the export. The Sprite-identity columns do
   * NOT travel; see the exclusion allowlist in ./lib/tenant-export-columns.ts.
   */
  const referencedSessionIds = new Set(
    conversationsData
      .map((r) => r.workspaceId as string | null)
      .filter((id): id is string => Boolean(id)),
  );
  const agentSessionsDataRaw = referencedSessionIds.size > 0
    ? await queryRows(db, sql.raw(
        `SELECT * FROM agent_workspaces WHERE id IN (${toSqlInList(referencedSessionIds)})`,
      ))
    : [];
  const agentSessionsData = agentSessionsDataRaw.filter(
    (s) => allExportedUserIdSet.has(s.ownerId as string),
  );
  // A global-assistant session has no drive; a drive-scoped one whose drive is
  // outside this migration degrades to the same shape rather than dangling.
  nullifyOrphanedRefs(agentSessionsData, new Set(driveIds), 'driveId');

  // Threads bound to a session that did not make the cut become plain history
  // — exactly what `ON DELETE SET NULL` on this column already means.
  const exportedSessionIdSet = new Set(agentSessionsData.map((s) => s.id as string));
  nullifyOrphanedRefs(conversationsData, exportedSessionIdSet, 'workspaceId');

  /**
   * The sessions' TERMINALS. Scoped to the sessions that survived the owner
   * filter above, then filtered again on `ownerId`: both of this table's FKs
   * are NOT NULL with `ON DELETE CASCADE`, so unlike a conversation there is
   * no "orphan it and carry it anyway" shape — a shell whose owner is outside
   * the migration simply does not travel. In practice the second filter is a
   * no-op (a session's shells are its owner's), and it is here so that stops
   * being an assumption the export relies on silently.
   */
  const shellsDataRaw = exportedSessionIdSet.size > 0
    ? await queryRows(db, sql.raw(
        `SELECT * FROM agent_workspace_shells WHERE "workspaceId" IN (${toSqlInList(exportedSessionIdSet)})`,
      ))
    : [];
  const agentShellsData = shellsDataRaw.filter(
    (s) => allExportedUserIdSet.has(s.ownerId as string),
  );

  // `conversations.agentPageId` FKs `pages` (ON DELETE SET NULL) and is a
  // `type='client'` thread's only page link. A thread whose agent page is
  // outside the bundle becomes page-less rather than a dangling reference —
  // which reads, correctly, as an API thread that has not been used yet.
  nullifyOrphanedPageRefs(conversationsData, pageIdSet, 'agentPageId');

  // `conversations.planPageId` (the durable plan binding, PR #2359) FKs `pages`
  // the same way and for the same reason gets the same treatment — with one
  // extra motive: a plan binding may legitimately point at a page in ANOTHER
  // drive, so it is the reference most likely to fall outside a scoped bundle.
  // Nulling it unbinds the thread, which is exactly what its `ON DELETE SET
  // NULL` means, rather than failing the import on a dangling FK.
  nullifyOrphanedPageRefs(conversationsData, pageIdSet, 'planPageId');

  // Messages from exported users, plus the agent/system-authored rows.
  // `messages.userId` was relaxed to NULLABLE in 0249 (the attribution rule:
  // NULL userId = agent- or system-authored), so an `IN (…)` filter alone now
  // silently drops every agent reply from the bundle. NULL rows have no user
  // reference to dangle, so they are always safe to carry.
  const messagesData = conversationIds.length > 0
    ? await queryRows(db, sql.raw(
        `SELECT * FROM messages WHERE "conversationId" IN (${toSqlInList(conversationIds)}) AND ("userId" IS NULL OR "userId" IN (${allUserIn}))`,
      ))
    : [];
  // `messages.sourceAgentId` FKs `pages` (ON DELETE SET NULL); a value naming
  // a page the bundle does not carry would be a phantom reference in the
  // tenant. A message's own page is its conversation's, and that is nulled
  // with the conversation rows below.
  nullifyOrphanedPageRefs(messagesData, pageIdSet, 'sourceAgentId');

  const filesData = await queryRows(db, sql.raw(
    `SELECT * FROM files WHERE "driveId" IN (${driveIn})`,
  ));
  nullifyOrphanedUserRefs(filesData, allExportedUserIdSet, 'createdBy');
  const fileIds = filesData.map((r) => r.id as string);

  const filePagesData = fileIds.length > 0
    ? await queryRows(db, sql.raw(
        `SELECT * FROM file_pages WHERE "fileId" IN (${toSqlInList(fileIds)})`,
      ))
    : [];
  nullifyOrphanedUserRefs(filePagesData, allExportedUserIdSet, 'linkedBy');

  // Filter page permissions to only include exported users (userId is NOT NULL)
  const pagePermissionsData = await queryRows(db, sql.raw(
    `SELECT * FROM page_permissions WHERE "pageId" IN (${pageIn}) AND "userId" IN (${allUserIn})`,
  ));
  nullifyOrphanedUserRefs(pagePermissionsData, allExportedUserIdSet, 'grantedBy');

  // Tags referenced by exported pages
  const pageTagsData = await queryRows(db, sql.raw(
    `SELECT * FROM page_tags WHERE "pageId" IN (${pageIn})`,
  ));
  const tagIds = [...new Set(pageTagsData.map((r) => r.tagId as string))];
  const tagsData = tagIds.length > 0
    ? await queryRows(db, sql.raw(
        `SELECT * FROM tags WHERE id IN (${toSqlInList(tagIds)})`,
      ))
    : [];

  // Mentions between exported pages only
  const mentionsData = await queryRows(db, sql.raw(
    `SELECT * FROM mentions WHERE "sourcePageId" IN (${pageIn}) AND "targetPageId" IN (${pageIn})`,
  ));

  // Filter user mentions to only include exported target users (targetUserId is NOT NULL)
  const userMentionsData = await queryRows(db, sql.raw(
    `SELECT * FROM user_mentions WHERE "sourcePageId" IN (${pageIn}) AND "targetUserId" IN (${allUserIn})`,
  ));
  nullifyOrphanedUserRefs(userMentionsData, allExportedUserIdSet, 'mentionedByUserId');

  const favoritesData = await queryRows(db, sql.raw(
    `SELECT * FROM favorites WHERE "userId" IN (${userIn})`,
  ));

  // 3. Build SQL
  const sqlParts: string[] = [
    '-- PageSpace Tenant Data Export',
    `-- Exported at: ${new Date().toISOString()}`,
    `-- Users: ${userIds.join(', ')}`,
    '',
    'BEGIN;',
    '',
    buildInsert('users', cols('users'), usersData),
    buildInsert('user_profiles', cols('user_profiles'), userProfilesData),
    buildInsert('drives', cols('drives'), drivesData),
    buildInsert('drive_roles', cols('drive_roles'), driveRolesData),
    buildInsert('drive_members', cols('drive_members'), driveMembersData),
    buildInsert('pages', cols('pages'), pagesData),
    // `drives` and `pages` reference each other, so neither insert can carry
    // its forward FK. The drive's page pointers (`homePageId`,
    // `not_found_page_id`) are set here, once the pages exist.
    buildDeferredUpdate('drives', deferredColumns('drives'), drivesData),
    buildInsert('tags', cols('tags'), tagsData),
    buildInsert('page_tags', cols('page_tags'), pageTagsData),
    // `agent_workspaces` precedes `conversations`: `conversations.workspaceId`
    // FKs it, and a session row also needs its drive and owner, both above.
    buildInsert('agent_workspaces', cols('agent_workspaces'), agentSessionsData),
    // Both of this table's FKs (`workspaceId`, `ownerId`) are NOT NULL, so it
    // must follow `agent_workspaces` and `users`. It does NOT have to precede
    // `conversations` — nothing references a shell — but it sits with its
    // parent to keep the session's rows together.
    buildInsert('agent_workspace_shells', cols('agent_workspace_shells'), agentShellsData),
    // `conversations` MUST precede `messages`: the latter has a real
    // (non-deferrable) FK onto the former, and the whole bundle replays inside
    // one BEGIN/COMMIT, so an out-of-order INSERT aborts the entire import.
    // Insert order in this list is FK order, not table-name order.
    buildInsert('conversations', cols('conversations'), conversationsData),
    buildInsert('messages', cols('messages'), messagesData),
    buildInsert('channel_messages', cols('channel_messages'), channelMessagesData),
    buildInsert('channel_message_reactions', cols('channel_message_reactions'), channelReactionsData),
    buildInsert('channel_read_status', cols('channel_read_status'), channelReadStatusData),
    buildInsert('files', cols('files'), filesData),
    buildInsert('file_pages', cols('file_pages'), filePagesData),
    buildInsert('page_permissions', cols('page_permissions'), pagePermissionsData),
    buildInsert('mentions', cols('mentions'), mentionsData),
    buildInsert('user_mentions', cols('user_mentions'), userMentionsData),
    buildInsert('favorites', cols('favorites'), favoritesData),
    '',
    'COMMIT;',
    '',
  ];

  const sqlContent = sqlParts.filter(Boolean).join('\n');

  // 4. Build manifest
  const tableCounts: ManifestTableCounts = {
    users: usersData.length,
    userProfiles: userProfilesData.length,
    drives: drivesData.length,
    driveRoles: driveRolesData.length,
    driveMembers: driveMembersData.length,
    pages: pagesData.length,
    channelMessages: channelMessagesData.length,
    channelMessageReactions: channelReactionsData.length,
    channelReadStatus: channelReadStatusData.length,
    agentWorkspaces: agentSessionsData.length,
    agentWorkspaceShells: agentShellsData.length,
    conversations: conversationsData.length,
    messages: messagesData.length,
    files: filesData.length,
    filePages: filePagesData.length,
    pagePermissions: pagePermissionsData.length,
    tags: tagsData.length,
    pageTags: pageTagsData.length,
    mentions: mentionsData.length,
    userMentions: userMentionsData.length,
    favorites: favoritesData.length,
  };

  // 5. Copy file blobs and compute checksums
  const fileChecksums = [];
  let totalFileBytes = 0;

  if (!dryRun) {
    await mkdir(path.join(outputDir, 'files'), { recursive: true });
  }

  for (const file of filesData) {
    const storagePath = file.storagePath as string | null;
    if (!storagePath) continue;

    // Path containment: reject storagePath with traversal (e.g. ../../etc/passwd)
    const srcPath = await resolvePathWithin(fileStoragePath, storagePath);
    if (!srcPath) {
      console.warn(`WARNING: skipping file with path traversal in storagePath: ${storagePath}`);
      continue;
    }

    if (!existsSync(srcPath)) {
      console.warn(`WARNING: source file not found, skipping: ${srcPath}`);
      continue;
    }

    const destPath = await resolvePathWithin(path.join(outputDir, 'files'), storagePath);
    if (!destPath) {
      console.warn(`WARNING: skipping file with unsafe destination path: ${storagePath}`);
      continue;
    }

    if (!dryRun) {
      await mkdir(path.dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
    }

    const checksum = await computeFileChecksum(srcPath, storagePath);
    fileChecksums.push(checksum);
    totalFileBytes += checksum.sizeBytes;
  }

  const manifest: ExportManifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    exportedUsers: userIds,
    tableCounts,
    fileChecksums,
    totalFileBytes,
  };

  // 6. Write output
  if (!dryRun) {
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'data.sql'), sqlContent, 'utf-8');
    await writeManifest(outputDir, manifest);
  }

  return { manifest, sqlStatements: sqlContent };
}

// ─── CLI entry point ──────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const usersArg = getArg('users');
  const outputDir = getArg('output');
  const databaseUrl = getArg('database-url') || process.env.DATABASE_URL;
  const fileStoragePath = getArg('file-storage-path') || process.env.FILE_STORAGE_PATH || './uploads';
  const dryRun = args.includes('--dry-run');

  if (!usersArg || !outputDir) {
    console.error('Usage: tenant-export.ts --users user1,user2 --output ./bundle/ [--database-url ...] [--dry-run]');
    process.exit(1);
  }

  if (!databaseUrl) {
    console.error('Error: --database-url or DATABASE_URL env var required');
    process.exit(1);
  }

  const userIds = usersArg.split(',').map((s) => s.trim()).filter(Boolean);
  validateIds(userIds, 'user ID');

  console.log(`Exporting data for ${userIds.length} users...`);
  if (dryRun) console.log('[DRY RUN] No files will be written.');

  const result = await runExport({
    userIds,
    outputDir,
    fileStoragePath,
    databaseUrl,
    dryRun,
  });

  console.log('\nExport summary:');
  for (const [table, count] of Object.entries(result.manifest.tableCounts)) {
    if (count > 0) console.log(`  ${table}: ${count} rows`);
  }
  console.log(`  Files: ${result.manifest.fileChecksums.length} (${result.manifest.totalFileBytes} bytes)`);

  if (!dryRun) {
    console.log(`\nBundle written to: ${outputDir}`);
  }
}

// Only run CLI when executed directly
const isDirectExecution = process.argv[1]?.endsWith('tenant-export.ts');
if (isDirectExecution) {
  main().catch((err) => {
    console.error('Export failed:', err);
    process.exit(1);
  });
}

#!/usr/bin/env tsx
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
import { resolvePathWithin } from '@pagespace/lib/security';
import type {
  ExportOptions,
  ExportManifest,
  ManifestTableCounts,
  DbClient,
} from './lib/migration-types';
import {
  buildInsert,
  computeFileChecksum,
  writeManifest,
  toSqlInList,
  validateIds,
} from './lib/migration-utils';

// ─── Column definitions per table ──────────────────────────────
// WARNING: These column lists must stay in sync with the Drizzle schema
// in packages/db/src/schema/. If a column is added or renamed in the
// schema, update the corresponding array here. A mismatch will cause
// data loss (missing column) or an import error (extra column).

const USER_COLUMNS = [
  'id', 'name', 'email', 'emailVerified', 'image',
  'googleId', 'appleId', 'provider', 'tokenVersion', 'role',
  'adminRoleVersion', 'currentAiProvider', 'currentAiModel',
  'storageUsedBytes', 'activeUploads', 'lastStorageCalculated',
  'stripeCustomerId', 'subscriptionTier', 'tosAcceptedAt',
  'failedLoginAttempts', 'lockedUntil', 'suspendedAt', 'suspendedReason',
  'timezone', 'createdAt', 'updatedAt',
];

const USER_PROFILE_COLUMNS = [
  'userId', 'username', 'displayName', 'bio', 'avatarUrl', 'isPublic',
  'createdAt', 'updatedAt',
];

const DRIVE_COLUMNS = [
  'id', 'name', 'slug', 'ownerId', 'isTrashed', 'trashedAt',
  'createdAt', 'updatedAt', 'drivePrompt',
];

const DRIVE_ROLE_COLUMNS = [
  'id', 'driveId', 'name', 'description', 'color', 'isDefault',
  'permissions', 'position', 'createdAt', 'updatedAt',
];

const DRIVE_MEMBER_COLUMNS = [
  'id', 'driveId', 'userId', 'role', 'customRoleId', 'invitedBy',
  'invitedAt', 'acceptedAt', 'lastAccessedAt',
];

const PAGE_COLUMNS = [
  'id', 'title', 'type', 'content', 'contentMode', 'isPaginated',
  'position', 'isTrashed', 'aiProvider', 'aiModel', 'systemPrompt',
  'enabledTools', 'includeDrivePrompt', 'agentDefinition',
  'visibleToGlobalAssistant', 'includePageTree', 'pageTreeScope',
  'fileSize', 'mimeType', 'originalFileName', 'filePath', 'fileMetadata',
  'processingStatus', 'processingError', 'processedAt', 'extractionMethod',
  'extractionMetadata', 'contentHash', 'excludeFromSearch',
  'createdAt', 'updatedAt', 'trashedAt', 'revision', 'stateHash',
  'driveId', 'parentId', 'originalParentId',
];

const CHAT_MESSAGE_COLUMNS = [
  'id', 'pageId', 'conversationId', 'role', 'content', 'toolCalls',
  'toolResults', 'createdAt', 'isActive', 'editedAt', 'userId',
  'sourceAgentId', 'messageType',
];

const CHANNEL_MESSAGE_COLUMNS = [
  'id', 'content', 'createdAt', 'pageId', 'userId', 'fileId',
  'attachmentMeta', 'isActive', 'aiMeta',
];

const CHANNEL_REACTION_COLUMNS = [
  'id', 'messageId', 'userId', 'emoji', 'createdAt',
];

const CHANNEL_READ_STATUS_COLUMNS = ['userId', 'channelId', 'lastReadAt'];

const CONVERSATION_COLUMNS = [
  'id', 'userId', 'title', 'type', 'contextId', 'lastMessageAt',
  'createdAt', 'updatedAt', 'isActive',
];

const MESSAGE_COLUMNS = [
  'id', 'conversationId', 'userId', 'role', 'messageType', 'content',
  'toolCalls', 'toolResults', 'createdAt', 'isActive', 'editedAt',
];

const FILE_COLUMNS = [
  'id', 'driveId', 'sizeBytes', 'mimeType', 'storagePath',
  'checksumVersion', 'createdAt', 'updatedAt', 'createdBy',
  'lastAccessedAt',
];

const FILE_PAGE_COLUMNS = ['fileId', 'pageId', 'linkedBy', 'linkedAt', 'linkSource'];

const PERMISSION_COLUMNS = [
  'id', 'action', 'subjectType', 'subjectId', 'pageId', 'createdAt',
];

const PAGE_PERMISSION_COLUMNS = [
  'id', 'pageId', 'userId', 'canView', 'canEdit', 'canShare',
  'canDelete', 'grantedBy', 'grantedAt', 'expiresAt', 'note',
];

const TAG_COLUMNS = ['id', 'name', 'color'];
const PAGE_TAG_COLUMNS = ['pageId', 'tagId'];

const MENTION_COLUMNS = ['id', 'createdAt', 'sourcePageId', 'targetPageId'];
const USER_MENTION_COLUMNS = [
  'id', 'createdAt', 'sourcePageId', 'targetUserId', 'mentionedByUserId',
];

const FAVORITE_COLUMNS = [
  'id', 'userId', 'itemType', 'pageId', 'driveId', 'position', 'createdAt',
];

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
 * Null out FK references to users not in the export set.
 */
function nullifyOrphanedUserRefs(
  rows: Record<string, unknown>[],
  userIdSet: Set<string>,
  ...columns: string[]
): void {
  for (const row of rows) {
    for (const col of columns) {
      if (row[col] && !userIdSet.has(row[col] as string)) {
        row[col] = null;
      }
    }
  }
}

/**
 * Null out FK references to pages not in the export set.
 */
function nullifyOrphanedPageRefs(
  rows: Record<string, unknown>[],
  pageIdSet: Set<string>,
  ...columns: string[]
): void {
  for (const row of rows) {
    for (const col of columns) {
      if (row[col] && !pageIdSet.has(row[col] as string)) {
        row[col] = null;
      }
    }
  }
}

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

  const chatMessagesData = await queryRows(db, sql.raw(
    `SELECT * FROM chat_messages WHERE "pageId" IN (${pageIn})`,
  ));
  nullifyOrphanedUserRefs(chatMessagesData, userIdSet, 'userId');
  nullifyOrphanedPageRefs(chatMessagesData, pageIdSet, 'sourceAgentId');

  const channelMessagesData = await queryRows(db, sql.raw(
    `SELECT * FROM channel_messages WHERE "pageId" IN (${pageIn})`,
  ));

  // For channel messages from non-exported users, we need to include those user records
  const referencedUserIds = new Set(userIds);
  for (const msg of channelMessagesData) {
    if (msg.userId) referencedUserIds.add(msg.userId as string);
  }
  // Also check chatMessages userId
  for (const msg of chatMessagesData) {
    if (msg.userId) referencedUserIds.add(msg.userId as string);
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

  const channelMessageIds = channelMessagesData.map((r) => r.id as string);
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

  const conversationsData = await queryRows(db, sql.raw(
    `SELECT * FROM conversations WHERE "userId" IN (${userIn})`,
  ));
  const conversationIds = conversationsData.map((r) => r.id as string);

  // Filter messages to only include those from exported users (userId is NOT NULL)
  const messagesData = conversationIds.length > 0
    ? await queryRows(db, sql.raw(
        `SELECT * FROM messages WHERE "conversationId" IN (${toSqlInList(conversationIds)}) AND "userId" IN (${allUserIn})`,
      ))
    : [];

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

  const permissionsData = await queryRows(db, sql.raw(
    `SELECT * FROM permissions WHERE "pageId" IN (${pageIn})`,
  ));

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
    buildInsert('users', USER_COLUMNS, usersData),
    buildInsert('user_profiles', USER_PROFILE_COLUMNS, userProfilesData),
    buildInsert('drives', DRIVE_COLUMNS, drivesData),
    buildInsert('drive_roles', DRIVE_ROLE_COLUMNS, driveRolesData),
    buildInsert('drive_members', DRIVE_MEMBER_COLUMNS, driveMembersData),
    buildInsert('pages', PAGE_COLUMNS, pagesData),
    buildInsert('tags', TAG_COLUMNS, tagsData),
    buildInsert('page_tags', PAGE_TAG_COLUMNS, pageTagsData),
    buildInsert('chat_messages', CHAT_MESSAGE_COLUMNS, chatMessagesData),
    buildInsert('channel_messages', CHANNEL_MESSAGE_COLUMNS, channelMessagesData),
    buildInsert('channel_message_reactions', CHANNEL_REACTION_COLUMNS, channelReactionsData),
    buildInsert('channel_read_status', CHANNEL_READ_STATUS_COLUMNS, channelReadStatusData),
    buildInsert('conversations', CONVERSATION_COLUMNS, conversationsData),
    buildInsert('messages', MESSAGE_COLUMNS, messagesData),
    buildInsert('files', FILE_COLUMNS, filesData),
    buildInsert('file_pages', FILE_PAGE_COLUMNS, filePagesData),
    buildInsert('permissions', PERMISSION_COLUMNS, permissionsData),
    buildInsert('page_permissions', PAGE_PERMISSION_COLUMNS, pagePermissionsData),
    buildInsert('mentions', MENTION_COLUMNS, mentionsData),
    buildInsert('user_mentions', USER_MENTION_COLUMNS, userMentionsData),
    buildInsert('favorites', FAVORITE_COLUMNS, favoritesData),
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
    chatMessages: chatMessagesData.length,
    channelMessages: channelMessagesData.length,
    channelMessageReactions: channelReactionsData.length,
    channelReadStatus: channelReadStatusData.length,
    conversations: conversationsData.length,
    messages: messagesData.length,
    files: filesData.length,
    filePages: filePagesData.length,
    permissions: permissionsData.length,
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

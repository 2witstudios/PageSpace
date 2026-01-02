import {
  pgTable,
  text,
  timestamp,
  integer,
  real,
  jsonb,
  boolean,
  pgEnum,
  index,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { pages, drives } from './core';
import { users } from './auth';
import { contentFormatEnum, activityChangeGroupTypeEnum } from './monitoring';

export const pageVersionSourceEnum = pgEnum('page_version_source', [
  'manual',
  'auto',
  'pre_ai',
  'pre_restore',
  'restore',
  'system',
]);

export const driveBackupSourceEnum = pgEnum('drive_backup_source', [
  'manual',
  'scheduled',
  'pre_restore',
  'system',
]);

export const driveBackupStatusEnum = pgEnum('drive_backup_status', [
  'pending',
  'ready',
  'failed',
]);

// ============================================================================
// Retention Policy Configuration
// ============================================================================

/**
 * Default retention period for page versions and drive backups.
 * Versions are automatically retained for at least 30 days.
 * Pinned versions (isPinned = true) are exempt from expiration.
 */
export const DEFAULT_VERSION_RETENTION_DAYS = 30;

/**
 * Calculates the expiration date for a version based on retention policy.
 *
 * @param createdAt - The creation date of the version (defaults to now)
 * @param retentionDays - Number of days to retain the version (defaults to 30)
 * @returns The expiration date
 *
 * @example
 * ```typescript
 * // Using default retention (30 days from now)
 * const expiresAt = calculateVersionExpiresAt();
 *
 * // Using custom creation date
 * const expiresAt = calculateVersionExpiresAt(new Date('2024-01-15'));
 *
 * // Using custom retention period
 * const expiresAt = calculateVersionExpiresAt(new Date(), 90);
 * ```
 */
export function calculateVersionExpiresAt(
  createdAt: Date = new Date(),
  retentionDays: number = DEFAULT_VERSION_RETENTION_DAYS
): Date {
  const expiresAt = new Date(createdAt);
  expiresAt.setDate(expiresAt.getDate() + retentionDays);
  return expiresAt;
}

// ============================================================================
// Metadata Type Definitions
// ============================================================================

/**
 * Compression metadata stored in pageVersions.metadata JSONB field.
 * This tracks how content was stored for version storage optimization.
 *
 * @see packages/lib/src/services/page-version-service.ts for usage
 */
export interface VersionCompressionMetadata {
  /** Whether the content was compressed */
  compressed: boolean;
  /** Original content size in bytes */
  originalSize: number;
  /** Stored size in bytes (may be smaller if compressed) */
  storedSize: number;
  /** Compression ratio (storedSize / originalSize), 1.0 if not compressed */
  compressionRatio: number;
}

/**
 * Full metadata schema for page versions.
 * Used to document the structure of the metadata JSONB field.
 *
 * @example
 * ```typescript
 * const metadata: PageVersionMetadata = {
 *   compression: {
 *     compressed: true,
 *     originalSize: 15000,
 *     storedSize: 4500,
 *     compressionRatio: 0.3,
 *   },
 *   // Additional custom metadata fields can be added here
 * };
 * ```
 */
export interface PageVersionMetadata {
  /** Compression information for version content */
  compression?: VersionCompressionMetadata;
  /** Additional custom metadata fields */
  [key: string]: unknown;
}

/**
 * Metadata schema for drive backups.
 * Used to document the structure of the metadata JSONB field.
 */
export interface DriveBackupMetadata {
  /** Number of pages included in the backup */
  pageCount?: number;
  /** Total size of all page content in bytes */
  totalContentSize?: number;
  /** Additional custom metadata fields */
  [key: string]: unknown;
}

export const pageVersions = pgTable('page_versions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  createdBy: text('createdBy').references(() => users.id, { onDelete: 'set null' }),
  source: pageVersionSourceEnum('source').notNull().default('auto'),
  label: text('label'),
  reason: text('reason'),
  changeGroupId: text('changeGroupId'),
  changeGroupType: activityChangeGroupTypeEnum('changeGroupType'),
  contentRef: text('contentRef'),
  contentFormat: contentFormatEnum('contentFormat'),
  contentSize: integer('contentSize'),
  stateHash: text('stateHash'),
  pageRevision: integer('pageRevision').notNull().default(0),
  isPinned: boolean('isPinned').default(false).notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date' }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => ({
  pageCreatedAtIdx: index('page_versions_page_created_at_idx').on(table.pageId, table.createdAt),
  driveCreatedAtIdx: index('page_versions_drive_created_at_idx').on(table.driveId, table.createdAt),
  pinnedIdx: index('page_versions_pinned_idx').on(table.isPinned),
  changeGroupPair: check('page_versions_change_group_pair', sql`(${table.changeGroupId} IS NULL) = (${table.changeGroupType} IS NULL)`),
}));

export const driveBackups = pgTable('drive_backups', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  createdBy: text('createdBy').references(() => users.id, { onDelete: 'set null' }),
  source: driveBackupSourceEnum('source').notNull().default('manual'),
  status: driveBackupStatusEnum('status').notNull().default('pending'),
  label: text('label'),
  reason: text('reason'),
  changeGroupId: text('changeGroupId'),
  changeGroupType: activityChangeGroupTypeEnum('changeGroupType'),
  isPinned: boolean('isPinned').default(false).notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date' }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  completedAt: timestamp('completedAt', { mode: 'date' }),
  failedAt: timestamp('failedAt', { mode: 'date' }),
  failureReason: text('failureReason'),
}, (table) => ({
  driveCreatedAtIdx: index('drive_backups_drive_created_at_idx').on(table.driveId, table.createdAt),
  statusIdx: index('drive_backups_status_idx').on(table.status),
  changeGroupPair: check('drive_backups_change_group_pair', sql`(${table.changeGroupId} IS NULL) = (${table.changeGroupType} IS NULL)`),
}));

export const driveBackupPages = pgTable('drive_backup_pages', {
  backupId: text('backupId')
    .notNull()
    .references(() => driveBackups.id, { onDelete: 'cascade' }),
  pageId: text('pageId').notNull(),
  pageVersionId: text('pageVersionId').references(() => pageVersions.id, { onDelete: 'set null' }),
  title: text('title'),
  type: text('type'),
  parentId: text('parentId'),
  originalParentId: text('originalParentId'),
  position: real('position'),
  isTrashed: boolean('isTrashed').default(false).notNull(),
  trashedAt: timestamp('trashedAt', { mode: 'date' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.backupId, table.pageId] }),
  backupIdx: index('drive_backup_pages_backup_idx').on(table.backupId),
}));

export const driveBackupPermissions = pgTable('drive_backup_permissions', {
  backupId: text('backupId')
    .notNull()
    .references(() => driveBackups.id, { onDelete: 'cascade' }),
  pageId: text('pageId').notNull(),
  userId: text('userId').notNull(),
  canView: boolean('canView').default(true).notNull(),
  canEdit: boolean('canEdit').default(false).notNull(),
  canShare: boolean('canShare').default(false).notNull(),
  canDelete: boolean('canDelete').default(false).notNull(),
  grantedBy: text('grantedBy'),
  note: text('note'),
  expiresAt: timestamp('expiresAt', { mode: 'date' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.backupId, table.pageId, table.userId] }),
  backupIdx: index('drive_backup_permissions_backup_idx').on(table.backupId),
}));

export const driveBackupMembers = pgTable('drive_backup_members', {
  backupId: text('backupId')
    .notNull()
    .references(() => driveBackups.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull(),
  role: text('role'),
  customRoleId: text('customRoleId'),
  invitedBy: text('invitedBy'),
  invitedAt: timestamp('invitedAt', { mode: 'date' }),
  acceptedAt: timestamp('acceptedAt', { mode: 'date' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.backupId, table.userId] }),
  backupIdx: index('drive_backup_members_backup_idx').on(table.backupId),
}));

export const driveBackupRoles = pgTable('drive_backup_roles', {
  backupId: text('backupId')
    .notNull()
    .references(() => driveBackups.id, { onDelete: 'cascade' }),
  roleId: text('roleId').notNull(),
  name: text('name'),
  description: text('description'),
  color: text('color'),
  isDefault: boolean('isDefault').default(false).notNull(),
  permissions: jsonb('permissions'),
  position: real('position'),
}, (table) => ({
  pk: primaryKey({ columns: [table.backupId, table.roleId] }),
  backupIdx: index('drive_backup_roles_backup_idx').on(table.backupId),
}));

export const driveBackupFiles = pgTable('drive_backup_files', {
  backupId: text('backupId')
    .notNull()
    .references(() => driveBackups.id, { onDelete: 'cascade' }),
  fileId: text('fileId').notNull(),
  storagePath: text('storagePath'),
  sizeBytes: integer('sizeBytes'),
  mimeType: text('mimeType'),
  checksumVersion: integer('checksumVersion'),
}, (table) => ({
  pk: primaryKey({ columns: [table.backupId, table.fileId] }),
  backupIdx: index('drive_backup_files_backup_idx').on(table.backupId),
}));

export const pageVersionsRelations = relations(pageVersions, ({ one }) => ({
  page: one(pages, {
    fields: [pageVersions.pageId],
    references: [pages.id],
  }),
  drive: one(drives, {
    fields: [pageVersions.driveId],
    references: [drives.id],
  }),
  creator: one(users, {
    fields: [pageVersions.createdBy],
    references: [users.id],
  }),
}));

export const driveBackupsRelations = relations(driveBackups, ({ one }) => ({
  drive: one(drives, {
    fields: [driveBackups.driveId],
    references: [drives.id],
  }),
  creator: one(users, {
    fields: [driveBackups.createdBy],
    references: [users.id],
  }),
}));

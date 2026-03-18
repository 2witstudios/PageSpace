import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Drizzle database client type (schema-agnostic) */
export type DbClient = NodePgDatabase<Record<string, never>>;

/** Row counts per table in the export bundle */
export interface ManifestTableCounts {
  users: number;
  userProfiles: number;
  drives: number;
  driveRoles: number;
  driveMembers: number;
  pages: number;
  chatMessages: number;
  channelMessages: number;
  channelMessageReactions: number;
  channelReadStatus: number;
  conversations: number;
  messages: number;
  files: number;
  filePages: number;
  permissions: number;
  pagePermissions: number;
  tags: number;
  pageTags: number;
  mentions: number;
  userMentions: number;
  favorites: number;
}

/** Checksum entry for a file blob */
export interface FileChecksum {
  /** Relative path within the files/ directory */
  path: string;
  /** SHA-256 hex digest */
  sha256: string;
  /** Size in bytes */
  sizeBytes: number;
}

/** The manifest.json written into the export bundle */
export interface ExportManifest {
  version: 1;
  exportedAt: string;
  exportedUsers: string[];
  tableCounts: ManifestTableCounts;
  fileChecksums: FileChecksum[];
  totalFileBytes: number;
}

/** Options for the export script */
export interface ExportOptions {
  /** cuid2 IDs of users to export */
  userIds: string[];
  /** Directory to write the export bundle */
  outputDir: string;
  /** Path to file storage root (FILE_STORAGE_PATH) */
  fileStoragePath: string;
  /** Database URL to connect to */
  databaseUrl: string;
  /** If true, report what would be exported without writing */
  dryRun: boolean;
}

/** Options for the import script */
export interface ImportOptions {
  /** Directory containing the export bundle */
  bundleDir: string;
  /** Database URL of the target tenant */
  databaseUrl: string;
  /** Target file storage path */
  fileStoragePath: string;
  /** If true, report what would be imported without writing */
  dryRun: boolean;
}

/** Options for the validation script */
export interface ValidateOptions {
  /** Database URL of the source (shared) database */
  sourceDatabaseUrl: string;
  /** Database URL of the target (tenant) database */
  targetDatabaseUrl: string;
  /** User IDs that were migrated */
  userIds: string[];
  /** Source file storage path */
  sourceFileStoragePath: string;
  /** Target file storage path */
  targetFileStoragePath: string;
}

/** Result of a validation check */
export interface ValidationResult {
  passed: boolean;
  table: string;
  sourceCount: number;
  targetCount: number;
  missingIds: string[];
  extraIds: string[];
}

/** The ordered list of tables for import (FK dependency order) */
export const TABLE_IMPORT_ORDER = [
  'users',
  'user_profiles',
  'drives',
  'drive_roles',
  'drive_members',
  'pages',
  'tags',
  'page_tags',
  'chat_messages',
  'channel_messages',
  'channel_message_reactions',
  'channel_read_status',
  'conversations',
  'messages',
  'files',
  'file_pages',
  'permissions',
  'page_permissions',
  'mentions',
  'user_mentions',
  'favorites',
] as const;

export type ExportTableName = (typeof TABLE_IMPORT_ORDER)[number];

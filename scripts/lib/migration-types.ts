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
  channelMessages: number;
  channelMessageReactions: number;
  channelReadStatus: number;
  agentWorkspaces: number;
  agentWorkspaceShells: number;
  agentWorkspaceNodes: number;
  conversations: number;
  messages: number;
  files: number;
  filePages: number;
  pagePermissions: number;
  tags: number;
  contentTags: number;
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

/**
 * THE SET OF TABLES A TENANT BUNDLE CARRIES.
 *
 * Despite the name, this is consumed as a SET, not as a sequence: the column
 * registry (`tenant-export-columns.ts`) keys off it, the drift guard enumerates
 * it, and `tenant-validate` iterates it to decide what to compare. Nothing
 * emits SQL in this order.
 *
 * THE ACTUAL INSERT ORDER IS `tenant-export.ts`'s sequence of `buildInsert`
 * calls, and it differs: the exporter emits `agent_workspaces` →
 * `agent_workspace_shells` → `conversations` → `messages` BEFORE the
 * `channel_*` tables, while this list has the channel tables first. Both orders
 * satisfy the FKs, so nothing is broken today — but the ordering comments below
 * describe FK dependencies rather than the emitted sequence, and a future
 * reader who trusts this list as insert order will be wrong. Change the
 * exporter to change insert order; changing this list changes only what is
 * carried and checked.
 */
export const TABLE_IMPORT_ORDER = [
  'users',
  'user_profiles',
  'drives',
  'drive_roles',
  'drive_members',
  'pages',
  'tags',
  'channel_messages',
  'channel_message_reactions',
  'channel_read_status',
  // The sessions themselves. This used to sit before `conversations` because
  // `conversations.workspaceId` FK'd it; that column is gone and nothing on a
  // conversation row references a session any more, so the position is
  // convention — a session still needs its `drives` and `users` rows, both
  // above.
  'agent_workspaces',
  // Immediately after its parent: `agent_workspace_shells.workspaceId` FKs
  // `agent_workspaces` and `ownerId` FKs `users`, both already inserted. The
  // shells carry a session's TERMINAL work — the tab names, the per-shell
  // command, and `coldTail`, the scrollback of the last dead incarnation —
  // which is user content with no other home in the bundle.
  'agent_workspace_shells',
  // A session's TREE, which is also its MEMBERSHIP: a thread is in a workspace
  // exactly when a chat-bound node names it. `rootId` FKs `agent_workspaces`,
  // so it follows its parent. Its `targetId` — the conversation, shell or page
  // a pane shows — is polymorphic and carries NO foreign key, so nothing here
  // constrains it against `conversations`, `agent_workspace_shells` or `pages`;
  // out-of-bundle targets are unbound by the exporter instead (tenant-export.ts).
  'agent_workspace_nodes',
  'conversations',
  'messages',
  // The tag ASSIGNMENTS, which replaced `page_tags` (dead since migration 0000,
  // dropped with the content-tags epic). It has to sit here rather than beside
  // `tags`: a row can FK `channel_messages` OR `messages`, so it follows both.
  'content_tags',
  'files',
  'file_pages',
  'page_permissions',
  'mentions',
  'user_mentions',
  'favorites',
] as const;

export type ExportTableName = (typeof TABLE_IMPORT_ORDER)[number];

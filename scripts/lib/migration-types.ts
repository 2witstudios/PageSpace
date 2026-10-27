import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Drizzle database client type (schema-agnostic) */
export type DbClient = NodePgDatabase<Record<string, never>>;

/** `org_member_departures` → `orgMemberDepartures`: the manifest's key for a table. */
export type SnakeToCamel<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<SnakeToCamel<Tail>>}`
  : S;

/** Row counts per table in the export bundle, one per carried table. */
export type ManifestTableCounts = Record<SnakeToCamel<ExportTableName>, number>;

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
 * THE TABLES A TENANT BUNDLE CARRIES, IN THE ORDER THE BUNDLE INSERTS THEM.
 *
 * This is both the set (the column registry keys off it, the drift guard
 * enumerates it, `tenant-validate` iterates it) and the sequence:
 * `tenant-export.ts` emits one INSERT per entry, in this order, inside the
 * bundle's single BEGIN/COMMIT. Every foreign key between carried tables must
 * point BACKWARDS in this list — `tenant-export-columns.test.ts` derives that
 * from the Drizzle schema — except the ones a table spec declares as
 * `deferredColumns` (emitted as a trailing UPDATE) and a table's references to
 * itself (resolved at the end of its own multi-row INSERT).
 */
export const TABLE_IMPORT_ORDER = [
  'users',
  'user_profiles',
  // Before `drives`: `drives.orgId` is a RESTRICT FK onto it, and its own
  // `ownerId` onto `users` is already satisfied above.
  'organizations',
  'drives',
  'drive_roles',
  'drive_members',
  'pages',
  // Before `channel_messages`: a message's `fileId` FKs `files`.
  'files',
  'file_pages',
  'tags',
  // A session needs its `drives` and `users` rows; nothing on a conversation
  // references it any more, so sitting before `conversations` is convention.
  'agent_workspaces',
  // `workspaceId` FKs `agent_workspaces`, `ownerId` FKs `users`. The shells
  // carry a session's TERMINAL work — the tab names, the per-shell command,
  // and `coldTail`, the scrollback of the last dead incarnation — which is
  // user content with no other home in the bundle.
  'agent_workspace_shells',
  // A session's TREE, which is also its MEMBERSHIP: a thread is in a workspace
  // exactly when a chat-bound node names it. `rootId` FKs `agent_workspaces`.
  // Its `targetId` is polymorphic with NO foreign key; out-of-bundle targets
  // are unbound by the exporter instead (tenant-export.ts).
  'agent_workspace_nodes',
  // `messages.conversationId` is a real (non-deferrable) FK onto it.
  'conversations',
  'messages',
  'channel_messages',
  'channel_message_reactions',
  'channel_read_status',
  // The tag ASSIGNMENTS: a row can FK `channel_messages` OR `messages`, so it
  // follows both.
  'content_tags',
  'page_permissions',
  'mentions',
  'user_mentions',
  'favorites',
  // Organizations & Wallets (Spec X-3). Each follows `organizations`, `users`
  // and `drives`; which rows travel is scripts/lib/org-wallet-selection.ts.
  'org_members',
  'org_invitations',
  'org_subscriptions',
  'org_subscription_funding',
  'org_domains',
  'org_member_departures',
  'org_departure_suppressions',
  'org_guest_holds',
  'drive_join_requests',
  // `parentWalletId` is a self-FK, resolved within the one INSERT.
  'wallets',
  'wallet_funding_legs',
  'wallet_consumer_caps',
  'wallet_debt_notices',
  'wallet_cap_alerts',
  'drive_spend_overrides',
  'automation_skip_notices',
] as const;

export type ExportTableName = (typeof TABLE_IMPORT_ORDER)[number];

/**
 * The tenant export's COLUMN REGISTRY — the single source of truth for which
 * columns of which tables a tenant migration bundle carries.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The export builds hand-written `INSERT` statements, so every column it
 * carries has to be named somewhere. That list is a forced copy of the Drizzle
 * schema, and a forced copy drifts: a column added in
 * `packages/db/src/schema/` and not added here is dropped by the export
 * SILENTLY — the bundle imports cleanly and the data is simply gone. That had
 * already happened to eighteen columns across six tables by the time this
 * registry was introduced (users' blind index, the drives' publishing
 * settings, pages' agent/privacy flags, channel threading, the whole
 * conversation⇄session binding, and the unified messages' attribution).
 *
 * So the registry is paired with a drift guard —
 * `scripts/__tests__/tenant-export-columns.test.ts` — which derives the
 * expected column set from the Drizzle table objects at runtime and fails when
 * the two disagree in EITHER direction. A new schema column therefore cannot
 * reach `master` without someone deciding, here, whether the tenant gets it.
 *
 * THE RULE
 * --------
 * For every table in `TABLE_IMPORT_ORDER`, every column of the corresponding
 * Drizzle table must appear in exactly one of:
 *
 *   - `columns`          — carried, emitted in that table's INSERT.
 *   - `deferredColumns`  — carried, but emitted as a trailing UPDATE because
 *                          the column FKs FORWARD to a table inserted later.
 *   - `excluded`         — deliberately NOT carried, with a stated reason.
 *
 * `excluded` is an allowlist on purpose: dropping a column from a tenant
 * migration must be a decision someone wrote down, never an omission nobody
 * noticed.
 *
 * SCOPE NOTE: this registry guards the columns of the tables the export
 * carries. It says nothing about which TABLES are carried — that set is
 * `TABLE_IMPORT_ORDER`, and widening it is a separate, deliberate act.
 */
import type { ExportTableName } from './migration-types';

export interface TableColumnSpec {
  /** Columns emitted inline in this table's `INSERT`. */
  columns: readonly string[];
  /**
   * Columns that are carried but CANNOT be emitted in the INSERT because they
   * reference a table that is inserted later (a forward FK). They are emitted
   * as a trailing `UPDATE ... WHERE id = ...` once the referenced table has
   * landed. Keyed off the table's `id`, so only single-PK tables can use this.
   */
  deferredColumns?: readonly string[];
  /**
   * Columns deliberately left out of the bundle: column name → the reason.
   * Every entry is a decision; the drift guard requires a non-empty reason.
   */
  excluded?: Readonly<Record<string, string>>;
}

/**
 * Sprite identity and per-sandbox accounting on `agent_workspaces`. All of it
 * describes a VM in the SOURCE instance's fleet, which the tenant has no
 * access to and must never believe it owns. Left unset, the migrated session
 * row reads as "never provisioned" (`sandboxId IS NULL`), so the tenant lazily
 * provisions its own Sprite on first use — exactly the state a fresh session
 * is born in — and the orphan reconciler's live-sprite predicate
 * (`sandboxId IS NOT NULL AND spriteTornDownAt IS NULL`) never selects it.
 */
const AGENT_WORKSPACE_SPRITE_EXCLUSIONS: Record<string, string> = {
  spriteKey: 'Sprite provisioning key in the SOURCE fleet — meaningless to the tenant, which derives its own.',
  sandboxId: 'Names a Sprite in the SOURCE fleet; carrying it would point the tenant at a VM it does not own.',
  spriteInstanceId: 'Identity of a SOURCE-fleet Sprite instance — every teardown CAS keys on it, so a stale value is actively dangerous.',
  egressPolicyToken: 'Proof of an egress lockdown confirmed for a SOURCE-fleet VM; unprovable and unusable in the tenant.',
  teardownRequestedAt: 'Teardown intent against a SOURCE-fleet Sprite that the tenant will never see.',
  spriteTornDownAt: 'Records the death of a SOURCE-fleet Sprite; with no `sandboxId` carried there is nothing for it to describe.',
  storageLastBilledAt: 'Billing watermark for the SOURCE instance. Defaults to now() in the tenant so the first reconcile bills forward, never retroactively.',
  storageMeasuredBytes: 'Measurement of a SOURCE-fleet filesystem that does not exist in the tenant; NULL correctly means "never measured".',
  storageMeasuredAt: 'Timestamp of that same SOURCE-fleet measurement.',
};

export const TENANT_EXPORT_COLUMNS: Readonly<Record<ExportTableName, TableColumnSpec>> = {
  users: {
    columns: [
      'id', 'name', 'email', 'emailBidx', 'emailVerified', 'image',
      'googleId', 'appleId', 'provider', 'tokenVersion', 'role',
      'adminRoleVersion', 'currentAiProvider', 'currentAiModel',
      'imageGenerationModel', 'storageUsedBytes', 'activeUploads',
      'lastStorageCalculated',
      'stripeCustomerId', 'subscriptionTier', 'tosAcceptedAt',
      'failedLoginAttempts', 'lockedUntil', 'suspendedAt', 'suspendedReason',
      'timezone', 'createdAt', 'updatedAt',
    ],
    // NOTE: `suspendedAt`/`suspendedReason` are carried but ZEROED by the
    // exporter — they may hold the migration's own read-only lock. That is a
    // value transform, not an exclusion: the columns still travel.
  },

  user_profiles: {
    columns: [
      'userId', 'username', 'displayName', 'bio', 'avatarUrl', 'isPublic',
      'createdAt', 'updatedAt',
    ],
  },

  drives: {
    columns: [
      'id', 'name', 'slug', 'ownerId', 'kind', 'isTrashed', 'trashedAt',
      'createdAt', 'updatedAt', 'drivePrompt', 'publishSubdomain',
      'publish_default_og_image_url', 'publish_favicon_url',
    ],
    /**
     * Both point at `pages`, which is inserted AFTER `drives` (pages.driveId
     * points back the other way, so the two tables are mutually referential
     * and no insert order satisfies both). Emitted as an UPDATE once the
     * pages have landed.
     */
    deferredColumns: ['homePageId', 'not_found_page_id'],
  },

  drive_roles: {
    columns: [
      'id', 'driveId', 'name', 'description', 'color', 'isDefault',
      'permissions', 'drive_wide_permissions', 'position', 'createdAt', 'updatedAt',
    ],
  },

  drive_members: {
    columns: [
      'id', 'driveId', 'userId', 'role', 'customRoleId', 'invitedBy',
      'invitedAt', 'acceptedAt', 'lastAccessedAt',
    ],
  },

  pages: {
    columns: [
      'id', 'title', 'type', 'content', 'contentMode', 'isPaginated',
      'position', 'isTrashed', 'aiProvider', 'aiModel', 'systemPrompt',
      'enabledTools', 'includeDrivePrompt', 'agentDefinition',
      'visibleToGlobalAssistant', 'includePageTree', 'pageTreeScope',
      'toolExposureMode', 'sandboxEnabled', 'userScopedAccess', 'description',
      'fileSize', 'mimeType', 'originalFileName', 'filePath', 'fileMetadata',
      'processingStatus', 'processingError', 'processedAt', 'extractionMethod',
      'extractionMetadata', 'contentHash', 'excludeFromSearch', 'isPrivate',
      'createdBy', 'createdAt', 'updatedAt', 'trashedAt', 'revision', 'stateHash',
      'driveId', 'parentId', 'originalParentId',
    ],
  },

  tags: { columns: ['id', 'name', 'color'] },

  page_tags: { columns: ['pageId', 'tagId'] },

  channel_messages: {
    columns: [
      'id', 'content', 'createdAt', 'pageId', 'userId', 'fileId',
      'attachmentMeta', 'isActive', 'editedAt', 'aiMeta',
      'parentId', 'replyCount', 'lastReplyAt', 'mirroredFromId', 'quotedMessageId',
    ],
    // The three self-references (`parentId`, `mirroredFromId`,
    // `quotedMessageId`) resolve inside the table's own multi-row INSERT —
    // Postgres queues RI checks as AFTER-ROW triggers that fire once the
    // statement completes, so order within the VALUES list is irrelevant.
    // Refs that leave the exported set are nulled by the exporter.
  },

  channel_message_reactions: {
    columns: ['id', 'messageId', 'userId', 'emoji', 'createdAt'],
  },

  channel_read_status: { columns: ['userId', 'channelId', 'lastReadAt'] },

  // KNOWN GAP (stated, not silent): the pane grid used to ride along in this
  // table's `workspaceState` jsonb. That column was dropped at the
  // agent-session SSoT epic's Phase 3 contract step and the grid now lives in
  // `agent_workspace_pane_columns` / `agent_workspace_panes`, which are NOT
  // in `TABLE_IMPORT_ORDER` — so a tenant bundle no longer carries pane
  // LAYOUT. Nothing is orphaned by that: every conversation and shell in the
  // session is carried and still bound (`conversations.workspaceId`), so the
  // migrated user gets their threads with a fresh default grid instead of
  // their arrangement. Closing it means WIDENING the carried table set, which
  // this registry deliberately does not do on its own (see SCOPE NOTE above).
  agent_workspaces: {
    columns: [
      'id', 'driveId', 'ownerId', 'name',
      'lastActiveAt', 'endedAt', 'createdAt', 'updatedAt',
    ],
    excluded: AGENT_WORKSPACE_SPRITE_EXCLUSIONS,
  },

  conversations: {
    columns: [
      'id', 'userId', 'title', 'type', 'contextId', 'agentPageId', 'workspaceId',
      'closedInWorkspaceAt', 'rev', 'lastMessageAt',
      'createdAt', 'updatedAt', 'isActive', 'isShared',
    ],
  },

  messages: {
    columns: [
      'id', 'conversationId', 'userId', 'role', 'messageType', 'content',
      'toolCalls', 'toolResults', 'createdAt', 'isActive', 'editedAt', 'status',
      'sourceAgentId',
    ],
  },

  files: {
    columns: [
      'id', 'driveId', 'sizeBytes', 'mimeType', 'storagePath',
      'checksumVersion', 'createdAt', 'updatedAt', 'createdBy',
      'lastAccessedAt',
    ],
  },

  file_pages: {
    columns: ['fileId', 'pageId', 'linkedBy', 'linkedAt', 'linkSource'],
  },

  page_permissions: {
    columns: [
      'id', 'pageId', 'userId', 'canView', 'canEdit', 'canShare',
      'canDelete', 'grantedBy', 'grantedAt', 'expiresAt', 'note',
    ],
  },

  mentions: {
    columns: ['id', 'createdAt', 'sourcePageId', 'targetPageId'],
  },

  user_mentions: {
    columns: ['id', 'createdAt', 'sourcePageId', 'targetUserId', 'mentionedByUserId'],
  },

  favorites: {
    columns: ['id', 'userId', 'itemType', 'pageId', 'driveId', 'position', 'createdAt'],
  },
};

/** The columns emitted inline in `table`'s INSERT. */
export function exportColumns(table: ExportTableName): readonly string[] {
  return TENANT_EXPORT_COLUMNS[table].columns;
}

/** The columns of `table` emitted as a trailing UPDATE (forward FKs). */
export function deferredColumns(table: ExportTableName): readonly string[] {
  return TENANT_EXPORT_COLUMNS[table].deferredColumns ?? [];
}

/** Every column of `table` the bundle carries, however it is emitted. */
export function carriedColumns(table: ExportTableName): readonly string[] {
  return [...exportColumns(table), ...deferredColumns(table)];
}

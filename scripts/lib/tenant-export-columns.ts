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
 * SCOPE NOTE: `TENANT_EXPORT_COLUMNS` guards the COLUMNS of the tables the
 * export carries. Which TABLES are carried is `TABLE_IMPORT_ORDER`, and
 * widening that is a separate, deliberate act — but "deliberate" used to mean
 * "nobody wrote anything down", which is how `agent_workspace_shells` came to
 * be dropped from tenant bundles while the GDPR export carried it. So the
 * second registry below, `TENANT_EXPORT_EXCLUDED_TABLES`, does for tables what
 * `excluded` does for columns, over the one region where an omission is a data
 * loss rather than a non-decision: the agent-session FK closure.
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
      'timezone', 'createdAt', 'updatedAt', 'starterSkillsInstalledAt',
    ],
    // `starterSkillsInstalledAt` is the starter-skill install stamp (PR #2359).
    // It MUST travel: the skills themselves are ordinary pages and personal
    // `commands` rows, which the bundle already carries, so a tenant arriving
    // with the stamp cleared would have Home provisioning seed a second copy of
    // every starter skill on top of the user's own edited ones.
    //
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

  // The pane grid used to ride along in this table's `workspaceState` jsonb,
  // then in four `agent_workspace_pane_*` / `_layout_*` tables. All of it is
  // gone: a workspace's tree is `agent_workspace_nodes`, and that table is
  // where BOTH its arrangement and its MEMBERSHIP now live. It is not yet
  // registered either way — see the note above
  // `TENANT_EXPORT_EXCLUDED_TABLES`.
  agent_workspaces: {
    columns: [
      'id', 'driveId', 'ownerId', 'name',
      'lastActiveAt', 'endedAt', 'createdAt', 'updatedAt',
    ],
    excluded: AGENT_WORKSPACE_SPRITE_EXCLUSIONS,
  },

  /**
   * A session's TERMINALS. Everything here is either the user's own naming of
   * their workspace (`name`, `command`, `agentType`) or their own output:
   * `coldTail` is the scrollback tail of the shell's last dead incarnation,
   * with `coldTailHasOutput` carried alongside it because an empty tail is
   * ambiguous on its own (a burst larger than the ring buffer also leaves it
   * empty, and "the shell was screaming" must not migrate as "the shell was
   * silent").
   *
   * No Sprite/storage accounting lives on this table — unlike its parent it
   * has exactly one source-fleet reference, `spriteExecId`, excluded below on
   * the same grounds as `AGENT_WORKSPACE_SPRITE_EXCLUSIONS`.
   */
  agent_workspace_shells: {
    columns: [
      'id', 'workspaceId', 'ownerId', 'name', 'agentType', 'command',
      'coldTail', 'coldTailAt', 'coldTailHasOutput', 'createdAt', 'updatedAt',
    ],
    excluded: {
      spriteExecId:
        'Names an exec session on a SOURCE-fleet Sprite. The parent session migrates with `sandboxId` NULL (never provisioned), so a carried exec id would address a PTY inside a VM the tenant does not own; NULL correctly means "not attached", which is what the reattach path already expects of a cold shell.',
    },
  },

  conversations: {
    columns: [
      'id', 'userId', 'title', 'type', 'contextId', 'agentPageId',
      'rev', 'planPageId', 'lastMessageAt',
      'createdAt', 'updatedAt', 'isActive', 'isShared',
    ],
    // `planPageId` travels, but like `agentPageId` it is nulled by the exporter
    // when the plan page is outside the bundle (tenant-export.ts) — a binding
    // may point into a drive the migration does not carry.
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

/**
 * TABLES in the agent-session FK closure that the bundle deliberately does NOT
 * carry — the table-level twin of a column `excluded` entry.
 *
 * The paired guard (`scripts/__tests__/tenant-export-columns.test.ts`) derives
 * the closure from the Drizzle schema at runtime: every table reachable by
 * foreign key from `agent_workspaces` or `conversations` must be either in
 * `TABLE_IMPORT_ORDER` or keyed here with a reason. A new child table of a
 * session or a thread therefore cannot reach `master` without someone deciding
 * whether a migrating user takes it with them.
 *
 * WHY THIS CLOSURE AND NOT THE WHOLE SCHEMA. A table-level decision is only
 * meaningful where the bundle already carries the parent: those are the rows
 * whose absence is silent DATA LOSS for a user who did migrate, rather than a
 * feature the bundle was never scoped to. That is exactly the region this
 * epic's own tables live in, and it is the region where the loss had already
 * happened — `agent_workspace_shells` was carried by the GDPR export and
 * dropped by the tenant one. (`packages/lib/src/compliance/export/gdpr-export-coverage.ts`
 * is the whole-schema analogue for Art 15; the two answer different questions
 * and are allowed to differ — see `ai_stream_sessions` below.)
 */
export const TENANT_EXPORT_EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  /**
   * The Art 15 export DOES carry this table (`stream-state.json`), and that is
   * not an inconsistency: "every byte about you that exists" and "the state a
   * working instance should be reconstituted from" are different questions.
   */
  ai_stream_sessions:
    'A per-instance STREAMING CHECKPOINT, not a durable record: `parts` is the debounced replay buffer a reconnecting client resumes from, and a completed turn is committed to `messages`, which the bundle carries. Every other column names SOURCE-instance runtime — `stream_id` (the in-process abort-registry key, UNIQUE-indexed, so a carried duplicate also collides), `browser_session_id`, `last_heartbeat_at`, `abort_requested_at`, `raw_parts_count` (a replay cursor with no live multicast to count against). Carrying a `status = streaming` row would manufacture a phantom live stream in the tenant that no worker will ever finish and no abort can reach.',

  /*
   * `agent_workspace_pane_columns`, `agent_workspace_panes`,
   * `agent_workspace_layout_revs` and `agent_workspace_layout_ops` WERE
   * EXCLUDED HERE. All four tables are dropped — the two-level pane grid they
   * held is replaced by `agent_workspace_nodes` — so there is nothing left to
   * decide about them.
   *
   * **`agent_workspace_nodes` and `agent_workspace_node_revs` are UNDECIDED,
   * and the table guard below is red because of it.** That is deliberate, and
   * it predates the column drop above: the node model landed without
   * registering its own tables here, and nobody has since chosen whether a
   * tenant bundle carries a workspace's tree.
   *
   * The choice is not the formality it was for the pane tables. Those held
   * ARRANGEMENT only, so dropping them cost a user their column widths. This
   * table holds MEMBERSHIP — a conversation is in a workspace exactly when a
   * node of that workspace is bound to it — so a bundle without it hands the
   * migrated user workspaces that list no threads at all, with the threads
   * themselves present but reachable only through past-conversation history.
   * Carrying it is not a copy either: `targetId` is polymorphic with NO foreign
   * key, so every node naming a conversation, page or shell outside the bundle
   * has to be pruned or unbound on the way out, and the table's global
   * `UNIQUE (targetId) WHERE targetKind = 'chat'` turns a mistake there into a
   * failed import rather than a bad row. That is a real piece of export logic,
   * not a registry line, which is why this note names the decision instead of
   * pretending to have made it.
   */
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

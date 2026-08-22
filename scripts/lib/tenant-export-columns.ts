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
      'toolExposureMode', 'sandboxEnabled', 'userScopedAccess', 'siteMode', 'description',
      'fileSize', 'mimeType', 'originalFileName', 'filePath', 'fileMetadata',
      'processingStatus', 'processingError', 'processedAt', 'extractionMethod',
      'extractionMetadata', 'contentHash', 'excludeFromSearch', 'isPrivate',
      'createdBy', 'createdAt', 'updatedAt', 'trashedAt', 'revision', 'stateHash',
      'driveId', 'parentId', 'originalParentId',
    ],
  },

  // The drive-scoped tag VOCABULARY (reclaimed from the never-written 0000
  // table). `normalizedKey` is carried rather than recomputed on import: it is
  // what `UNIQUE (driveId, normalizedKey)` is taken on, and recomputing it in
  // the importer would put a second implementation of `tagKey()` in the tenant
  // pipeline, free to disagree with the one that wrote the rows.
  tags: {
    columns: [
      'id', 'driveId', 'name', 'normalizedKey', 'color', 'description',
      'createdBy', 'createdAt', 'updatedAt',
    ],
  },

  // The tag ASSIGNMENTS. `pageId` is notNull on every row regardless of target
  // kind, so the exporter's page filter reaches all five kinds uniformly.
  content_tags: {
    columns: [
      'id', 'tagId', 'pageId', 'targetKind', 'anchor', 'anchorStatus',
      'channelMessageId', 'aiMessageId', 'source', 'confidence',
      'createdBy', 'createdAt', 'updatedAt',
    ],
  },

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
  // where BOTH its arrangement and its MEMBERSHIP now live. It travels — see
  // its own spec below, and the note above `TENANT_EXPORT_EXCLUDED_TABLES`.
  agent_workspaces: {
    columns: [
      'id', 'driveId', 'ownerId', 'name',
      'lastActiveAt', 'endedAt', 'createdAt', 'updatedAt',
    ],
    excluded: {
      ...AGENT_WORKSPACE_SPRITE_EXCLUSIONS,
      envId:
        'Names a `drive_envs` row — a PERSISTENT per-drive machine — and the bundle does not carry that table, so a carried value would reference a row the tenant has no INSERT for. The column is nullable and NULL is the ephemeral-session default, which is also the state a box-bound session correctly lands in on a substrate that holds no boxes: it keeps its history and provisions its own Sprite on next use. NOT a permanent decision — `drive_envs` ships dark and empty in this release (epic "Deliberate Per-Drive Environments", Phase 1), and the phase that gives boxes a writer is the one that must decide whether they travel, at which point this entry becomes a carried column and a table spec instead of an exclusion. Note the table is outside the FK closure the paired guard derives (it references `drives`, not `agent_workspaces`), so nothing else will raise the question — it is recorded here deliberately.',
    },
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

  /**
   * A session's TREE — and, since this epic merged the two structures, its
   * MEMBERSHIP: a thread is in a workspace exactly when a chat-bound node names
   * it. Every column is carried; there is nothing here that describes the
   * SOURCE instance, which is what the exclusions on the two tables above are
   * about.
   *
   * `targetId` is polymorphic with NO foreign key, so the exporter's referential
   * rules cannot see what it names — a node whose conversation, shell or page
   * is outside the bundle is UNBOUND on the way out (both `targetKind` and
   * `targetId` set to NULL, never one of them), which is the same treatment
   * `conversations.agentPageId`/`planPageId` get and lands on a state the model
   * spells natively: an unbound pane rendering the picker. The whole rule, and
   * why unbinding rather than pruning, is in `tenant-export.ts`.
   */
  agent_workspace_nodes: {
    columns: [
      'id', 'rootId', 'parentId', 'position', 'nodeType', 'axis', 'fraction',
      'targetKind', 'targetId', 'createdAt', 'updatedAt',
    ],
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
    //
    // NO membership exclusion any more. `workspaceId` / `closedInWorkspaceAt`
    // were pinned here while they still existed; migration 0256 dropped them,
    // and membership travels as a chat-bound node in `agent_workspace_nodes`,
    // which IS carried. There is no second answer left to exclude.
  },

  messages: {
    columns: [
      'id', 'conversationId', 'userId', 'role', 'messageType', 'content',
      'toolCalls', 'toolResults', 'createdAt', 'isActive', 'editedAt', 'status',
      'sourceAgentId',
      // Carried, not excluded: `source` is how a turn is known to have been
      // spoken rather than typed, and the thread renders a microphone from it.
      // A tenant that migrated without it would keep every word and silently
      // lose the account of how they were said — the same "thread that changes
      // its account of itself" this column exists to prevent.
      'source',
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
 *
 * THE TEST THIS REGION IS ALLOWED TO APPLY, stated once so the next decision
 * does not have to be re-derived from the two entries below. A table in the
 * closure is EXCLUDED only when its rows describe the SOURCE INSTANCE rather
 * than the user: a Sprite in a fleet the tenant has no access to, a stream a
 * worker in another deployment is midway through, a counter issued by another
 * database. Everything else — anything a user would notice the absence of on
 * the morning after their migration — travels. `agent_workspace_nodes` is the
 * clearest case of the second kind and is carried for exactly that reason; it
 * spent one release UNDECIDED here, and the cost of that was not theoretical:
 * `conversations.workspaceId` carried membership until `0256` dropped it, so
 * the same non-decision that used to cost a user their pane WIDTHS came to cost
 * them every thread's membership instead, silently, with the bundle still
 * importing cleanly.
 */
export const TENANT_EXPORT_EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  /**
   * The Art 15 export DOES carry this table (`stream-state.json`), and that is
   * not an inconsistency: "every byte about you that exists" and "the state a
   * working instance should be reconstituted from" are different questions.
   */
  ai_stream_sessions:
    'A per-instance STREAMING CHECKPOINT, not a durable record: `parts` is the debounced replay buffer a reconnecting client resumes from, and a completed turn is committed to `messages`, which the bundle carries. Every other column names SOURCE-instance runtime — `stream_id` (the in-process abort-registry key, UNIQUE-indexed, so a carried duplicate also collides), `browser_session_id`, `last_heartbeat_at`, `abort_requested_at`, `raw_parts_count` (a replay cursor with no live multicast to count against). Carrying a `status = streaming` row would manufacture a phantom live stream in the tenant that no worker will ever finish and no abort can reach.',

  /**
   * Excluded for the same reason as `ai_stream_sessions`, and it has to be: it is
   * the successor to that table's `parts` column, so a decision that differed
   * would carry the same content the row above is excluded for refusing.
   *
   * The Art 15 export DOES carry this one too
   * (`packages/lib/src/compliance/export/gdpr-export-coverage.ts`), the same
   * deliberate asymmetry the note above `ai_stream_sessions` describes — "every
   * byte about you that exists" and "the state a working instance should be
   * reconstituted from" are different questions.
   */
  ai_stream_frames:
    'The append-only FRAME LOG of a generation in flight — the durable form of `ai_stream_sessions.parts`, and excluded for the identical reason. Its rows exist only between a stream starting and its assistant message being committed, at which point they are deleted; a completed turn lives in `messages`, which the bundle carries. So a row present at export time is by definition a turn the SOURCE instance was midway through, and no worker in the tenant will ever finish it. Its `message_id` also references an assistant placeholder that the exporting instance wrote best-effort, so carried frames can arrive naming a message the bundle has no row for.',

  /*
   * The four `agent_workspace_pane_*` / `_layout_*` tables used to be excluded
   * here, on the grounds that ARRANGEMENT was not worth the bundle weight.
   * Migration 0256 dropped all four, so there is nothing left to exclude. Why
   * their successor `agent_workspace_nodes` is CARRIED instead is in the note
   * above this object — arrangement and membership became one table, and
   * membership always travelled.
   */

  /**
   * The rev's own table, deliberately left behind — the ONE thing in the node
   * model that is about the DATABASE rather than about the user.
   *
   * `rev` is a per-workspace monotonic mutation counter minted by
   * `INSERT … ON CONFLICT ("rootId") DO UPDATE SET rev = rev + 1` in the
   * transaction that writes the nodes, and it is meaningful only against the
   * instance that issued it: a client holds it as `baseRev` and every write is
   * refused unless the server's rev still matches. Carrying a foreign counter
   * would have a tenant's first write compare a `baseRev` against a number
   * another database counted, which is not a bigger or smaller number so much
   * as a number about something else.
   *
   * Absent, the read is already correct rather than merely tolerable, and by
   * construction: `readWorkspaceNodeSnapshots` FULL OUTER JOINs the two tables
   * and `COALESCE(r."rev", 0)`s exactly so that a workspace with node rows and
   * no rev row reads as `{rev: 0, nodes: […]}` — the tree present, the counter
   * fresh — instead of reading as empty. That shape exists because the backfill
   * produces it; an import is simply its second producer. The tenant's first
   * write then mints rev 1, which is the state a workspace is born in.
   */
  agent_workspace_node_revs:
    'A per-WORKSPACE monotonic mutation counter (`rev`), issued by the SOURCE database and meaningful only against it: clients hold it as `baseRev` for optimistic concurrency, so a carried value would have the tenant compare a client\'s base against a number another database counted. Its absence is a state the read path already handles exactly — `readWorkspaceNodeSnapshots` FULL OUTER JOINs and `COALESCE(rev, 0)`s so a workspace with nodes and no rev row reads as its tree at rev 0 — and the tenant\'s first write mints rev 1, which is where a fresh workspace starts.',

  /**
   * The three published-app hosting tables are the clearest case yet of the rule
   * stated above this object: their rows describe the SOURCE INSTANCE'S FLY
   * ACCOUNT, not the user.
   *
   * A `published_apps` row is a pointer to infrastructure — `flyAppName`,
   * `machineId`, `networkName`, `imageDigest` — that exists inside one Fly
   * organization, reachable only with that org's token. Carried into a tenant, a
   * row names an app the tenant's credentials get 403 on and its reaper can never
   * stop, while the SOURCE keeps billing for the real one. Worse, the tenant's own
   * teardown would then enqueue a reclaim for an app it does not own.
   *
   * This is not the "arrangement vs membership" trap the note above warns about:
   * nothing a user would notice is being left behind. The user's CONTENT — the
   * pages, and the environment the row keys on via `envId` — travels normally;
   * what does not travel is the hosting deployment, which the tenant re-publishes
   * from that same env to create a real app on its own infrastructure.
   */
  published_apps:
    'A pointer to a Fly app inside the SOURCE deployment\'s Fly ORGANIZATION: `flyAppName`, `machineId`, `networkName` and `imageDigest` all name resources reachable only with that org\'s token. Carried into a tenant, the row describes an app the tenant cannot start, stop, reach or destroy (403 on every call), while the source instance keeps billing for the real one — and the tenant\'s own teardown would enqueue a reclaim against another organization\'s app. The environment it points at (`envId`) travels normally; only the hosting deployment is left behind, and re-publishing that env in the tenant creates a real app on its own infrastructure.',

  app_deploy_token_mints:
    'The audit trail of Fly deploy tokens minted for apps in the SOURCE deployment\'s Fly organization, and meaningless without them: every row points at a `published_apps` row the bundle deliberately does not carry, and at a credential scoped to an app the tenant has no access to. Fly returns no token id, so these rows exist purely so the SOURCE can answer "what did we mint and when" — a question about the source\'s own security posture, not about the user. Carrying them would import an audit history for credentials that were never issued in the destination.',

  app_hosting_reclaims:
    'The FK-FREE teardown OUTBOX: each row is an instruction to DESTROY a Fly app in the SOURCE deployment\'s organization, held until the kill is confirmed. It is the one table in the schema where carrying a row is actively dangerous rather than merely useless — an imported reclaim would have the tenant\'s drain cron repeatedly attempt to destroy an app belonging to another organization, and a row that can never be confirmed dead is never removed, so the outbox would accumulate permanently stuck entries that look exactly like the billing anomaly it exists to alert on.',
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

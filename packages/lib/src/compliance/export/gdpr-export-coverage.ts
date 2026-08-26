/**
 * The Art 15 export's TABLE REGISTRY — one recorded decision per table in the
 * schema: does the subject access export carry it, or not, and why.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `gdpr-export.ts` is a hand-written list of collectors. Nothing connected that
 * list to the schema, so a table added to `packages/db/src/schema/` simply
 * never appeared in anybody's export, and the omission was invisible: the ZIP
 * still built, the route test still passed, and the data was silently absent
 * from every subject access request.
 *
 * That is not hypothetical. The epic "Agent-Session Single Source of Truth"
 * moved a large amount of user work into `agent_workspaces`,
 * `agent_workspace_shells` and `ai_stream_sessions`, and no collector followed
 * it — so the export answered LESS after the epic than before it, in a product
 * where the workspace and its shells ARE the work. Erasure, meanwhile, already
 * reached all three (the `users` cascade plus the `purge-stream-state` step).
 * We were deleting on demand what we would not disclose on demand. The route
 * test made it worse rather than better: it asserted the CURRENT category list,
 * so it pinned the omission in place instead of catching it.
 *
 * So the registry is paired with a drift guard —
 * `gdpr-export-coverage.test.ts` — which enumerates the Drizzle table objects
 * AT RUNTIME (the technique `scripts/__tests__/tenant-export-columns.test.ts`
 * already uses for the tenant bundle) and fails when a table is in neither
 * list, or is in both, or is excluded without a stated reason. A new table
 * carrying user data therefore cannot reach `master` without someone deciding,
 * HERE, whether a subject access request returns it.
 *
 * THE RULE
 * --------
 * Every `pgTable` exported from `@pagespace/db/schema` appears in exactly one
 * of:
 *
 *   - `EXPORTED_TABLES`  — some collector in `gdpr-export.ts` reads it, and
 *                          the value names the `AllUserData` category it lands
 *                          in, so the mapping is auditable rather than implied.
 *   - `EXCLUDED_TABLES`  — deliberately not carried, with a stated reason.
 *
 * `EXCLUDED_TABLES` is an allowlist on purpose. Leaving a subject's data out of
 * their own export must be a decision someone wrote down, never an omission
 * nobody noticed — and the reason has to survive being read by a regulator, not
 * just by us.
 */

import type { AllUserData } from './gdpr-export';

/** An `AllUserData` key, i.e. a file in the native bundle. */
export type ExportCategory = keyof AllUserData;

/**
 * Table → the export category its rows land in. The value is checked against
 * `AllUserData`'s keys by the type system, so a renamed category breaks the
 * build rather than quietly mislabelling the registry.
 */
export const EXPORTED_TABLES: Readonly<Record<string, ExportCategory>> = {
  users: 'profile',
  drives: 'drives',
  drive_members: 'drives',
  pages: 'pages',
  sheet_tabs: 'sheets',
  sheet_rows: 'sheets',
  channel_messages: 'messages',
  conversations: 'messages',
  messages: 'messages',
  direct_messages: 'messages',
  dm_conversations: 'messages',
  files: 'files',
  activity_logs: 'activity',
  system_logs: 'systemLogs',
  api_metrics: 'apiMetrics',
  error_logs: 'errorLogs',
  error_resolutions: 'errorLogs',
  ai_usage_logs: 'aiUsage',
  task_lists: 'tasks',
  task_items: 'tasks',
  sessions: 'sessions',
  notifications: 'notifications',
  display_preferences: 'displayPreferences',
  user_personalization: 'personalization',
  // Machine-authored inferences ABOUT the subject, plus verbatim quotes of
  // their own messages kept as justification — derived personal data under
  // Art 4(1). Exported including rejected and still-pending rows: "we inferred
  // this about you and did not act on it" is exactly the processing a subject
  // access request exists to disclose.
  personalization_candidates: 'personalizationCandidates',
  // Art 15(3) is a right to a COPY, not to visibility. These were excluded on
  // the reasoning that the subject can read them in Settings — see the
  // `settings` collector for why that was not a basis (review finding).
  user_hotkey_preferences: 'settings',
  user_automation_preferences: 'settings',
  user_toast_notification_preferences: 'settings',
  email_notification_preferences: 'settings',
  // Added with this guard — the omission that motivated it.
  agent_workspaces: 'agentWorkspaces',
  agent_workspace_shells: 'agentWorkspaces',
  // The subject's workspace MEMBERSHIP and layout. It arrived unregistered
  // with the node model, and it became load-bearing when membership moved into
  // it: which threads a workspace holds, and where each one sits, is a fact
  // about the subject's own working context. It used to live in
  // `conversations.workspaceId` (exported under `collectUserMessages`'s
  // boundary); nothing writes that column any more and this table is the only
  // witness — migration 0256 dropped that column, so the table is not merely
  // the better source, it is the only one.
  agent_workspace_nodes: 'agentWorkspaces',
  ai_stream_sessions: 'streamState',
  // The durable frame log — the same generated content `ai_stream_sessions.parts`
  // holds, in the form that replaces it once the frame-log writer lands and that
  // column is dropped. Registered WITH its collector at the moment the table was
  // added rather than when its writer arrives, because a table that reaches
  // `master` unexported is precisely the failure this registry exists to catch,
  // and "nothing writes it yet" is a state that expires quietly. Read by
  // `collectUserStreamState`, which owns the Art 15(4) boundary for both tables.
  ai_stream_frames: 'streamState',
  // The subject's own acts of classification: `createdBy` is the person who
  // applied the tag, and for an anchored tag the row carries the passage they
  // selected. The VOCABULARY (`tags`) stays organisation-owned below — the word
  // belongs to the drive, the act of applying it belongs to the person — so the
  // collector joins the name in rather than exporting an opaque id.
  content_tags: 'contentTags',
};

/**
 * Credential and token material. Exporting a LIVE secret would hand an
 * attacker who obtains the bundle (a mailbox, a shared download link) exactly
 * the thing the secret protects — so the security cost of disclosure exceeds
 * the transparency gain, and Art 15(4)'s "rights and freedoms of others"
 * squarely covers it. The FACT of a credential existing is disclosed where it
 * is meaningful: `sessions.json` carries the subject's authentication sessions
 * with device, IP and revocation state, secrets excluded.
 */
const CREDENTIAL_MATERIAL =
  'Live credential/token material — disclosing it in a downloadable bundle would compromise the account it protects; the sessions category discloses the existence and metadata of the subject\'s credentials without the secrets.';

/**
 * Rows that describe OUR infrastructure rather than the subject: fleet
 * pointers, delivery cursors, queue and cache state. They are about how the
 * service runs, not about the person.
 */
const SERVICE_INFRASTRUCTURE =
  'Service infrastructure state (fleet pointers, delivery cursors, queue/cache bookkeeping) — describes how PageSpace runs, not the data subject; carries no content authored by or about them.';

/**
 * Configuration and catalogue rows owned by a DRIVE or by the platform, not by
 * any individual. A drive's roles, its backups, its published pages and the
 * integration catalogue are the controller's or the drive owner's records; a
 * member's own participation in them is already exported under `drives`.
 */
const ORGANISATION_OWNED =
  'Owned by a drive or by the platform, not by the individual — the subject\'s own participation is exported under the drives/pages categories, and the container\'s configuration is another party\'s record.';

/**
 * Content whose SUBSTANCE is already exported through another category, where
 * carrying this table too would only duplicate rows under a second name.
 */
const DUPLICATE_OF_EXPORTED =
  'The substance of these rows is already carried by another export category; a second copy under a different name would add no information to the subject access response.';

/**
 * Derived, ephemeral or reconstructable state with no independent record of
 * the subject's activity: caches, counters, revision heads, transient intents.
 */
const DERIVED_OR_EPHEMERAL =
  'Derived, ephemeral or reconstructable state (caches, counters, revision heads, transient intents) — holds no record of the subject\'s activity that the exported categories do not already hold.';

function withReason(reason: string, ...tables: string[]): Record<string, string> {
  return Object.fromEntries(tables.map((table) => [table, reason]));
}

/**
 * Tables deliberately NOT carried by the Art 15 export, each with the reason
 * that decision was made. The drift guard requires the reason to be
 * substantive, so "n/a" cannot be used to smuggle a table past review.
 */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  ...withReason(
    CREDENTIAL_MATERIAL,
    'auth_handoff_tokens',
    'device_tokens',
    'email_unsubscribe_tokens',
    'mcp_token_drives',
    'mcp_tokens',
    'oauth_access_tokens',
    'oauth_authorization_codes',
    'oauth_device_codes',
    'oauth_refresh_tokens',
    'passkeys',
    'push_notification_tokens',
    'revoked_service_tokens',
    'socket_tokens',
    'verification_tokens',
    'google_calendar_connections',
    'integration_connections',
    'zoom_connections',
    // The mint log for app-scoped Fly deploy tokens. It records that WE issued a
    // credential to our own build pipeline for a drive's published app — no
    // token value is stored, and nothing in the row is authored by or about the
    // subject.
    'app_deploy_token_mints',
  ),

  ...withReason(
    SERVICE_INFRASTRUCTURE,
    'machine_sprite_reclaims',
    // The published-app teardown outbox — the same fleet-pointer shape as
    // `machine_sprite_reclaims` above, holding a Fly app name awaiting a
    // confirmed kill.
    'app_hosting_reclaims',
    // The local mirror of a published app's MACHINE lifecycle — start/stop
    // boundaries kept because Fly retains only the last 20 events per machine.
    // Every column is fleet telemetry: a Fly app name, a machine id, a
    // normalized start/stop, Fly's own event id and a timestamp. Nothing is
    // authored by or about the subject, and the row keys on a `published_apps`
    // id, which is itself the DRIVE's infrastructure record. The money these
    // boundaries produced is exported under the subject's billing categories
    // (`ai_usage_logs`, the credit ledger), which is where a charge is actually
    // evidenced — this table is how we priced the drive's machine, not a record
    // of anything the subject did.
    'published_app_machine_events',
    'rate_limit_buckets',
    'siem_delivery_cursors',
    'siem_delivery_receipts',
    'storage_events',
    'stripe_events',
    'pending_uploads',
    'integration_providers',
    'incidents',
  ),

  ...withReason(
    ORGANISATION_OWNED,
    'drive_agent_members',
    'drive_backup_files',
    'drive_backup_members',
    'drive_backup_pages',
    'drive_backup_permissions',
    'drive_backup_roles',
    'drive_backup_schedules',
    'drive_backups',
    'drive_roles',
    // A persistent per-drive ENVIRONMENT. The row is the
    // drive's infrastructure, not the subject's data: a name, a kind, and
    // pointers at a VM. `createdBy` is audit-only and confers nothing — the env
    // belongs to the drive, is paid for by the drive owner, and is shared by
    // every member — so it is the drive's record in exactly the sense this
    // rationale describes. What the subject actually authored INSIDE an env is
    // their sessions, shells and messages, all of which the export carries
    // under their own categories.
    'drive_envs',
    'drive_share_links',
    'page_permissions',
    'page_share_links',
    'published_pages',
    // The hosting deployment of a drive's published ENVIRONMENT — the drive's
    // record, exactly as `published_pages` and `drive_envs` above it are. The
    // row keys on `envId`: it is the Fly app an env is served from, and it
    // carries no content of the subject's. What the subject authored lives in
    // the env (exported under its own categories) and in `pages`; this row is
    // infrastructure the drive owns and pays for.
    'published_apps',
    // The Stripe mirror for one published app's DEDICATED (flat monthly) tier —
    // the same answer as `subscriptions` below, for the same reason. It records a
    // recurring charge for a DRIVE's infrastructure: which app is always-on, at
    // which guest size, on which Stripe price, and whether that subscription is
    // paying. `userId` is the payer denormalized from the drive owner, so the row
    // says who is billed for the drive's machine rather than anything the subject
    // authored or that describes them. The subject's own billing relationship is
    // already the account-plan `subscriptions` row and the credit ledger, all
    // excluded on this same rationale; the Stripe-side record of the charge is the
    // subject's to obtain from Stripe, and is not duplicated into a PageSpace
    // export by a table whose subject is an app.
    'published_app_subscriptions',
    'custom_domains',
    'global_assistant_config',
    'form_targets',
    'page_webhooks',
    'webhook_triggers',
    'task_triggers',
    'calendar_triggers',
    'workflows',
    'workflow_runs',
    'workflow_run_steps',
    'task_status_configs',
    // The drive's shared VOCABULARY. A tag name is minted once and used by
    // every member; `createdBy` records who happened to type it first and
    // confers nothing. The subject's own USE of the vocabulary is exported as
    // `content_tags` above, with the name joined in.
    'tags',
    'commands',
    'email_broadcasts',
    'broadcast_templates',
    'broadcast_recipients',
    'integration_tool_grants',
    'integration_audit_log',
    'oauth_clients',
    'subscriptions',
    'credit_balances',
    'credit_holds',
    'credit_ledger',
  ),

  ...withReason(
    DUPLICATE_OF_EXPORTED,
    // Reaction/mention/read-state rows point at messages and pages that are
    // exported in full under `messages` and `pages`.
    'channel_message_reactions',
    'channel_read_status',
    'channel_thread_followers',
    'dm_message_reactions',
    'dm_thread_followers',
    'mentions',
    'user_mentions',
    'file_pages',
    'file_conversations',
    'page_versions',
    // The per-cell edit log for sheet content that is exported in full under
    // `sheets`. (Sheet version history is `page_versions`, already excluded
    // above for the same reason.)
    'sheet_changes',
    'user_activities',
    'security_audit_log',
    'task_assignees',
  ),

  ...withReason(
    DERIVED_OR_EPHEMERAL,
    // A monotonic per-workspace mutation counter and nothing else — one bigint
    // whose only job is to let a client tell a stale snapshot from a fresh one.
    // The rows it counts ARE exported (`agent_workspace_nodes`).
    // Formula dependency edges — derived wholly from the formula text, which is
    // exported verbatim as each cell's `raw` under `sheets`. They are a
    // recompute index, not something the subject authored.
    'sheet_cell_deps',
    'sheet_range_deps',
    'agent_workspace_node_revs',
    'ai_pending_abort_intents',
    'conversation_compactions',
    'pulse_summaries',
    'user_page_views',
    'message_drafts',
  ),

  // Individually reasoned — these are the ones where a shared rationale would
  // have been an approximation.
  user_profiles:
    'The identity fields (username, display name, bio, avatar) are already carried in full by the `profile` category, which reads them from `users` — this table holds no personal data the export does not return. Deliberately NOT justified by the subject being able to see their profile in the app: Art 15(3) is a right to a copy, not to visibility, and that reasoning would excuse omitting almost anything.',
  favorites:
    'A pointer list into pages and drives that the export already carries in full; the ordering of a subject\'s own bookmarks conveys nothing the pages category does not.',
  user_dashboards:
    'Layout of the subject\'s dashboard widgets — display arrangement with no content of its own; every widget\'s underlying data is exported under its own category.',
  email_notification_log:
    'Delivery ledger for transactional email (send/bounce/complaint outcomes). The CONTENT of every such message is exported under the notifications category; this table is the transport outcome, held for deliverability and abuse handling.',
  contact_submissions:
    'Submissions to the public contact form, which accepts an arbitrary email address with no authenticated account behind it — there is no reliable link to a user id, so a row cannot be attributed to the subject without guessing.',
  feedback_submissions:
    'Product feedback the subject volunteered, retained as a controller record for the legitimate interest of acting on it; the subject holds their own copy of what they wrote at the moment they wrote it.',
  data_subject_requests:
    'The record of the subject\'s own GDPR requests, including this export. Exporting the request log inside its own output is self-referential; the subject is told the outcome of each request directly when it completes.',
  connections:
    'A user-to-user connection is a MUTUAL record naming another person. Art 15(4): the subject\'s access right must not disclose the other party\'s relationships; the subject sees their own connection list in the app.',
  pending_connection_invites:
    'Names another person as inviter or invitee — the same Art 15(4) boundary as connections.',
  pending_invites:
    'A drive invitation naming the inviter and the invited address; the counterparty is another person, and the resulting membership is exported under drives.',
  pending_page_invites:
    'A page invitation naming another person as counterparty — same Art 15(4) boundary as the drive invitations above.',
  calendar_events:
    'Mirrored from the subject\'s external calendar provider (Google/Zoom), where the authoritative copy lives and the provider\'s own export serves it; attendee rows also name other people.',
  calendar_event_drives:
    'Binding rows between mirrored calendar events and drives — meaningless without the mirrored events, which are excluded above.',
  event_attendees:
    'Attendee list of a mirrored calendar event: it is a list of OTHER PEOPLE, which Art 15(4) puts outside the subject\'s access right.',
};

/** Every table the registry has a decision for. */
export function registeredTables(): string[] {
  return [...Object.keys(EXPORTED_TABLES), ...Object.keys(EXCLUDED_TABLES)];
}

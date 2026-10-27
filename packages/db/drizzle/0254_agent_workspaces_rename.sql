-- Custom SQL migration file, put your code below! --

-- Agent-Session Single Source of Truth, Phase 5: the schema says what it means.
--
--   agent_sessions        -> agent_workspaces
--   agent_session_shells  -> agent_workspace_shells
--   agent_session_shells.sessionId        -> workspaceId
--   agent_session_shells.streamSessionId  -> spriteExecId
--   agent_sessions.sessionKey             -> spriteKey
--   conversations.sessionId               -> workspaceId
--   conversations.closedInSessionAt       -> closedInWorkspaceAt
--
-- The layout tables (`agent_workspace_pane_columns` / `agent_workspace_panes` /
-- `agent_workspace_layout_revs` / `agent_workspace_layout_ops`) were already
-- born with the right names; only their FK CONSTRAINT names, which embed the
-- referenced table, follow.
--
-- ============================================================================
-- WHY EVERY STATEMENT BELOW IS A RENAME, NEVER A DROP + RECREATE
-- ============================================================================
--
-- 1. NO ROW IS REWRITTEN, AND NO `id` VALUE IS TOUCHED. Every Sprite (the VM a
--    workspace's sandbox runs on) is provisioned under a name HMAC-folded from
--    `agent_workspaces.id` — `deriveAgentSessionSpriteKey`, namespace
--    `agent-session-sprite:v2`, prefix `pgs-ses-`, all three unchanged by this
--    PR. Rewriting an id would derive a NEW Sprite name for an EXISTING VM:
--    every running machine orphaned, every persistent filesystem stranded, and
--    the reclaim outbox pointing at nothing. `ALTER TABLE ... RENAME` is pure
--    catalog metadata — it cannot touch a value — which is exactly why it is
--    the only shape used here.
--
-- 2. THE GDPR RECLAIM TRIGGER SURVIVES BY CONSTRUCTION. `agent_sessions` carries
--    an AFTER DELETE trigger (`agent_sessions_sprite_reclaim`, 0233/0238) that
--    moves a live Sprite pointer into the `machine_sprite_reclaims` outbox
--    inside the deleting transaction — the last pointer to a VM whose row is
--    going away via a drive cascade, an owner cascade (Art. 17 erasure), or a
--    direct end. `DROP TABLE` takes its triggers with it; `ALTER TABLE RENAME`
--    carries them, along with every index and foreign key. The trigger and its
--    function are renamed for legibility only — the body is byte-identical and
--    `packages/db/src/__tests__/agent-workspaces-rename-migration.test.ts`
--    asserts it is still ATTACHED and still FIRES on the renamed table.
--
-- 3. INDEX / CONSTRAINT / TRIGGER NAMES ARE RENAMED EXPLICITLY. Postgres does
--    NOT cascade a table rename into the names of its indexes, constraints or
--    triggers, but drizzle derives those names from the table and column names
--    and records them in the snapshot. Without the explicit `RENAME`s below, a
--    freshly migrated database and a production database would disagree on
--    every one of them — the drift class that makes the next `drizzle-kit
--    generate` emit a spurious diff.
--
-- ============================================================================
-- ROLLING-DEPLOY COMPAT (one release; removed by the contract PR)
-- ============================================================================
--
-- Fly runs migrations in a one-off machine BEFORE rolling processor → realtime
-- → web, so pre-rename application code executes against this post-rename
-- schema for minutes. The tail of this migration installs updatable VIEWs under
-- the OLD table names, exposing the OLD column names, so those instances keep
-- reading AND writing normally. Simple views over a single table with no
-- expressions are auto-updatable in Postgres, so INSERT/UPDATE/DELETE pass
-- straight through.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
ALTER TABLE "agent_sessions" RENAME TO "agent_workspaces";--> statement-breakpoint
ALTER TABLE "agent_session_shells" RENAME TO "agent_workspace_shells";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
ALTER TABLE "agent_workspaces" RENAME COLUMN "sessionKey" TO "spriteKey";--> statement-breakpoint
ALTER TABLE "agent_workspace_shells" RENAME COLUMN "sessionId" TO "workspaceId";--> statement-breakpoint
ALTER TABLE "agent_workspace_shells" RENAME COLUMN "streamSessionId" TO "spriteExecId";--> statement-breakpoint
ALTER TABLE "conversations" RENAME COLUMN "sessionId" TO "workspaceId";--> statement-breakpoint
ALTER TABLE "conversations" RENAME COLUMN "closedInSessionAt" TO "closedInWorkspaceAt";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Primary keys + indexes (carried by the table rename, renamed for parity)
-- ---------------------------------------------------------------------------
ALTER INDEX "agent_sessions_pkey" RENAME TO "agent_workspaces_pkey";--> statement-breakpoint
ALTER INDEX "agent_sessions_drive_id_idx" RENAME TO "agent_workspaces_drive_id_idx";--> statement-breakpoint
ALTER INDEX "agent_sessions_owner_id_idx" RENAME TO "agent_workspaces_owner_id_idx";--> statement-breakpoint
ALTER INDEX "agent_sessions_live_sprite_idx" RENAME TO "agent_workspaces_live_sprite_idx";--> statement-breakpoint
ALTER INDEX "agent_session_shells_pkey" RENAME TO "agent_workspace_shells_pkey";--> statement-breakpoint
ALTER INDEX "agent_session_shells_session_id_idx" RENAME TO "agent_workspace_shells_workspace_id_idx";--> statement-breakpoint
ALTER INDEX "agent_session_shells_session_name_idx" RENAME TO "agent_workspace_shells_workspace_name_idx";--> statement-breakpoint
ALTER INDEX "conversations_session_id_idx" RENAME TO "conversations_workspace_id_idx";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Foreign keys. Renamed, never dropped and re-added: re-adding
-- `conversations_workspaceId_...` would revalidate the whole table under an
-- ACCESS EXCLUSIVE lock for no schema change at all.
-- ---------------------------------------------------------------------------
ALTER TABLE "agent_workspaces" RENAME CONSTRAINT "agent_sessions_driveId_drives_id_fk" TO "agent_workspaces_driveId_drives_id_fk";--> statement-breakpoint
ALTER TABLE "agent_workspaces" RENAME CONSTRAINT "agent_sessions_ownerId_users_id_fk" TO "agent_workspaces_ownerId_users_id_fk";--> statement-breakpoint
ALTER TABLE "agent_workspace_shells" RENAME CONSTRAINT "agent_session_shells_sessionId_agent_sessions_id_fk" TO "agent_workspace_shells_workspaceId_agent_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_workspace_shells" RENAME CONSTRAINT "agent_session_shells_ownerId_users_id_fk" TO "agent_workspace_shells_ownerId_users_id_fk";--> statement-breakpoint
ALTER TABLE "conversations" RENAME CONSTRAINT "conversations_sessionId_agent_sessions_id_fk" TO "conversations_workspaceId_agent_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_workspace_layout_ops" RENAME CONSTRAINT "agent_workspace_layout_ops_workspaceId_agent_sessions_id_fk" TO "agent_workspace_layout_ops_workspaceId_agent_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_workspace_layout_revs" RENAME CONSTRAINT "agent_workspace_layout_revs_workspaceId_agent_sessions_id_fk" TO "agent_workspace_layout_revs_workspaceId_agent_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_workspace_pane_columns" RENAME CONSTRAINT "agent_workspace_pane_columns_workspaceId_agent_sessions_id_fk" TO "agent_workspace_pane_columns_workspaceId_agent_workspaces_id_fk";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The Sprite reclaim trigger. Renamed in place — the body is untouched, and
-- the AFTER DELETE binding rode the table rename. Naming only.
-- ---------------------------------------------------------------------------
ALTER FUNCTION agent_sessions_capture_sprite_reclaim() RENAME TO agent_workspaces_capture_sprite_reclaim;--> statement-breakpoint
ALTER TRIGGER agent_sessions_sprite_reclaim ON "agent_workspaces" RENAME TO agent_workspaces_sprite_reclaim;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- ROLLING-DEPLOY COMPAT VIEWS — DROPPED BY THE CONTRACT PR, ONE RELEASE LATER.
--
-- Auto-updatable (single table, no expressions, no aggregates), so a pre-rename
-- app instance mid-deploy keeps both reading and writing through them. They are
-- deliberately NOT security_barrier and NOT `WITH CHECK OPTION`: they are a
-- pass-through alias, not a policy surface, and every authorization decision
-- still happens in the application exactly as before.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW "agent_sessions" AS
SELECT
  "id",
  "driveId",
  "ownerId",
  "name",
  "spriteKey" AS "sessionKey",
  "sandboxId",
  "spriteInstanceId",
  "egressPolicyToken",
  "teardownRequestedAt",
  "spriteTornDownAt",
  "storageLastBilledAt",
  "storageMeasuredBytes",
  "storageMeasuredAt",
  "lastActiveAt",
  "endedAt",
  "createdAt",
  "updatedAt"
FROM "agent_workspaces";--> statement-breakpoint

CREATE OR REPLACE VIEW "agent_session_shells" AS
SELECT
  "id",
  "workspaceId" AS "sessionId",
  "ownerId",
  "name",
  "agentType",
  "command",
  "spriteExecId" AS "streamSessionId",
  "coldTail",
  "coldTailAt",
  "coldTailHasOutput",
  "createdAt",
  "updatedAt"
FROM "agent_workspace_shells";--> statement-breakpoint

COMMENT ON VIEW "agent_sessions" IS 'ROLLING-DEPLOY COMPAT SHIM (agent_workspaces rename, Phase 5). Auto-updatable alias for pre-rename app instances. DROP after one release — the contract PR removes it.';--> statement-breakpoint
COMMENT ON VIEW "agent_session_shells" IS 'ROLLING-DEPLOY COMPAT SHIM (agent_workspaces rename, Phase 5). Auto-updatable alias for pre-rename app instances. DROP after one release — the contract PR removes it.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- THE ONE PLACE WITH NO SHIM: `conversations."sessionId"` /
-- `"closedInSessionAt"`.
--
-- `conversations` keeps its own table name, so — unlike the two tables above —
-- there is no name left over to hang a compat view on, and every alternative
-- costs more than the gap it closes:
--
--   * STORED generated columns rewrite the entire table under an ACCESS
--     EXCLUSIVE lock, during the migration that gates the deploy, and are
--     read-only anyway (a pre-rename WRITE would still fail).
--   * VIRTUAL generated columns need Postgres 18; the fleet is on 16.
--   * A keep-both-columns + sync-trigger expand/contract makes `conversations`
--     carry two spellings of one fact for a release — the exact duplication
--     this epic exists to delete — for a window measured in minutes.
--
-- So this pair is a HARD rename. The exposure is bounded to the interval
-- between the migrate one-off finishing and `web` finishing its roll: during
-- it, a pre-rename web instance 500s on the session-listing / claim / close /
-- reopen reads that name these columns. Chat, pages and the sandbox are
-- unaffected. Documented in `infrastructure/UPGRADE.md`.
-- ---------------------------------------------------------------------------

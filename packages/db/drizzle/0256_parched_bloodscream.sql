-- destructive-migration-ack: ONE TREE — the contract step (epic #2161, completing
-- PR #2378). Every statement below is drizzle-diffed from deleted schema; nothing
-- here is hand-written DDL. This header is the only hand-added content, and it is
-- the acknowledgement `scripts/check-destructive-migrations.ts` requires.
--
-- THIS MIGRATION IS IRREVERSIBLE. It DROPs the four pane-grid tables and
-- `conversations."workspaceId"` / `"closedInWorkspaceAt"`. Reverting the
-- deployment restores the readers, not the rows. TAKE A DATABASE SNAPSHOT BEFORE
-- DEPLOYING — see infrastructure/UPGRADE.md, "2026-08 — Minimum upgrade path:
-- workspace membership becomes a node tree".
--
-- WHY THIS IS SAFE: membership and layout both live in `agent_workspace_nodes`
-- (added by 0255) and have done since the cutover deployed. Nothing reads or
-- writes the objects dropped here. The pre-flight in UPGRADE.md was run against
-- production immediately before this shipped: every conversation still carrying a
-- legacy pointer with no node belongs to a session that has been ENDED, and
-- ending destroys a workspace's tree by design. Zero in a live workspace.
--
-- WHAT OLD CODE THIS MAY BREAK — a real, accepted deploy window. The pipeline
-- runs the migrate one-shot BEFORE rolling web, so the previous image serves
-- against this contracted schema for the length of the roll. That image still
-- declares both columns in its Drizzle schema, and Drizzle names every declared
-- column explicitly rather than emitting SELECT *, so every unprojected
-- `.select().from(conversations)` fails 42703 until the roll completes. Three
-- exist; the widest is `conversationRepository.getConversation()` (17 non-test
-- callers, including the chat turn itself). Bounded to the migrate-to-roll gap,
-- loud rather than silent, and no data at risk in either direction. UPGRADE.md
-- documents the zero-cost way out: deploy web first, migrate second — the new
-- image names neither column and both are nullable, so it runs correctly against
-- the un-contracted schema.
--
-- NO `DO` PRE-FLIGHT BLOCK, deliberately. An earlier revision carried one and it
-- was a P1: `packages/db/src/migrate.ts` loads the whole journal and
-- `runMigrations` applies every pending migration in ONE invocation, so a guard
-- refusing an un-backfilled database exits the migrate one-shot nonzero and the
-- services that gate on it never start. The control for a deployment that skips
-- the 0255 stop is the minimum-upgrade-path section in UPGRADE.md.
ALTER TABLE "agent_workspace_layout_ops" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_workspace_layout_revs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_workspace_pane_columns" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_workspace_panes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "agent_workspace_layout_ops" CASCADE;--> statement-breakpoint
DROP TABLE "agent_workspace_layout_revs" CASCADE;--> statement-breakpoint
DROP TABLE "agent_workspace_pane_columns" CASCADE;--> statement-breakpoint
DROP TABLE "agent_workspace_panes" CASCADE;--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_workspaceId_agent_workspaces_id_fk";
--> statement-breakpoint
DROP INDEX "conversations_workspace_id_idx";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "workspaceId";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "closedInWorkspaceAt";
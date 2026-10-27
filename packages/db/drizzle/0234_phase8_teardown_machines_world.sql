-- Phase 8 teardown: the unreleased Machines/"Development" surface is deleted
-- wholesale (see /Users/jono/.claude/plans/we-need-to-crystalline-knuth.md,
-- "Migrations" M3). Never released ⇒ no data migration, just a rescue-and-drop.
--
-- ORDER IS NON-NEGOTIABLE: `DROP TABLE` does NOT fire per-row AFTER DELETE
-- triggers, so dropping the machine_* tables outright would strand every live
-- Sprite they still point at, billing forever with nothing left to find them.
-- So:
--   (a) rescue every live Sprite pointer into the FK-less reclaim outbox first
--       (idempotent — ON CONFLICT DO NOTHING — safe even if a row was already
--       captured by the existing 0209/0219/0229 row-level triggers below),
--   (b) DELETE FROM pages WHERE type = 'MACHINE' (cascades away every
--       machine_* row; pointers are already rescued by (a) regardless of
--       whether the cascade re-fires a trigger),
--   (c) drop the now-redundant reclaim triggers,
--   (d) drop the 9 machine_* tables (machine_sprite_reclaims — the FK-less
--       outbox the orphan-reclaim cron still drains — is NOT one of them),
--   (e) drop the dead pages/global_assistant_config columns.
--
-- The pg `PageType` enum cannot DROP VALUE, so 'MACHINE' stays in it forever
-- (see the comment on `pageType` in packages/db/src/schema/core.ts) — the
-- application-level TS enum is what actually stops anything from writing it.

-- (a) Rescue: every live Sprite pointer still reachable from a machine_* row.
-- Same two conditions the 0219/0229 triggers use — `sandboxId IS NOT NULL`
-- (a row that never provisioned/promoted has no Sprite of its own) and
-- `spriteTornDownAt IS NULL` (a stamped row's Sprite is already confirmed
-- gone; re-enqueueing its reused NAME could target a replacement VM that
-- legitimately took the name later). `machine_sessions` has neither column —
-- a row there exists ONLY while its Sprite is believed live (see that
-- table's doc comment) — so every row is rescued unconditionally.
INSERT INTO "machine_sprite_reclaims" ("sandboxId", "spriteInstanceId")
SELECT "sandboxId", "spriteInstanceId"
FROM "machine_sessions"
ON CONFLICT ("sandboxId") DO NOTHING;--> statement-breakpoint

INSERT INTO "machine_sprite_reclaims" ("sandboxId", "spriteInstanceId")
SELECT "sandboxId", "spriteInstanceId"
FROM "machine_branches"
WHERE "spriteTornDownAt" IS NULL
ON CONFLICT ("sandboxId") DO NOTHING;--> statement-breakpoint

INSERT INTO "machine_sprite_reclaims" ("sandboxId", "spriteInstanceId")
SELECT "sandboxId", "spriteInstanceId"
FROM "machine_projects"
WHERE "sandboxId" IS NOT NULL AND "spriteTornDownAt" IS NULL
ON CONFLICT ("sandboxId") DO NOTHING;--> statement-breakpoint

INSERT INTO "machine_sprite_reclaims" ("sandboxId", "spriteInstanceId")
SELECT "sandboxId", "spriteInstanceId"
FROM "machine_agent_terminals"
WHERE "sandboxId" IS NOT NULL AND "spriteTornDownAt" IS NULL
ON CONFLICT ("sandboxId") DO NOTHING;--> statement-breakpoint

-- (b) Drop every MACHINE page. Cascades: machine_sessions.pageId,
-- machine_workspaces.machineId, machine_workspace_bootstraps.machineId,
-- machine_projects.machineId all reference pages.id ON DELETE CASCADE;
-- machine_branches/machine_agent_terminals cascade transitively off
-- machine_projects; machine_pane_columns/machine_panes/machine_workspace_revs
-- cascade off machine_workspaces (and machine_workspace_revs off pages
-- directly). Pointers were already rescued by (a) above.
DELETE FROM "pages" WHERE "type" = 'MACHINE';--> statement-breakpoint

-- (c) Drop the old reclaim triggers (0209/0219/0229) — redundant with the
-- table drops below (which remove any trigger on the table along with it),
-- kept as an explicit step so the teardown reads as complete on its own.
DROP TRIGGER IF EXISTS machine_sessions_sprite_reclaim ON "machine_sessions";--> statement-breakpoint
DROP TRIGGER IF EXISTS machine_branches_sprite_reclaim ON "machine_branches";--> statement-breakpoint
DROP TRIGGER IF EXISTS machine_projects_sprite_reclaim ON "machine_projects";--> statement-breakpoint
DROP TRIGGER IF EXISTS machine_agent_terminals_sprite_reclaim ON "machine_agent_terminals";--> statement-breakpoint
DROP FUNCTION IF EXISTS machine_sessions_capture_sprite_reclaim();--> statement-breakpoint
DROP FUNCTION IF EXISTS machine_branches_capture_sprite_reclaim();--> statement-breakpoint
DROP FUNCTION IF EXISTS machine_projects_capture_sprite_reclaim();--> statement-breakpoint
DROP FUNCTION IF EXISTS machine_agent_terminals_capture_sprite_reclaim();--> statement-breakpoint

-- (d) Drop the 9 machine_* tables. Empty by this point (cascaded away in
-- (b)) — CASCADE here only to sweep any leftover FK/index artifacts between
-- them regardless of drop order.
ALTER TABLE "machine_sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine_projects" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine_branches" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine_agent_terminals" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine_workspaces" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine_workspace_bootstraps" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine_pane_columns" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine_panes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine_workspace_revs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "machine_sessions" CASCADE;--> statement-breakpoint
DROP TABLE "machine_projects" CASCADE;--> statement-breakpoint
DROP TABLE "machine_branches" CASCADE;--> statement-breakpoint
DROP TABLE "machine_agent_terminals" CASCADE;--> statement-breakpoint
DROP TABLE "machine_workspaces" CASCADE;--> statement-breakpoint
DROP TABLE "machine_workspace_bootstraps" CASCADE;--> statement-breakpoint
DROP TABLE "machine_pane_columns" CASCADE;--> statement-breakpoint
DROP TABLE "machine_panes" CASCADE;--> statement-breakpoint
DROP TABLE "machine_workspace_revs" CASCADE;--> statement-breakpoint

-- (e) Drop the dead columns. No replacement: sandbox capability is now
-- derived (admin + CODE_EXECUTION + enabledTools), not configured.
ALTER TABLE "global_assistant_config" DROP CONSTRAINT "global_assistant_config_own_machine_page_id_pages_id_fk";--> statement-breakpoint
ALTER TABLE "pages" DROP COLUMN "terminalAccess";--> statement-breakpoint
ALTER TABLE "pages" DROP COLUMN "machines";--> statement-breakpoint
ALTER TABLE "pages" DROP COLUMN "allowPageAgents";--> statement-breakpoint
ALTER TABLE "global_assistant_config" DROP COLUMN "terminal_access";--> statement-breakpoint
ALTER TABLE "global_assistant_config" DROP COLUMN "machines";--> statement-breakpoint
ALTER TABLE "global_assistant_config" DROP COLUMN "own_machine_page_id";

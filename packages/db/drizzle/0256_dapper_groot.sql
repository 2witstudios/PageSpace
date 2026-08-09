-- DROP THE MODEL THE NODE TREE REPLACED.
--
-- DESTRUCTIVE AND IRREVERSIBLE. There is no down migration, no shadow copy and
-- no rolling window: after this runs, the four layout tables and the two
-- `conversations` membership columns are gone and the only record of a
-- workspace's panes and of which threads it holds is `agent_workspace_nodes`.
--
-- WHAT IT DROPS, AND WHAT ALREADY HOLDS IT INSTEAD
--   agent_workspace_pane_columns  ) the two-level pane grid — columns of panes,
--   agent_workspace_panes         ) each with a kind/targetId and a fraction.
--                                 ) Superseded by agent_workspace_nodes, whose
--                                 ) rows carry the same panes as a tree.
--   agent_workspace_layout_revs   ) the per-workspace mutation counter and the
--   agent_workspace_layout_ops    ) verb route's idempotency memory.
--                                 ) Superseded by agent_workspace_node_revs;
--                                 ) the node write is an upsert of a set, so a
--                                 ) retry re-applies to the same state and there
--                                 ) is nothing left for an op memory to remember.
--   conversations."workspaceId"        ) which workspace held a thread, and
--   conversations."closedInWorkspaceAt") whether it was still in that
--                                 ) workspace's listing. Superseded by the
--                                 ) chat-bound node: a conversation is IN a
--                                 ) workspace exactly when a node of that
--                                 ) workspace is bound to it, which the table's
--                                 ) global UNIQUE (targetId) WHERE
--                                 ) targetKind = 'chat' makes a constraint
--                                 ) rather than a convention.
--
-- THE FAILURE MODE, WRITTEN DOWN WHERE THE NEXT PERSON WILL FIND IT.
-- All of the above is true ONLY of a database the node backfill has already run
-- against (`scripts/backfill-agent-workspace-nodes.ts` at migration 0255, now
-- deleted with the tables it read). Run this against a database where it did NOT
-- run — a restored old snapshot, a long-lived branch database, a tenant image
-- that skipped the 0255 window — and it does not "migrate" anything: it DELETES
-- every workspace's pane grid and every thread's workspace membership outright.
-- The rows have no second home to be recovered from, and the app afterwards is
-- not broken in a way anyone will notice quickly — each workspace simply opens
-- empty and each thread appears in past-conversation history alone.
--
-- BEFORE APPLYING THIS TO ANY DATABASE, CHECK THAT THE BACKFILL LANDED:
--
--   SELECT count(*) FROM agent_workspace_panes p
--    WHERE NOT EXISTS (SELECT 1 FROM agent_workspace_nodes n
--                       WHERE n."rootId" = p."workspaceId");
--   SELECT count(*) FROM conversations c
--    WHERE c."workspaceId" IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM agent_workspace_nodes n
--                       WHERE n."targetKind" = 'chat' AND n."targetId" = c.id);
--
-- Both must be 0. A non-zero count is a workspace, or a thread, whose only
-- record of itself is about to be dropped.

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
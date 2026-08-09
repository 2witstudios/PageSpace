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

-- THE CHECKS ABOVE, MADE EXECUTABLE.
--
-- They were comments. A comment does not stop a deploy, and migrations apply
-- automatically — so the instruction "check before applying" was addressed to a
-- human who, on the path that actually loses data (a restored snapshot, a
-- long-lived branch database, a tenant image that skipped the 0255 window), is
-- not in the room. This block refuses instead of trusting.
--
-- DELIBERATE EXCEPTION to "never hand-edit generated SQL". A precondition is not
-- expressible in the Drizzle schema, so `db:generate` cannot emit one; the rule
-- exists to keep schema and migration in step, and this adds no schema. Nothing
-- below this block was hand-written.
DO $$
DECLARE orphan_panes bigint; orphan_threads bigint;
BEGIN
  -- Scoped to LIVE workspaces, because that is what the derivation covers. An
  -- ended workspace is never derived, so its pane rows correctly have no node
  -- and counting them refuses a database the backfill migrated perfectly.
  SELECT count(*) INTO orphan_panes
    FROM agent_workspace_panes p
    JOIN agent_workspaces w ON w.id = p."workspaceId"
   WHERE w."endedAt" IS NULL
     AND NOT EXISTS (SELECT 1 FROM agent_workspace_nodes n
                      WHERE n."rootId" = p."workspaceId");
  -- Same scoping, plus the membership predicate the derivation itself applies:
  -- a dismissed or inactive thread is deliberately NOT a member, so it has no
  -- node BY DESIGN. Counting it here is what made this block refuse a correct
  -- migration — the pre-flight was written against an idea of the derivation
  -- rather than the derivation, and then the dismissed-thread fix moved the
  -- derivation further away from it.
  SELECT count(*) INTO orphan_threads
    FROM conversations c
    JOIN agent_workspaces w ON w.id = c."workspaceId"
   WHERE w."endedAt" IS NULL
     AND c."isActive"
     AND c."closedInWorkspaceAt" IS NULL
     AND NOT EXISTS (SELECT 1 FROM agent_workspace_nodes n
                      WHERE n."targetKind" = 'chat' AND n."targetId" = c.id);
  IF orphan_panes > 0 OR orphan_threads > 0 THEN
    RAISE EXCEPTION
      'Node backfill has not run on this database: % pane row(s) and % thread(s) have no node. Applying 0256 would delete their only record. Run scripts/backfill-agent-workspace-nodes.ts, verify both counts are 0, then re-apply.',
      orphan_panes, orphan_threads;
  END IF;
END $$;--> statement-breakpoint
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
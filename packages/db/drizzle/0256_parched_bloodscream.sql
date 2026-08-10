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
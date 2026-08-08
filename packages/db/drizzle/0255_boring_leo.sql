CREATE TABLE "agent_workspace_node_revs" (
	"rootId" text PRIMARY KEY NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_workspace_nodes" (
	"id" text NOT NULL,
	"rootId" text NOT NULL,
	"parentId" text,
	"position" integer NOT NULL,
	"nodeType" text NOT NULL,
	"axis" text,
	"fraction" real,
	"targetKind" text,
	"targetId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "agent_workspace_nodes_rootId_id_pk" PRIMARY KEY("rootId","id"),
	CONSTRAINT "agent_workspace_nodes_root_no_parent_chk" CHECK ("agent_workspace_nodes"."nodeType" <> 'root' OR "agent_workspace_nodes"."parentId" IS NULL),
	CONSTRAINT "agent_workspace_nodes_node_type_chk" CHECK ("agent_workspace_nodes"."nodeType" IN ('root', 'split', 'pane')),
	CONSTRAINT "agent_workspace_nodes_target_kind_chk" CHECK ("agent_workspace_nodes"."targetKind" IS NULL OR "agent_workspace_nodes"."targetKind" IN ('chat', 'terminal', 'page'))
);
--> statement-breakpoint
ALTER TABLE "agent_workspace_node_revs" ADD CONSTRAINT "agent_workspace_node_revs_rootId_agent_workspaces_id_fk" FOREIGN KEY ("rootId") REFERENCES "public"."agent_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_nodes" ADD CONSTRAINT "agent_workspace_nodes_rootId_agent_workspaces_id_fk" FOREIGN KEY ("rootId") REFERENCES "public"."agent_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_nodes" ADD CONSTRAINT "agent_workspace_nodes_rootId_parentId_agent_workspace_nodes_rootId_id_fk" FOREIGN KEY ("rootId","parentId") REFERENCES "public"."agent_workspace_nodes"("rootId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_workspace_nodes_one_root_idx" ON "agent_workspace_nodes" USING btree ("rootId") WHERE "agent_workspace_nodes"."nodeType" = 'root';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_workspace_nodes_chat_target_idx" ON "agent_workspace_nodes" USING btree ("targetId") WHERE "agent_workspace_nodes"."targetKind" = 'chat';--> statement-breakpoint
CREATE INDEX "agent_workspace_nodes_parent_idx" ON "agent_workspace_nodes" USING btree ("rootId","parentId");
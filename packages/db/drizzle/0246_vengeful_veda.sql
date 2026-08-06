CREATE TABLE "agent_workspace_layout_ops" (
	"workspaceId" text NOT NULL,
	"opId" text NOT NULL,
	"rev" bigint NOT NULL,
	"applied" boolean NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_workspace_layout_ops_workspaceId_opId_pk" PRIMARY KEY("workspaceId","opId")
);
--> statement-breakpoint
CREATE TABLE "agent_workspace_layout_revs" (
	"workspaceId" text PRIMARY KEY NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_workspace_pane_columns" (
	"id" text NOT NULL,
	"workspaceId" text NOT NULL,
	"orderIndex" integer NOT NULL,
	"widthFraction" real,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "agent_workspace_pane_columns_workspaceId_id_pk" PRIMARY KEY("workspaceId","id")
);
--> statement-breakpoint
CREATE TABLE "agent_workspace_panes" (
	"id" text NOT NULL,
	"workspaceId" text NOT NULL,
	"columnId" text NOT NULL,
	"orderIndex" integer NOT NULL,
	"kind" text,
	"targetId" text,
	"heightFraction" real,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "agent_workspace_panes_workspaceId_id_pk" PRIMARY KEY("workspaceId","id")
);
--> statement-breakpoint
ALTER TABLE "agent_workspace_layout_ops" ADD CONSTRAINT "agent_workspace_layout_ops_workspaceId_agent_sessions_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_layout_revs" ADD CONSTRAINT "agent_workspace_layout_revs_workspaceId_agent_sessions_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_pane_columns" ADD CONSTRAINT "agent_workspace_pane_columns_workspaceId_agent_sessions_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_panes" ADD CONSTRAINT "agent_workspace_panes_workspaceId_columnId_agent_workspace_pane_columns_workspaceId_id_fk" FOREIGN KEY ("workspaceId","columnId") REFERENCES "public"."agent_workspace_pane_columns"("workspaceId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_workspace_pane_columns_workspace_idx" ON "agent_workspace_pane_columns" USING btree ("workspaceId");--> statement-breakpoint
CREATE INDEX "agent_workspace_panes_workspace_idx" ON "agent_workspace_panes" USING btree ("workspaceId");--> statement-breakpoint
-- Hand-appended below: drizzle-kit only emits the CREATE TABLE/FK/index
-- statements above from the schema diff. The blob->rows backfill is not
-- schema-diffable, so it's appended by hand per the repo's convention
-- (cited precedent: 0225_blushing_tattoo.sql, 0222_wooden_puck.sql,
-- 0116_colossal_tattoo.sql — DO $$ guards, idempotent re-run, RAISE NOTICE
-- for observability). Epic Phase 3: `agent_sessions.workspaceState` stops
-- being the source of truth for the pane grid; the column is KEPT (not
-- dropped) as a rolling-deploy shim — old web instances still read/write
-- only the blob during a deploy window, and the verb engine dual-writes it —
-- to be dropped in a later contract PR.
--
-- The parse is exactly as tolerant as `persistedWorkspaceStateSchema`: only
-- blobs whose `columns` is a jsonb array are promoted; a pane's absent/null
-- `scope` becomes an unbound row (NULL kind/target); a legacy `tabs` field
-- is simply never read. Session counts are small, so this in-migration sweep
-- IS the backfill — no separate cloud script, which also covers
-- version-skipping tenant/onprem upgrades that have no operator to run one.
DO $$
BEGIN
  INSERT INTO "agent_workspace_pane_columns" ("id", "workspaceId", "orderIndex", "createdAt", "updatedAt")
  SELECT
    col.value ->> 'id',
    s."id",
    (col.ordinality - 1)::int,
    s."createdAt",
    s."updatedAt"
  FROM "agent_sessions" s,
    LATERAL jsonb_array_elements(s."workspaceState" -> 'columns') WITH ORDINALITY AS col(value, ordinality)
  WHERE s."workspaceState" IS NOT NULL
    AND jsonb_typeof(s."workspaceState" -> 'columns') = 'array'
    AND jsonb_typeof(col.value) = 'object'
    AND col.value ->> 'id' IS NOT NULL
  ON CONFLICT DO NOTHING;

  INSERT INTO "agent_workspace_panes" ("id", "workspaceId", "columnId", "orderIndex", "kind", "targetId", "createdAt", "updatedAt")
  SELECT
    pane.value ->> 'id',
    s."id",
    col.value ->> 'id',
    (pane.ordinality - 1)::int,
    pane.value -> 'scope' ->> 'kind',
    pane.value -> 'scope' ->> 'targetId',
    s."createdAt",
    s."updatedAt"
  FROM "agent_sessions" s,
    LATERAL jsonb_array_elements(s."workspaceState" -> 'columns') WITH ORDINALITY AS col(value, ordinality),
    LATERAL jsonb_array_elements(col.value -> 'panes') WITH ORDINALITY AS pane(value, ordinality)
  WHERE s."workspaceState" IS NOT NULL
    AND jsonb_typeof(s."workspaceState" -> 'columns') = 'array'
    AND jsonb_typeof(col.value) = 'object'
    AND col.value ->> 'id' IS NOT NULL
    AND jsonb_typeof(col.value -> 'panes') = 'array'
    AND jsonb_typeof(pane.value) = 'object'
    AND pane.value ->> 'id' IS NOT NULL
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'agent_workspace_panes backfill complete (agent-session SSoT epic, Phase 3)';
END $$;
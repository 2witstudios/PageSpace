CREATE TABLE "machine_pane_columns" (
	"id" text NOT NULL,
	"machineId" text NOT NULL,
	"workspaceId" text NOT NULL,
	"orderIndex" integer NOT NULL,
	"widthFraction" real,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "machine_pane_columns_machineId_workspaceId_id_pk" PRIMARY KEY("machineId","workspaceId","id")
);
--> statement-breakpoint
CREATE TABLE "machine_panes" (
	"id" text NOT NULL,
	"machineId" text NOT NULL,
	"workspaceId" text NOT NULL,
	"columnId" text NOT NULL,
	"orderIndex" integer NOT NULL,
	"sessionName" text,
	"sessionKind" text,
	"heightFraction" real,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "machine_panes_machineId_workspaceId_id_pk" PRIMARY KEY("machineId","workspaceId","id")
);
--> statement-breakpoint
CREATE TABLE "machine_workspace_revs" (
	"machineId" text PRIMARY KEY NOT NULL,
	"rev" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine_pane_columns" ADD CONSTRAINT "machine_pane_columns_machineId_workspaceId_machine_workspaces_machineId_id_fk" FOREIGN KEY ("machineId","workspaceId") REFERENCES "public"."machine_workspaces"("machineId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_panes" ADD CONSTRAINT "machine_panes_machineId_workspaceId_columnId_machine_pane_columns_machineId_workspaceId_id_fk" FOREIGN KEY ("machineId","workspaceId","columnId") REFERENCES "public"."machine_pane_columns"("machineId","workspaceId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_workspace_revs" ADD CONSTRAINT "machine_workspace_revs_machineId_pages_id_fk" FOREIGN KEY ("machineId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_pane_columns_workspace_idx" ON "machine_pane_columns" USING btree ("machineId","workspaceId");--> statement-breakpoint
CREATE INDEX "machine_panes_workspace_idx" ON "machine_panes" USING btree ("machineId","workspaceId");--> statement-breakpoint
-- Hand-appended below: drizzle-kit only emits the CREATE TABLE/FK/index
-- statements above from the schema diff. The NOT NULL relaxation and the
-- blob->rows backfill are not schema-diffable, so they're appended by hand
-- per the repo's convention (cited precedent: 0222_wooden_puck.sql,
-- 0116_colossal_tattoo.sql — DO $$ guards, idempotent re-run, RAISE NOTICE
-- for observability). #2202: `machine_workspaces.layout` stops being the
-- source of truth; kept nullable (not dropped) for one release as a
-- rolling-deploy shim for old server instances still writing the blob.
ALTER TABLE "machine_workspaces" ALTER COLUMN "layout" DROP NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  INSERT INTO "machine_pane_columns" ("id", "machineId", "workspaceId", "orderIndex", "createdAt", "updatedAt")
  SELECT
    col.value ->> 'id',
    w."machineId",
    w."id",
    (col.ordinality - 1)::int,
    w."createdAt",
    w."updatedAt"
  FROM "machine_workspaces" w,
    LATERAL jsonb_array_elements(w."layout" -> 'columns') WITH ORDINALITY AS col(value, ordinality)
  WHERE w."layout" IS NOT NULL
  ON CONFLICT DO NOTHING;

  INSERT INTO "machine_panes" ("id", "machineId", "workspaceId", "columnId", "orderIndex", "sessionName", "sessionKind", "createdAt", "updatedAt")
  SELECT
    pane.value ->> 'id',
    w."machineId",
    w."id",
    col.value ->> 'id',
    (pane.ordinality - 1)::int,
    pane.value -> 'scope' ->> 'name',
    NULLIF(pane.value -> 'scope' ->> 'kind', 'terminal'),
    w."createdAt",
    w."updatedAt"
  FROM "machine_workspaces" w,
    LATERAL jsonb_array_elements(w."layout" -> 'columns') WITH ORDINALITY AS col(value, ordinality),
    LATERAL jsonb_array_elements(col.value -> 'panes') WITH ORDINALITY AS pane(value, ordinality)
  WHERE w."layout" IS NOT NULL
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'machine_panes backfill complete (#2202)';
END $$;
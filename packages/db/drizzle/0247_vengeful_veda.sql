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
-- only the blob during a deploy window, and the verb engine dual-writes it.
-- 0252 drops it, in this same branch — so this shim is already retired here and
-- is NOT part of the follow-up PR 17 checklist
-- (docs/2.0-architecture/agent-sessions.md §4).
--
-- The parse is exactly as tolerant as `persistedWorkspaceStateSchema`: only
-- blobs whose `columns` is a jsonb array are promoted; a pane's absent/null
-- `scope` becomes an unbound row (NULL kind/target); a legacy `tabs` field
-- is simply never read. Session counts are small, so this in-migration sweep
-- IS the backfill — no separate cloud script, which also covers
-- version-skipping tenant/onprem upgrades that have no operator to run one.
--
-- DEDUPLICATION (`DISTINCT ON`) is load-bearing, not tidiness. The blob is
-- CLIENT-AUTHORED and has never had a uniqueness constraint on pane or column
-- ids, but the relational tables are keyed by the compound `(workspaceId, id)`.
-- A blob that repeats one pane id in two columns therefore produces two rows
-- that collide, and a bare `ON CONFLICT DO NOTHING` would SILENTLY DISCARD the
-- second — leaving 0252's drop guard staring at a blob pane the rows lack, and
-- refusing to drop the column over a pane THIS statement had just eaten.
-- (0252's documented remedy, "delete the rows and let the sweep re-promote",
-- re-ran the identical losing insert: an unrecoverable loop.)
--
-- Collapsing to the FIRST occurrence — ordered by column position, then pane
-- position — matches how the client itself resolves a duplicate id when it
-- renders the blob, so the row that survives is the pane the user was actually
-- looking at. `ON CONFLICT DO NOTHING` is KEPT, but now only to make the
-- statement re-runnable rather than to paper over in-batch collisions.
DO $$
DECLARE
  dup_columns bigint;
  dup_panes bigint;
BEGIN
  INSERT INTO "agent_workspace_pane_columns" ("id", "workspaceId", "orderIndex", "createdAt", "updatedAt")
  SELECT DISTINCT ON (s."id", col.value ->> 'id')
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
  ORDER BY s."id", col.value ->> 'id', col.ordinality
  ON CONFLICT DO NOTHING;

  INSERT INTO "agent_workspace_panes" ("id", "workspaceId", "columnId", "orderIndex", "kind", "targetId", "createdAt", "updatedAt")
  SELECT DISTINCT ON (s."id", pane.value ->> 'id')
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
  ORDER BY s."id", pane.value ->> 'id', col.ordinality, pane.ordinality
  ON CONFLICT DO NOTHING;

  -- Report what was collapsed. A silently deduplicated pane is still a pane
  -- the user loses, so the number belongs on the deploy record even though
  -- keeping one of the two is the only representable outcome.
  SELECT count(*) INTO dup_columns FROM (
    SELECT s."id" AS ws, col.value ->> 'id' AS cid
    FROM "agent_sessions" s,
      LATERAL jsonb_array_elements(s."workspaceState" -> 'columns') WITH ORDINALITY AS col(value, ordinality)
    WHERE s."workspaceState" IS NOT NULL
      AND jsonb_typeof(s."workspaceState" -> 'columns') = 'array'
      AND jsonb_typeof(col.value) = 'object'
      AND col.value ->> 'id' IS NOT NULL
    GROUP BY 1, 2 HAVING count(*) > 1
  ) d;

  SELECT count(*) INTO dup_panes FROM (
    SELECT s."id" AS ws, pane.value ->> 'id' AS pid
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
    GROUP BY 1, 2 HAVING count(*) > 1
  ) d;

  IF dup_panes > 0 THEN
    RAISE WARNING 'agent_workspace_panes backfill: % duplicate pane id(s) appeared more than once in their session blob; kept the first occurrence', dup_panes;
  END IF;
  IF dup_columns > 0 THEN
    RAISE WARNING 'agent_workspace_panes backfill: % duplicate column id(s) appeared more than once in their session blob; kept the first occurrence', dup_columns;
  END IF;

  RAISE NOTICE 'agent_workspace_panes backfill complete (agent-session SSoT epic, Phase 3)';
END $$;
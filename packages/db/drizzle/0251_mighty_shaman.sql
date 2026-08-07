-- Hand-appended below the (single) drizzle-diffed statement, which is moved
-- to the END of this file: drizzle-kit emits only the `DROP COLUMN`, and a
-- contract step that drops a column must first PROVE the column holds nothing
-- the relational tables lack. The sweep + guard are not schema-diffable, so
-- they are written by hand per the repo's convention (cited precedent:
-- 0246_vengeful_veda.sql — whose promotion sweep this reuses verbatim —
-- 0225_blushing_tattoo.sql, 0222_wooden_puck.sql, 0116_colossal_tattoo.sql:
-- DO $$ guards, idempotent re-run, RAISE NOTICE for observability).
--
-- Epic Phase 3, CONTRACT: `agent_sessions.workspaceState` stops existing. The
-- pane grid has been served from `agent_workspace_pane_columns` /
-- `agent_workspace_panes` behind `agent_workspace_layout_revs` since 0246,
-- written only through the verb engine; the blob was kept one release as the
-- rolling-deploy shim and dual-written. This migration ends that window.
--
-- Order matters, and it is: SWEEP → GUARD → DROP.
--   1. SWEEP  — the final idempotent blob→rows promotion, scoped to sessions
--      that have NO rows. This is what rescues a session whose blob never got
--      promoted (born on an old instance mid-rolling-deploy, or a
--      version-skipping tenant/onprem upgrade that has no operator to run a
--      script). It is deliberately NOT applied to sessions that DO have rows:
--      there the rows are authoritative and re-inserting from a stale blob
--      would resurrect panes the user closed.
--   2. GUARD  — refuse to drop if any blob still describes a pane BINDING the
--      rows do not have. On a healthy corpus this is a no-op. It is
--      directional on purpose: rows ahead of the blob is the expected steady
--      state and passes; the blob ahead of the rows is the only shape that
--      loses data, and it halts the migration with counts and ids rather than
--      deleting silently.
--   3. DROP.

DO $$
DECLARE
  promoted_columns int;
  promoted_panes int;
BEGIN
  -- Re-runnable: PL/pgSQL prepares each SQL statement on FIRST EXECUTION, so
  -- an early return leaves the `workspaceState` references below unparsed and
  -- a second run against an already-contracted database is a clean no-op
  -- rather than a "column does not exist" error.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agent_sessions' AND column_name = 'workspaceState'
  ) THEN
    RAISE NOTICE 'workspaceState already dropped — nothing to sweep';
    RETURN;
  END IF;

  -- Same tolerance as `persistedWorkspaceStateSchema` (and as 0246): only a
  -- blob whose `columns` is a jsonb array is promoted, a pane's absent/null
  -- `scope` becomes an unbound row (NULL kind/target), and the retired `tabs`
  -- field is never read.
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
    AND NOT EXISTS (
      SELECT 1 FROM "agent_workspace_pane_columns" c WHERE c."workspaceId" = s."id"
    )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS promoted_columns = ROW_COUNT;

  -- Anchored on PANE rows, not column rows: the statement above has already
  -- created this session's column rows, so re-using that anchor here would
  -- match nothing.
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
    AND NOT EXISTS (
      SELECT 1 FROM "agent_workspace_panes" p WHERE p."workspaceId" = s."id"
    )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS promoted_panes = ROW_COUNT;

  RAISE NOTICE 'workspaceState final sweep: promoted % column(s), % pane(s) (agent-session SSoT epic, Phase 3 contract)', promoted_columns, promoted_panes;
END $$;--> statement-breakpoint
DO $$
DECLARE
  losing_panes int;
  losing_sessions int;
  sample text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agent_sessions' AND column_name = 'workspaceState'
  ) THEN
    RAISE NOTICE 'workspaceState already dropped — nothing to guard';
    RETURN;
  END IF;

  CREATE TEMP TABLE "_workspace_state_drift" AS
  SELECT
    b."workspaceId",
    b."paneId"
  FROM (
    SELECT
      s."id" AS "workspaceId",
      pane.value ->> 'id' AS "paneId",
      pane.value -> 'scope' ->> 'kind' AS "kind",
      pane.value -> 'scope' ->> 'targetId' AS "targetId"
    FROM "agent_sessions" s,
      LATERAL jsonb_array_elements(s."workspaceState" -> 'columns') WITH ORDINALITY AS col(value, ordinality),
      LATERAL jsonb_array_elements(col.value -> 'panes') WITH ORDINALITY AS pane(value, ordinality)
    WHERE s."workspaceState" IS NOT NULL
      AND jsonb_typeof(s."workspaceState" -> 'columns') = 'array'
      AND jsonb_typeof(col.value) = 'object'
      AND jsonb_typeof(col.value -> 'panes') = 'array'
      AND jsonb_typeof(pane.value) = 'object'
      AND pane.value ->> 'id' IS NOT NULL
  ) b
  -- A blob pane is "represented" when a row with the SAME id carries the SAME
  -- binding. `IS NOT DISTINCT FROM` because an unbound pane (picker) and a
  -- pane whose mint is still in flight both legitimately carry NULLs, which
  -- `=` would report as a mismatch.
  WHERE NOT EXISTS (
    SELECT 1 FROM "agent_workspace_panes" p
    WHERE p."workspaceId" = b."workspaceId"
      AND p."id" = b."paneId"
      AND p."kind" IS NOT DISTINCT FROM b."kind"
      AND p."targetId" IS NOT DISTINCT FROM b."targetId"
  );

  SELECT count(*), count(DISTINCT "workspaceId") INTO losing_panes, losing_sessions
  FROM "_workspace_state_drift";

  IF losing_panes > 0 THEN
    SELECT string_agg("workspaceId", ', ') INTO sample
    FROM (
      SELECT DISTINCT "workspaceId" FROM "_workspace_state_drift" ORDER BY "workspaceId" LIMIT 50
    ) s;
    RAISE EXCEPTION
      'Refusing to drop agent_sessions."workspaceState": % pane binding(s) across % session(s) exist ONLY in the blob. Dropping now would lose them. Session ids (up to 50): %',
      losing_panes, losing_sessions, sample
      USING HINT = 'Reconcile each session before re-running: open it in a current client (its verbs rewrite the rows), or DELETE its agent_workspace_pane_columns rows so this migration''s sweep promotes the blob wholesale.';
  END IF;

  DROP TABLE "_workspace_state_drift";
  RAISE NOTICE 'workspaceState drop guard: every persisted pane binding is represented in agent_workspace_panes';
END $$;--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "workspaceState";

--> Guarded, for the reason 0288 records: this runner keys applied migrations by
--> a hash of the file text, so a later edit re-runs it on every database that
--> already applied it, and `db:migrate` is the deployment command. A CHECK is
--> not idempotent by default — a second ADD of the same name fails — so both
--> halves are conditional. Widens targetKind to admit the 'ports' pane.
ALTER TABLE "agent_workspace_nodes" DROP CONSTRAINT IF EXISTS "agent_workspace_nodes_target_kind_chk";--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_workspace_nodes_target_kind_chk'
      AND conrelid = '"agent_workspace_nodes"'::regclass
  ) THEN
    ALTER TABLE "agent_workspace_nodes" ADD CONSTRAINT "agent_workspace_nodes_target_kind_chk"
      CHECK ("agent_workspace_nodes"."targetKind" IS NULL OR "agent_workspace_nodes"."targetKind" IN ('chat', 'terminal', 'page', 'ports'));
  END IF;
END $$;

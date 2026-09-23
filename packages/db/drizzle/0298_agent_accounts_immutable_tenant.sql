-- Custom SQL migration file, put your code below! --
-- Agent Accounts (L2·G2) — `agent_accounts.tenantId` is DERIVED from the owner
-- and IMMUTABLE (ADR 0005 §3.1, §4.1, F12). The CHECK in 0297 proves the
-- derivation at every write, but an UPDATE that rewrote the owner AND the tenant
-- together would satisfy it — re-homing an account (and every grant bound to
-- its tenant) into another security domain. The plane's own bindings refuse such
-- an account at resolve (binding_mismatch), but the reference row must not be
-- able to claim it either. `kind` and `ownerKind` are fixed the same way: the
-- plane's rebind refuses a changed kind or owner kind (ADR 0005 F17, F22), so a
-- row that changed them would describe an account the plane will never serve.
CREATE OR REPLACE FUNCTION agent_accounts_refuse_identity_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent_accounts: tenantId, kind and ownerKind are immutable'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_accounts_identity_immutable';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER agent_accounts_identity_immutable
  BEFORE UPDATE ON agent_accounts
  FOR EACH ROW
  WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId" OR OLD."kind" IS DISTINCT FROM NEW."kind" OR OLD."ownerKind" IS DISTINCT FROM NEW."ownerKind")
  EXECUTE FUNCTION agent_accounts_refuse_identity_change();

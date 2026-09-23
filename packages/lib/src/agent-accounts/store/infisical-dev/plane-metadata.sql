-- The plane's OWN metadata DB (ADR 0005 §2.3, §2.5 — "plane metadata DB, not
-- the app DB"): the rows plane-metadata-repository.ts reads and writes. ONE
-- owner for this shape (Control Board §1): this file.
-- docker-compose.yml mounts it into the metadata service's
-- /docker-entrypoint-initdb.d/ so `docker compose up` creates it on a fresh
-- volume without a separate step; CI does not re-paste this DDL.

-- The secret's version facts. previous_version, rotated_at and revoked_at are
-- the PLANE-ATTESTED facts the verifier consumes through describe (G1c R3), so
-- they live here and never in the main DB. pending_* is the uncertain-write
-- marker (G1c E1): set under the advisory lock before a replacing Infisical
-- write, cleared by the commit; a row that still carries it is
-- reconcile-required.
CREATE TABLE IF NOT EXISTS agent_account_secret_versions (
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  kind text NOT NULL,
  current_version integer NOT NULL,
  previous_version integer,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  pending_version integer,
  pending_digest text,
  pending_rotation boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, kind)
);

-- The account's bindings row (G1c R4): the PlaneBindings a grant's
-- bindingDigest is compared against, the PlaneScope they digest, and the
-- consenters pinned at the first put (G1c R2). rebind writes only this row,
-- CAS on policy_version, so it never moves the secret's version.
CREATE TABLE IF NOT EXISTS agent_account_plane_bindings (
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  kind text NOT NULL,
  bindings jsonb NOT NULL,
  scope jsonb NOT NULL,
  consenters jsonb NOT NULL,
  policy_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, kind)
);

-- The single-use ledger for OwnerConsent.consentId (G1c E2), in the PLANE's
-- store (G2 ruling 3): the main-DB writer is untrusted (R3), so a consumed
-- consent recorded there could be deleted and replayed. consume is one
-- INSERT … ON CONFLICT DO NOTHING; rows are swept once past expires_at (the
-- consent's max age — decideRebind refuses an older consent before it is
-- presented).
CREATE TABLE IF NOT EXISTS agent_account_consent_ledger (
  consent_id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_account_consent_ledger_expires_at_idx ON agent_account_consent_ledger (expires_at);

-- One Infisical project + one machine identity per tenant (D-29 = B), created
-- by the provisioner on the tenant's first put. Ids only: the identity's
-- Universal Auth client secrets are minted short-lived per operation
-- (ADR 0005 §3.3 rider i) and never stored.
CREATE TABLE IF NOT EXISTS agent_account_plane_tenants (
  tenant_id text PRIMARY KEY,
  project_id text NOT NULL,
  identity_id text NOT NULL,
  client_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Usage of standing (`always`) policies, per account (Codex review P1 on
-- #2705): the plane counts uses, in-flight requests and bytes sent, and
-- enforces the policy's caps from its OWN stored scope — a main-DB writer can
-- neither raise a cap nor reset a count. One row per grant; rows older than
-- two hours are swept on reserve.
CREATE TABLE IF NOT EXISTS agent_account_usage (
  grant_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  bytes_out integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agent_account_usage_account_started_idx ON agent_account_usage (tenant_id, account_id, started_at);

-- The refresh worker's per-account attempt ledger (L3·G3; ADR 0005 §5.1):
-- the `RefreshAttemptFact` `decideRefresh` reads as `lastAttempt` — consecutive
-- retryable failures, the time before which no refresh may be attempted, and
-- whether a rotation replay was seen. Timestamps are ms since epoch, as the
-- decision takes them. No material, ever. A successful refresh deletes the row.
CREATE TABLE IF NOT EXISTS agent_account_refresh_attempts (
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  attempt_at bigint NOT NULL,
  consecutive_failures integer NOT NULL,
  retry_at bigint,
  rotation_replayed boolean NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
);

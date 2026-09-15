-- The plane's OWN metadata DB (ADR 0005 §2.3, §2.5 — "plane metadata DB, not
-- the app DB"): the CAS advisory-lock bookkeeping row plane-metadata-repository.ts
-- reads and writes. ONE owner for this shape (Control Board §1): this file.
-- docker-compose.yml mounts it into the metadata service's
-- /docker-entrypoint-initdb.d/ so `docker compose up` creates it on a fresh
-- volume without a separate step; CI does not re-paste this DDL.
CREATE TABLE IF NOT EXISTS agent_account_secret_versions (
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  kind text NOT NULL,
  current_version integer NOT NULL,
  previous_version integer,
  bindings jsonb NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, kind)
);

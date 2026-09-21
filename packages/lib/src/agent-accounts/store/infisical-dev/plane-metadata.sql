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

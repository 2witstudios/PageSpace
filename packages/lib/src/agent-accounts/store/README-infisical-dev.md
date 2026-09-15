# Local Infisical OSS bring-up (dev/test only)

L1·G1b-store's integration tests (`store-adapter-infisical.integration.test.ts`)
run against a REAL self-hosted Infisical OSS instance, never a mock (Control
Board §7.3). This is the dev/CI bring-up for that instance — **not** the
production topology (D-21 revised puts self-hosted Infisical on its own Fly
app with its own Postgres + Redis, provisioned separately and approved by
Jono; this compose file never runs there).

## What's here

`docker-compose.yml` brings up three images:

- `infisical/infisical:latest` — the backend (pin to an exact tag before this
  becomes a CI fixture people rely on long-term; `latest` is fine for local
  iteration).
- `postgres:14-alpine` — Infisical's own database (`db` service).
- `redis:7-alpine` — Infisical's cache/queue.

Plus a **fourth container reusing the already-pulled `postgres:14-alpine`
image** (`metadata` service, exposed on `127.0.0.1:55433`): the credential
plane's OWN metadata database (ADR 0005 §2.3, §2.5 — "plane metadata DB, not
the app DB"). It holds `agent_account_secret_versions`, the CAS bookkeeping
row (`current_version`, `previous_version`, `bindings`, `rotated_at`,
`revoked_at`, `created_at`) that `decideCas` / `decideResolve` compare
against, and is the advisory-lock namespace `store-adapter-infisical.ts`
locks against (`packages/db`'s `withAdvisoryLock`).

`env.dev-fixture` (named to dodge the repo's blanket `.gitignore` `.env` rule
— it is not a real secret file) holds synthetic, non-production
`ENCRYPTION_KEY` / `AUTH_SECRET` for
this local instance only — safe to commit (see the file's own comment).

## Bring-up

```bash
cd packages/lib/src/agent-accounts/store/infisical-dev
docker compose up -d
```

Wait for the backend to report healthy (`docker logs infisical-dev-backend`
should show "PostgreSQL - Connected successfully" / "Redis successfully
connected" and start serving on :8080), then create the metadata table once:

```bash
docker exec -i infisical-dev-metadata psql -U plane_metadata -d plane_metadata <<'SQL'
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
SQL
```

## Admin bootstrap (once per fresh instance)

Infisical OSS has a headless bootstrap endpoint (undocumented in the public
docs as of 2026-09-15, verified directly against a fresh instance):

```bash
curl -s -X POST http://localhost:8080/api/v1/admin/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"email":"g1b-store@dev.local","password":"<a dev password>","organization":"pagespace-dev"}'
```

The response carries `organization.id` (export as `INFISICAL_DEV_ORG_ID`) and
`identity.credentials.token` — an **instance-admin access token**, used only
to provision per-tenant projects and machine identities in tests (never held
by an executor). Export it as `INFISICAL_DEV_ADMIN_TOKEN`. Bootstrap only
succeeds once per fresh Postgres volume; `docker compose down -v` before
re-running it.

## Running the integration test

```bash
export INFISICAL_DEV_ADMIN_TOKEN=<from bootstrap>
export INFISICAL_DEV_ORG_ID=<from bootstrap>
bun run --filter @pagespace/lib test -- src/agent-accounts/store/__tests__/store-adapter-infisical.integration.test.ts
```

The test provisions two throwaway tenant projects + Universal Auth machine
identities per run (one per `TENANT_A`/`TENANT_B` in the file, timestamped so
reruns don't collide) and never deletes them from the dev instance — that's
fine, the whole instance is disposable (`docker compose down -v` resets it).

Like every other `*.integration.test.ts` in this package, it is excluded
from the default `test` / `test:coverage` run (`vitest.config.ts`
`exclude` / `coverage.exclude`) and fails loudly rather than silently
skipping when `INFISICAL_DEV_ADMIN_TOKEN` is unset — set
`ALLOW_SKIP_DB_TESTS=1` for an explicit local opt-out (CI never sets it).

## What CI needs to replicate this

1. `docker compose -f packages/lib/src/agent-accounts/store/infisical-dev/docker-compose.yml up -d` and wait for the backend health check.
2. Create the `agent_account_secret_versions` table (above) — a one-time `psql` step, not a Drizzle migration (this table lives in the plane's own metadata DB, not `packages/db`'s schema).
3. Run the bootstrap curl above once per fresh run, capture `INFISICAL_DEV_ADMIN_TOKEN` / `INFISICAL_DEV_ORG_ID` as job env vars.
4. Run the integration test as shown above.
5. `docker compose down -v` to tear down (frees the CI runner's disk for the next job).

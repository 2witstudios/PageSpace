# Local Infisical OSS bring-up (dev/test only)

L1·G1b-store's integration tests (`store-adapter-infisical.integration.test.ts`)
run against a REAL self-hosted Infisical OSS instance, never a mock (Control
Board §7.3). This is the dev/CI bring-up for that instance — **not** the
production topology (D-21 revised puts self-hosted Infisical on its own Fly
app with its own Postgres + Redis, provisioned separately and approved by
Jono; this compose file never runs there).

## What's here

`docker-compose.yml` brings up three images:

- `infisical/infisical:v0.165.10` — the backend, pinned (this is a CI fixture
  now — see `.github/workflows/ci.yml`'s "Run Infisical store adapter
  integration suite" step). Bump deliberately, not by a surprise `:latest`
  re-pull.
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
It also holds `agent_account_plane_bindings` and the owner-consent single-use
ledger `agent_account_consent_ledger` (G2 ruling 3 moved it out of the main
DB). The adapter additionally needs a plane-held `WriteDigestKey` (32+ random
bytes; the tests generate one per run) for the pending-write HMAC.

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
connected" and start serving on :8080). The metadata table needs no separate
step: `plane-metadata.sql` (the one owner of this DDL — Control Board §1;
`plane-metadata-repository.ts` is the other side of the same contract) is
mounted into the `metadata` service's `/docker-entrypoint-initdb.d/`, so
postgres's own entrypoint creates it automatically the first time that
service's volume is initialized. To confirm it landed:

```bash
docker exec -i infisical-dev-metadata psql -U plane_metadata -d plane_metadata -c '\d agent_account_secret_versions'
```

The DDL runs only when the metadata volume is first initialized, and it uses
`CREATE TABLE IF NOT EXISTS`, so re-running it against an older volume does
NOT add new columns or tables. After any change to `plane-metadata.sql`, reset
the disposable dev volume: `docker compose down -v && docker compose up -d`.

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
cd packages/lib
TZ=UTC bunx vitest run --config vitest.integration.config.ts \
  src/agent-accounts/store/__tests__/store-adapter-infisical.integration.test.ts
```

The test provisions two throwaway tenant projects + Universal Auth machine
identities per run (one per `TENANT_A`/`TENANT_B` in the file, timestamped so
reruns don't collide) and never deletes them from the dev instance — that's
fine, the whole instance is disposable (`docker compose down -v` resets it).

Like every other `*.integration.test.ts` in this package, it is excluded
from the default `test` / `test:coverage` run (`vitest.config.ts`
`exclude` / `coverage.exclude`). When `INFISICAL_DEV_ADMIN_TOKEN` is unset
or the instance does not answer `/api/status`, the suite reports itself as
**skipped** (`describe.skipIf`) rather than crashing. CI does not accept that:
its dedicated step runs the file with the default and JSON reporters and fails unless every
test actually passed.

## What CI needs to replicate this

See `.github/workflows/ci.yml`'s "Bring up local Infisical OSS" /
"Bootstrap Infisical dev admin" / "Run Infisical store adapter integration
suite" / "Tear down local Infisical OSS" steps for the actual implementation
(part of the `unit-tests` job). In outline:

1. `docker compose -f packages/lib/src/agent-accounts/store/infisical-dev/docker-compose.yml up -d` and wait for the backend health check — `plane-metadata.sql`'s `/docker-entrypoint-initdb.d/` mount creates the metadata table automatically, no separate step.
2. Run the bootstrap curl above once per fresh run, capture `INFISICAL_DEV_ADMIN_TOKEN` / `INFISICAL_DEV_ORG_ID` as job env vars.
3. Run the integration test as shown above — CI runs it with the default reporter (a failure names its tests in the log) plus `--reporter=json`, and fails the step if the suite didn't fully execute as well as if it failed, so a broken bring-up can't silently report as skipped.
4. `docker compose down -v` to tear down (frees the CI runner's disk for the next job).

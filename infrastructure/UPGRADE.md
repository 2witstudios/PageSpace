# Infrastructure Upgrade Notes

Operator-facing notes for upgrading **existing** tenant/self-host deployments.
Each section lists the manual steps a live deployment needs before pulling the
new compose stack. Fresh deployments provisioned with
`scripts/generate-tenant-env.sh` need none of this — the generator already
emits everything below.

> ⚠️ **NEVER re-run `generate-tenant-env.sh` on a live deployment.** It
> regenerates ALL secrets — including `ENCRYPTION_KEY`, which makes every
> field-level-encrypted row in your existing database permanently unreadable,
> and `POSTGRES_PASSWORD`, which locks the stack out of its own data volume.
> It is a provisioning tool for new tenants only. Upgrades are always
> append-only edits to the existing `.env`.

## 2026-07 — Phase 1 admin database (issue #890)

The stack now runs a second PostgreSQL container, `postgres-admin` (the
"trust plane"), holding the tamper-evident security audit chain in isolation
from the app database. The compose file introduces three new variables and
**refuses to start** without `ADMIN_POSTGRES_PASSWORD` (the other two have
compose-level defaults — see Notes):

```
required variable ADMIN_POSTGRES_PASSWORD is missing a value:
ADMIN_POSTGRES_* missing from .env - see infrastructure/UPGRADE.md (Phase 1 admin DB)
```

### Steps

1. Generate a password for the admin database (32 alphanumeric characters,
   same shape `generate-tenant-env.sh` uses):

   ```bash
   openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c 32; echo
   ```

2. **Append** the following lines to the **existing** `.env`
   (e.g. `/data/tenants/<slug>/.env`) — do not remove or change any existing
   line. These mirror the `--- Admin Database (trust plane) ---` section of
   `env.tenant.template`:

   ```dotenv
   # --- Admin Database (trust plane) ---
   ADMIN_POSTGRES_DB=pagespace_admin
   ADMIN_POSTGRES_USER=pagespace
   ADMIN_POSTGRES_PASSWORD=<paste the generated password>
   ```

3. Pull and restart the stack as usual — via the wrapper if you deploy with it:

   ```bash
   ./scripts/tenant-stack.sh upgrade <slug>
   ```

   or with docker compose directly:

   ```bash
   docker compose -p ps-<slug> -f docker-compose.tenant.yml --env-file /data/tenants/<slug>/.env up -d
   ```

   The `migrate` one-shot now waits for both databases to be healthy and runs
   `db:migrate` followed by `db:migrate:admin`; the admin database reaches
   full schema (partitioned chain tables, zero-trust roles) on first boot.

### Notes

- `ADMIN_POSTGRES_DB` / `ADMIN_POSTGRES_USER` have compose-level defaults
  (`pagespace_admin` / `pagespace`); only `ADMIN_POSTGRES_PASSWORD` is
  strictly required. Set all three anyway so the `.env` matches the template.
- The admin database gets its own volume (`postgres_admin_data`); no existing
  data is touched.
- `ADMIN_POSTGRES_*` is the owner/bootstrap role and is handed only to the
  `postgres-admin` container and the `migrate` one-shot. Runtime services
  (web/processor/realtime) hold no admin credentials in Phase 1 — per-service
  least-privilege LOGIN roles arrive with the Phase 2 audit-write cutover.
- `ADMIN_DB_BREAK_GLASS=true` is a break-glass rollback flag only (audit
  writes fall back to the main DB and alert loudly). It is not a supported
  steady state — do not set it during a normal upgrade.

## 2026-07 — Phase 2 per-service admin login users (issue #890)

Runtime services no longer touch the admin database as its owner. The
`migrate` one-shot now runs `db:provision:admin-users` after
`db:migrate:admin`, creating one least-privilege LOGIN user per service and
attaching it to the NOLOGIN role templates from `drizzle-admin/0001`:

| login user               | granted templates          | used by             |
|--------------------------|----------------------------|---------------------|
| `admin_app_user`         | `admin_app`                | web                 |
| `admin_processor_user`   | `admin_chainer`, `admin_siem` | processor        |
| `admin_reader_user`      | `admin_reader`             | admin app (read-only) |
| `admin_gdpr_eraser_user` | `admin_gdpr_eraser`        | web GDPR pseudonymization route (Art 17 — column-scoped UPDATE on exactly the 6 PII columns, via `ADMIN_ERASER_DATABASE_URL`) |

`ADMIN_POSTGRES_*` (the owner) is now consumed **only** by the
`postgres-admin` container and the `migrate` one-shot. The compose stack
**refuses to start** without the four new password variables:

```
required variable ADMIN_APP_PASSWORD is missing a value:
ADMIN_APP/PROCESSOR/READER_PASSWORD missing from .env - see infrastructure/UPGRADE.md (Phase 2 admin login users)
```

### Steps (tenant / self-host)

1. Generate four passwords (alphanumeric is **required** — the compose stack
   embeds them in `ADMIN_DATABASE_URL` without URL-encoding):

   ```bash
   for i in 1 2 3 4; do openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c 32; echo; done
   ```

2. **Append** to the **existing** `.env` (mirroring the
   `--- Admin Database (trust plane) ---` section of `env.tenant.template`;
   as always, never re-run `generate-tenant-env.sh` on a live deployment):

   ```dotenv
   ADMIN_APP_PASSWORD=<generated password 1>
   ADMIN_PROCESSOR_PASSWORD=<generated password 2>
   ADMIN_READER_PASSWORD=<generated password 3>
   ADMIN_ERASER_PASSWORD=<generated password 4>
   ```

3. Pull and restart the stack as usual. Provisioning is idempotent and
   rotation-safe: re-running with a changed password rotates that login
   user's password.

### Fly (cloud) secret matrix

Owner credentials never sit in any Fly app's runtime secrets. The CI admin
migrate machine takes the owner URL from a **GitHub Actions secret** passed
to the one-shot machine only (`migrate-admin.ts` prefers
`ADMIN_DATABASE_URL_MIGRATE` over any inherited runtime URL):

| where                              | secret                       | value (connects as)      |
|------------------------------------|------------------------------|--------------------------|
| GitHub Actions (repo secret)       | `ADMIN_DATABASE_URL_MIGRATE` | owner — migrations + provisioning only |
| Fly `pagespace-web`                | `ADMIN_DATABASE_URL`         | `admin_app_user`         |
| Fly `pagespace-web`                | `ADMIN_ERASER_DATABASE_URL`  | `admin_gdpr_eraser_user` (GDPR pseudonymization route only) |
| Fly `pagespace-processor`          | `ADMIN_DATABASE_URL`         | `admin_processor_user`   |
| Fly `pagespace-admin`              | `ADMIN_DATABASE_URL`         | `admin_reader_user`      |
| Fly `pagespace-realtime`           | — (no audit path)            | —                        |

Provisioning the login users on Fly: run `bun run db:provision:admin-users`
once (e.g. on a one-shot machine or via `fly ssh console`) with
`ADMIN_DATABASE_URL_MIGRATE` set to the owner URL and the four
`ADMIN_*_PASSWORD` values exported for that run — then set each app's
runtime `ADMIN_DATABASE_URL` (and web's `ADMIN_ERASER_DATABASE_URL`) from
the matrix above. With `ADMIN_DB_MIGRATIONS_ENABLED=true`, the CI step fails
fast if `ADMIN_DATABASE_URL_MIGRATE` is missing.

Without `ADMIN_ERASER_DATABASE_URL`, the admin GDPR pseudonymization
endpoint refuses with 503 (it never silently skips the Admin PG or falls
back to another identity) — everything else is unaffected.

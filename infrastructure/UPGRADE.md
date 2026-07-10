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
from the app database. The compose file requires three new variables and
**refuses to start** without them:

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

3. Pull and restart the stack as usual:

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
- `ADMIN_DB_BREAK_GLASS=true` is a break-glass rollback flag only (audit
  writes fall back to the main DB and alert loudly). It is not a supported
  steady state — do not set it during a normal upgrade.

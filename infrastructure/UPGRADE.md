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

## 2026-07 — Phase 2 security_audit_log backfill & legacy freeze (issue #890)

Post-cutover, NEW security audit events chain in the Admin PG while all
pre-cutover history still sits in the MAIN db — invisible to the default
readers and to SIEM until it is backfilled. `scripts/backfill-audit-db.ts`
copies every legacy row admin-ward byte-for-byte (id, `chain_seq`,
`previous_hash`, `event_hash`, timestamp, encrypted PII columns preserved;
`emission_hash` stays NULL as the legacy-era marker), proves the WHOLE chain
genesis→head in the admin store, then — as a separate, explicitly confirmed
step — write-freezes the legacy table.

**ORDER IS LOAD-BEARING.** The chainer links its first batch onto whatever
the admin chain head is. Run the backfill BEFORE the chainer's first run and
the eras link seamlessly; let the chainer run first and it chains from
`'genesis'`, which can never be joined to the legacy history (chain columns
are append-only by design — no role can re-link them). The script refuses
that state (`unlinked_emission_era`), and the chainer itself refuses the
genesis link outright: on an empty admin head it logs
`REFUSING to chain … from a GENESIS head` and leaves the ingest rows
buffered until the backfill plants the legacy head
(`AUDIT_CHAINER_ALLOW_GENESIS` gate, below). Prevention is this run order:

1. **Prereqs.** Admin PG provisioned + migrated through `drizzle-admin/0008`,
   login users provisioned (previous sections). `ADMIN_DB_BREAK_GLASS` must
   NOT be set — the script refuses while break-glass is armed.
2. **Stop the processor** (tenant: `docker compose stop processor`; Fly:
   `fly scale count 0 -a pagespace-processor`). Web STAYS UP: with the
   Phase 2 cutover live, its audit events buffer losslessly in
   `security_audit_ingest`, which only the (stopped) chainer drains. SIEM
   delivery is also paused with the processor — nothing advances cursors.
3. **Dry-run** with the owner identities (never runtime roles — planting
   rows, `setval`, and historical-partition DDL exceed their grants on
   purpose):

   ```bash
   DATABASE_URL=<main owner url> \
   ADMIN_DATABASE_URL_MIGRATE=<admin owner url> \
     bun scripts/backfill-audit-db.ts
   ```

   Sanity-check the plan line: main row count, admin legacy/emission counts,
   the anchor row (the SIEM cursor watermark, committed last).
4. **Apply**: same command with `--apply`. The script holds the chainer's own
   advisory lock for the whole run (a forgotten-running chainer no-ops
   `lock_busy`), creates historical monthly partitions, copies in `chain_seq`
   order (batched, resumable; reruns are idempotent via ON CONFLICT), aligns
   `security_audit_log_chain_seq_seq` PAST the max legacy seq BEFORE the
   chainer can run again, plants the SIEM anchor row LAST (so when the
   deferral gate sees it, every legacy row is already visible), then asserts
   row-count parity, head-hash equality, era-boundary linkage, and a FULL
   era-aware genesis→head `verifySecurityAuditChain`. Exit 0 = all green;
   anything else: fix, re-run (safe), do NOT proceed.
5. **Start the processor.** Watch for `[audit-chainer] Chained N events
   (verify-on-append ok…)` — the first batch links onto the legacy head —
   and confirm SIEM: the `awaiting_backfill` deferral log line stops and the
   security source resumes delivery exactly once from its watermark.
6. **Soak**: the `verify-audit-chain` cron must be green (composite: chain +
   anchors), and forensic queries now see full history.
7. **Freeze** (separate invocation, deliberately not combinable with
   `--apply`):

   ```bash
   AUDIT_FREEZE_CONFIRMED=true \
   DATABASE_URL=<main owner url> \
   ADMIN_DATABASE_URL_MIGRATE=<admin owner url> \
     bun scripts/backfill-audit-db.ts --freeze
   ```

   Re-proves parity + genesis→head first, then revokes INSERT/DELETE/TRUNCATE
   on the main table and installs guard triggers that raise on every write —
   owner connections included — EXCEPT UPDATEs confined to the 6 eraser-scope
   PII columns, so the dual-store GDPR pseudonymization route keeps working
   against the retained legacy rows (Art 17 outlives the freeze).

### `AUDIT_CHAINER_ALLOW_GENESIS` — fresh installs ONLY

The chainer refuses to chain from a `'genesis'` (empty) admin head unless
the processor has `AUDIT_CHAINER_ALLOW_GENESIS=true`:

- **Fresh install** (no legacy `security_audit_log` rows anywhere): set it on
  the processor — there is no legacy history, so the genesis link is correct
  and there is nothing to backfill.
- **Upgrade** (legacy rows exist in the main db): NEVER set it. The head
  stays empty until step 4 above plants the legacy rows; the chainer's
  refusal (`genesis_refused` outcome, loud log every 30s cycle) is the guard
  that keeps a processor started too early from forking the eras. Once the
  backfill lands, the head is non-genesis and chaining resumes on its own —
  the flag is not needed afterwards on either path.

### Notes

- **Break-glass after the freeze can no longer append to the legacy table.**
  This is accepted by design: break-glass is an emergency-degraded mode, and
  post-freeze its audit writes fail loudly instead of silently forking
  history. Emergency unfreeze (owner, document the incident):
  `DROP TRIGGER security_audit_log_freeze ON security_audit_log;`
  `DROP TRIGGER security_audit_log_freeze_truncate ON security_audit_log;`
- **If the chainer ran first** (`unlinked_emission_era` refusal — only
  reachable when `AUDIT_CHAINER_ALLOW_GENESIS=true` was wrongly set on an
  upgrade): while the
  seeded SIEM cursor is still deferring, nothing external consumed the
  genesis-era rows — the owner can move them back into
  `security_audit_ingest` and delete them from the chained table, then run
  the backfill and let the chainer re-chain them onto the legacy head (exact
  SQL in the script header). DO NOT do this if anchoring
  (`AUDIT_ANCHOR_ENABLED`) was already on: published anchors are append-only
  witnesses (receipts table + S3 Object-Lock) and would attest tamper
  forever. In that case escalate; do not improvise.
- **Legacy cursor still `__cursor_init__`** (SIEM initialized but never
  delivered pre-flip): the seed copies the sentinel and there is no anchor
  row to gate on — the run order above (backfill before the processor
  starts) is the only protection. The script warns when it finds no anchor.
- **DROP of the legacy table is deliberately NOT part of this procedure** —
  it stays read-only through the soak period and is dropped by a Phase 6
  follow-up (tracked on the #890 board) once the admin store has soaked.
- **Rehearsal** (never against production): the wire-connected suites are the
  runbook in test form —
  `scripts/__tests__/backfill-audit-db.integration.test.ts` (plant/parity/
  verify/freeze) and
  `apps/processor/src/workers/__tests__/audit-backfill-flip.integration.test.ts`
  (real chainer + SIEM choreography). Start a scratch PG16
  (`docker run --rm -d --name pagespace-admin-smoke -p 55432:5432 -e
  POSTGRES_USER=admin -e POSTGRES_PASSWORD=admin -e
  POSTGRES_DB=pagespace_admin postgres:16`) and run both with
  `ADMIN_DATABASE_URL=postgresql://admin:admin@localhost:55432/pagespace_admin`.

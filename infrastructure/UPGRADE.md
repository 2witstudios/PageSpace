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

## 2026-08 — `agent_sessions` becomes `agent_workspaces` (epic #2161, Phase 5)

**Applies to every deployment.** Migration `0254_agent_workspaces_rename` renames
the agent-session tables, columns, indexes, constraints and the Sprite-reclaim
trigger so the schema matches the vocabulary the code has used since Phase 1:

| Before | After |
|---|---|
| `agent_sessions` | `agent_workspaces` |
| `agent_session_shells` | `agent_workspace_shells` |
| `agent_sessions.sessionKey` | `agent_workspaces.spriteKey` |
| `agent_session_shells.sessionId` | `agent_workspace_shells.workspaceId` |
| `agent_session_shells.streamSessionId` | `agent_workspace_shells.spriteExecId` |
| `conversations.sessionId` | `conversations.workspaceId` |
| `conversations.closedInSessionAt` | `conversations.closedInWorkspaceAt` |

**Nothing is dropped, recreated or rewritten.** Every statement is an
`ALTER ... RENAME`, so no row is touched and **no `agent_workspaces.id` value
changes** — which is the property that matters most here: every Sprite (the VM
backing a workspace's sandbox) is provisioned under a name HMAC-folded from that
id, so a rewritten id would orphan every running machine and strand its
persistent filesystem. The `machine_sprite_reclaims` AFTER DELETE trigger rides
the rename intact (`ALTER TABLE RENAME` carries triggers; `DROP TABLE` would
not), and the migration test deletes a real row to prove it still fires.

**Compat shims — valid for ONE release.** The migration installs auto-updatable
views named `agent_sessions` and `agent_session_shells` exposing the old column
names, and the app aliases `/api/agent-sessions/**` to
`/api/agent-workspaces/**` and still parses `?session=` alongside `?workspace=`.
They exist for the rolling-deploy window and the follow-up contract PR removes
all of them.

**⚠️ Do not skip the release that contains this migration.** A deployment that
jumps from a pre-0254 image straight past the next release lands on code that
has already dropped the shims, against a database whose views were never
created — the exact version-skipping hazard these notes exist for. Upgrade to
this release first, let it come up, then continue.

**One gap, deliberately:** `conversations` keeps its own table name, so there is
no name left to hang a compat view on and its two renamed columns have **no
shim**. Between the migrate one-off finishing and `web` finishing its roll, a
still-running pre-rename web instance will error on the agent session-listing,
claim, close and reopen reads. Chat, pages and sandboxes are unaffected, and the
window closes as soon as the roll completes. For a single-node self-host stack
(`migrate` one-shot gates the services), there is no window at all.

Take the usual pre-upgrade database snapshot. Rolling back to a pre-0254 image
requires renaming the tables and columns back.

## 2026-08 — Minimum upgrade path: agent pane grid (epic #2161, Phase 3 contract)

**Applies to tenant / self-host deployments that skip releases.** Cloud rolls
every release in order and needs nothing here.

The agent-session pane grid moved from a `agent_sessions.workspaceState` jsonb
blob to relational rows (`agent_workspace_pane_columns` /
`agent_workspace_panes` behind `agent_workspace_layout_revs`) in two steps:

| step | migration | what it does |
|------|-----------|--------------|
| expand | `0247_vengeful_veda` | creates the row tables, promotes every blob into them, KEEPS the blob and dual-writes it |
| contract | `0252_mighty_shaman` | final promotion sweep, refuses-to-drop guard, then `DROP COLUMN "workspaceState"` |

**The rule: never apply `0252` in the same `migrate` run as `0247` while the
old application image is still what restarts afterwards.** The two migrations
are safe to run back-to-back (0252 re-sweeps anything 0247 promoted, and the
guard proves nothing is lost) — what is NOT safe is leaving an application
image older than this release pointed at the contracted schema. A pre-0252
image still `SELECT`s and `UPDATE`s `workspaceState`, so the sessions list and
the pane-layout `GET`/`PUT` fail with `column "workspaceState" does not exist`
until the new image is up.

So, for a version-skipping upgrade:

1. Pull the new images FIRST (`docker compose pull`), so the post-migrate
   restart brings up code that never mentions the column.
2. Run `migrate` once — it applies every pending migration including 0247 and
   0252 in order.
3. Start the stack.

Degradation if you do it out of order is bounded to the window between the
migrate one-shot and the restart, and it is loud (500s on the agents sidebar
and the workspace route), not silent. Rolling back to a pre-0252 image after
the fact requires restoring the column, so take the usual pre-upgrade database
snapshot.

**If `migrate` HALTS** with `Refusing to drop agent_sessions."workspaceState"`,
that is the pre-drop guard doing its job: it found pane bindings that exist in
the blob and nowhere else, and it prints the affected session ids (up to 50).
Nothing has been dropped and the migration is safe to re-run. For each listed
session either open it once in the new client (its verbs rewrite the rows) or,
if you would rather take the blob wholesale, `DELETE FROM
agent_workspace_pane_columns WHERE "workspaceId" = '<id>'` — the migration's
sweep then promotes that session's blob from scratch on the next run.

## 2026-07 — Audit trust-plane mode contract (issue #890)

How a deployment's `adminDb` mode is resolved from env — this governs where
security audit writes land:

| `ADMIN_DATABASE_URL` | flags | mode | behavior |
|----------------------|-------|------|----------|
| set, valid postgres URL | — | `dedicated` | writes to the dedicated Admin PG (trust plane) |
| set, **invalid** URL | — | `fail` | halts (a positive misconfiguration must never silently degrade) |
| unset | `AUDIT_TRUST_PLANE_REQUIRED=true` | `fail` | halts loudly — you declared the trust plane required but did not configure it |
| unset | `ADMIN_DB_BREAK_GLASS=true` | `break-glass` | writes to the **main** DB + a LOUD alert on every process (explicit emergency override) |
| unset | neither flag | `main-db` | writes to the **main** DB, **SILENTLY** — the pre-trust-plane default |

Precedence when several apply (highest first):

1. **`ADMIN_DATABASE_URL` set but invalid** → `fail` (a positive misconfiguration
   must never silently degrade — beats every flag).
2. **`AUDIT_TRUST_PLANE_REQUIRED=true`** (URL unset) → `fail` (declared enforcement
   wins over both the emergency override and the silent default).
3. **`ADMIN_DB_BREAK_GLASS=true`** (URL unset, not required) → `break-glass`.
4. **neither flag** (URL unset) → `main-db`.

So with URL unset and BOTH flags armed, `AUDIT_TRUST_PLANE_REQUIRED` wins → `fail`
(the stricter declared intent is honored).

"Fail-closed" here refers only to **flag PARSING**: `true` is the sole value that
arms either flag (`TRUE`, `1`, ` true `, `''` do not). It does NOT mean both
flags fail the process — `ADMIN_DB_BREAK_GLASS=true` deliberately *degrades* to
the main DB (loudly); only `AUDIT_TRUST_PLANE_REQUIRED=true` (or an invalid URL)
halts.

**Unconfigured deployments need no action.** If you have not adopted the
dedicated Admin PG, leave `ADMIN_DATABASE_URL` unset and both flags unset: audit
writes run against the main application database exactly as they did before the
trust-plane epic, with no alert noise. Set `AUDIT_TRUST_PLANE_REQUIRED=true`
**only** if you WANT a missing `ADMIN_DATABASE_URL` to fail closed (i.e. you have
adopted the trust plane and a missing URL should halt rather than fall back).
`ADMIN_DB_BREAK_GLASS` is now purely an explicit emergency override.

> **Why this changed:** an earlier revision made an unset `ADMIN_DATABASE_URL`
> resolve to `fail`. Because audit writes are fire-and-forget, every write then
> threw and was swallowed as a warn log — security audit logging was silently
> broken wherever the Admin PG had not been provisioned. The default is now
> `main-db` (silent, working); loud failure is opt-in.

### Post-merge prod step (Fly) — drop the break-glass alert noise

The incident was mitigated live by setting `ADMIN_DB_BREAK_GLASS=true` on the
Fly apps, which restored main-DB audit writes but fires a loud alert on every
process. Once this change is deployed, the unconfigured→`main-db`-silent default
takes over, so **unset the break-glass flag** on each app to stop the noise:

```bash
fly secrets unset ADMIN_DB_BREAK_GLASS -a pagespace-web
fly secrets unset ADMIN_DB_BREAK_GLASS -a pagespace-processor
fly secrets unset ADMIN_DB_BREAK_GLASS -a pagespace-realtime
fly secrets unset ADMIN_DB_BREAK_GLASS -a pagespace-admin
```

Do this only AFTER the new code is deployed to each app. With the flag gone and
`ADMIN_DATABASE_URL` still unset, each app resolves to `main-db` and audit
writes continue against the main DB silently.

> ⚠️ This is safe **only because** `AUDIT_TRUST_PLANE_REQUIRED` is NOT set on
> these apps (unset → precedence rule 4 → `main-db`). If you had armed
> `AUDIT_TRUST_PLANE_REQUIRED=true` without configuring `ADMIN_DATABASE_URL`,
> unsetting break-glass would drop the app to `fail` (precedence rule 2) and
> break audit writes again. In that case, first set a valid `ADMIN_DATABASE_URL`
> (adopt the trust plane) or unset `AUDIT_TRUST_PLANE_REQUIRED` before removing
> break-glass. Verify with `fly secrets list -a <app>` that neither
> `ADMIN_DATABASE_URL` nor `AUDIT_TRUST_PLANE_REQUIRED` is present before running
> the unset commands above.

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
- `ADMIN_DB_BREAK_GLASS=true` is an explicit emergency override only (audit
  writes fall back to the main DB and alert loudly). It is not a supported
  steady state — do not set it during a normal upgrade. See the trust-plane
  behavior section below for the full mode contract.

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

## 2026-08 — `chat_messages` dropped, one message table (epic "Agent-Session Single Source of Truth", Phase 4 PR 15)

Migration **0253** DROPs `chat_messages` and `messages."pageId"`. **This is the
one migration in the epic with no code-level rollback.** Reverting the
deployment restores the readers, not the rows.

### MINIMUM UPGRADE PATH — you must pass through a release that carries the backfill

`chat_messages` was merged into `messages` across four releases. 0253 assumes
the copy is complete. A deployment that jumps straight from a pre-merge release
to this one is handled — 0253 re-runs the copy itself, because tenant/onprem
deployments can skip versions and have no operator to run a script — but the
supported path is still to land **at least one release that contains migration
0251** (`chat_messages VALIDATE CONSTRAINT`, the receipt that the copy is
completable) before this one, and to let it run.

Concretely: **do not deploy this release in the same step as a release older
than 0249.** 0249 synthesises the `conversations` rows that legacy page-chat
messages need; 0251 proves none are missing and RAISEs, naming the rows, if any
are. Both must have applied — and been looked at — before 0253 drops the table
they describe. This release must also ship **at least one release after** the
one containing 0251 (the soak gate), not alongside it.

If 0253 aborts, it is telling you `chat_messages` still holds rows `messages`
does not represent. It names up to 50 ids. The table is untouched; repair the
rows and re-run. Repair is a human decision — one option hands someone a chat
history and the other destroys one — so the migration will not guess.

### 1. TAKE A DATABASE SNAPSHOT FIRST — non-negotiable

There is no `--down`. Verify you have a restorable dump **from after your last
write and before this deploy**.

Cloud (Fly). The daily dump is produced by the scheduled `pagespace-db-backup`
machine (`fly/backup/backup.sh` in PageSpace-Deploy: `pg_dump -Fc` → AES-256 →
Tigris at `s3://$BUCKET_NAME/db-backups/pagespace-<date>.dump.enc`). Confirm
today's object exists before deploying:

```bash
aws s3 ls "s3://$BUCKET_NAME/db-backups/" --endpoint-url "$AWS_ENDPOINT_URL_S3"
```

If the newest object predates recent writes, do not rely on it — take a Fly
volume snapshot of the `pg_data` volume as well and confirm it lands:

```bash
flyctl volume snapshots list <pg_data-volume-id>
```

Restore path, for the record (`fly/FLY.md`, "Database Operations"):

```bash
fly proxy 5433:5432 -a pagespace-db &
pg_restore --no-owner --no-privileges -h localhost -p 5433 -U pagespace -d pagespace <dump>
```

Tenant / self-host: take your own `pg_dump -Fc` of the stack's database before
pulling the new compose stack. The migrate one-shot runs before the services
roll, so once it has succeeded the table is gone.

### 2. What changes, operationally

- **A cron job disappears.** `reconcile-message-unification` is removed from
  `docker/cron/crontab` along with its route. If you monitor cron logs, the
  `/var/log/cron/reconcile-message-unification.log` file simply stops being
  written; nothing needs to be un-scheduled by hand, the new image ships the
  new crontab.
- **`purge-deleted-messages` reports one fewer field.** `chatMessagesPurged` is
  gone from that cron's JSON response and audit detail. Anything scraping it
  should read `globalMessagesPurged`, which now counts every message.
- **Retention reports 13 tables, not 14.** `chat_messages` leaves the
  `runRetentionCleanup` result list.
- **Tenant export bundles no longer carry a `chat_messages` INSERT**, and
  `messages` no longer carries a `pageId` column. `conversations` gains
  `agentPageId`. Bundles produced by an OLDER exporter will not import into a
  0253 database.

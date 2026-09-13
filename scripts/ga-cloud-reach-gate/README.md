# Cloud-reach exit gate — the global assistant and CLOUD environments

The runbook for the app proof of **#2616** (`f7b4a24df`), phase
`de301c773t025ivjwf5ygtlb`.

**The story:** *from the dashboard, my global assistant can use any cloud
environment I could run code in myself, and nothing else.*

CI does not prove this. No CI job drives a dashboard conversation into a real
cloud environment, and the defect that made the whole feature dead in
production (`LOCAL_ENVS_ENABLED` gating the cloud path) was invisible to every
unit test because they injected the flag rather than reading it.

## Evidence format

The harness reuses `../env-bridge-exit-gate/report.ts`, so every check prints:

```
GATE <id> <PASS|FAIL|SKIP> expected=<value> actual=<value> :: <note>
```

`expected` is the exact reason, status or id — **never a category**. A category
assertion passes on the wrong refusal: `drive_access_denied` from an unaccepted
invite looks like a pass for a row that meant to test `insufficient_role`, and
proves nothing. A SKIP is an unfinished gate and makes the exit code non-zero.

## Configuration — production's, not a convenience

- `LOCAL_ENVS_ENABLED` **UNSET**. This is what every deployment runs, and it is
  the configuration the cloud path was broken under. Setting it would hide the
  regression this gate exists to catch.
- `CODE_EXECUTION_ENABLED=true` (the kill switch; nothing binds without it).
- `TZ=UTC` on this process **and** on the Postgres cluster
  (`ALTER DATABASE <db> SET timezone='UTC'`) — `sessions` timestamps are UTC
  wall-clock while `now()` resolves through the session timezone, so a non-UTC
  cluster mints a session that is already expired and every request 401s.
- A real Sprites token, and a real AI provider key (the model has to actually
  choose to call the tools).

## Order

```
# 1. clean database, migrated from zero
psql -c 'DROP DATABASE IF EXISTS gate; CREATE DATABASE gate'
psql -c "ALTER DATABASE gate SET timezone TO 'UTC'"
DATABASE_URL=… bun run --filter @pagespace/db db:migrate

# 2. seed EVERY precondition (nothing hand-applied)
DATABASE_URL=… TZ=UTC bun scripts/ga-cloud-reach-gate/seed-gate.ts > seed.json

# 3. prove the FIXTURE before spending a build slot on it
DATABASE_URL=… TZ=UTC CODE_EXECUTION_ENABLED=true \
  bun scripts/ga-cloud-reach-gate/preflight.ts seed.json

# 4. production build + server per the repo runbook, then the rows
GATE_BASE_URL=… bun scripts/ga-cloud-reach-gate/rows.ts seed.json
```

Step 3 is the guard against the M1 gate's standing lesson: a check that passes
because nothing was there is worse than no check. It asks `canRunCode` directly
and fails if drive V was seeded as an editor or drive X has a stray membership
row.

## The rows

| id | What it proves |
|---|---|
| `R1` | `list_environments` lists `p-env` and the own sandbox, and does NOT list `v-env` or `x-env` |
| `R2` | `bash` on `p-env` runs on the REAL Sprite (`uname -a` shows `-fly`), the session row carries `driveId = P`, and usage bills P's payer |
| `R3` | `bash` on `v-env` — a REAL id, pasted — is refused with the single `ENV_UNREACHABLE_MESSAGE` |
| `R4` | `bash` on `x-env` — a REAL id — gets the IDENTICAL message |
| `R5` | **Control for R3/R4.** Promote U to editor in V through the API; `v-env` then lists and runs. Without this, R3 could be passing because the fixture is broken |
| `R6` | **Revocation.** Demote U in P mid-conversation; the NEXT call to `p-env` is refused even though the session exists |
| `R7` | A PAGE agent conversation in P calling `bash` on `p-env` is refused (`not_global`) |
| `R8` | Screenshot of the dashboard chat for R1–R2, as a user sees it |

`R5` and `R6` change permissions through `PATCH /api/drives/<id>/members/<userId>`
— the real API a person uses — never `psql`. A gate that reaches past the
application to set up its own preconditions is testing a database, not a product.

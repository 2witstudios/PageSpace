# Phase A — harden the write path (leaves 2–5)

Branch `pu/mp-phase-a-rest`. Epic `i7qcdfg3evjpn5mbe9ux8mk2`, Phase A page
`tzwinckp7qnjhk1108p4668h`. Leaf 1 (the 409 buffer, PR #2447) was already merged; this finishes the
phase. Board tasks stay `in_progress` — they move to `completed` when the PR merges, and that is the
orchestrator's call, not mine.

Two commits:

- `34e883ff9` — leaves 1 and 2 (repository input, processor fence)
- `07a6c161d` — leaves 3 and 4 (onboarding seeder, content-store reclaim)

---

## 1. Remove `content` from `UpdatePageInput` — task `vthrzlmfb48a73rowrxj75fq`

**Acceptance: a caller that tries to set page content through the repository fails to compile.**

`UpdatePageInput` (`packages/lib/src/repositories/page-repository.ts:60`) declared `content?: string`
and `update` wrote it with a bare `db.update(pages).set(...)` — no revision CAS, no `page_versions`
row, no activity entry, no broadcast. No caller passed it, so removing it cost nothing.

Two halves:

- **Compile time.** The field is gone. `page-repository-update-input.test.ts` puts a
  `@ts-expect-error` on `content:` in an `UpdatePageInput` literal, so reintroducing the field makes
  the directive unused and fails `bun run typecheck`.
- **Runtime.** `update` throws on a `content` key. The type cannot help a caller that arrives through
  an `as` cast or an untyped JSON payload, and that is exactly the caller this leaf is aimed at.

**Mutation check.** Re-added `content?: string` to the interface → `tsc --noEmit` reported
`TS2578: Unused '@ts-expect-error' directive` at the test line. Removed the runtime `if ('content' in
data)` guard → the runtime test went red (`expected [Function] to throw error matching /content/i`).
Both restored, both green.

---

## 2. Fence the processor's raw content writes to FILE pages — task `nnxevoxe5b70xv3pwuzuimce`

**Acceptance: a non-FILE page refuses the extraction write and logs; a FILE page converted to
DOCUMENT after enqueue does not get its body overwritten.**

`decideExtractionWrite` (`apps/processor/src/extraction-write-guard.ts`) is the pure decision:
`FILE` → `write`, any other type → `skip-content`, missing page → `skip-all`.

`setPageCompleted` (`apps/processor/src/db.ts`) now runs `BEGIN` → `SELECT type … FOR UPDATE` →
decide → write → `COMMIT`, with a `ROLLBACK` on failure. The type is read **at write time under a row
lock**, not trusted from enqueue time, which is the whole point: `convert-to-document` can land in
that window.

On `skip-content` the processing bookkeeping (`processingStatus`, `extractionMethod`,
`extractionMetadata`, `processedAt`) still lands, and only the body is withheld. Without that the
converted page would sit `processing` forever and the stuck-page reconciler would eventually mark it
failed — a worse outcome than the bug being fixed.

**One correction to the task description.** It says
`workers/stuck-page-reconciler-worker.ts:218` runs `UPDATE pages SET content`. It does not — that
statement sets `processingStatus`, `processingError` and `processedAt`; there is no content write in
that file. The candidate scan already filters `p.type = 'FILE'`. The real gap there was the same
*shape* of hazard, so I closed it: the mark-failed UPDATE now re-checks `AND type = 'FILE'` at write
time, so a page converted between the scan and the write does not inherit a file's extraction
failure. No content clobber existed there to fix.

**Mutation check.** Made `decideExtractionWrite` return `{ action: 'write' }` unconditionally → 13
tests red across `db.test.ts` and `extraction-write-guard.test.ts`, including "given a page converted
to DOCUMENT after enqueue, never writes content". Separately deleted the `AND type = 'FILE'` line
from the reconciler's UPDATE → "re-checks the page type at write time" went red. Both restored.

---

## 3. One idempotent onboarding seeder — task `cqck0pqewbk72sprkqqq2pbq`

**Acceptance: two concurrent seeders produce exactly one set of seed pages; a re-run against a seeded
drive is a no-op.**

The four copies (`drive-setup.ts` and `home-drive.ts` in both `apps/web` and `apps/admin`, plus a
duplicated 8-file `faq/` tree in each) are now one implementation under
`packages/lib/src/onboarding/`, exported as `@pagespace/lib/onboarding/*`. Every importer — 20 route
and test files across web and admin — moved to the package path.

They had already drifted: admin's `seed-template.ts` still described agent delegation via `ask_agent`
where web's said `spawn_session`. Every new user created through the admin path was reading stale
documentation. Unified on web's copy. The web/admin `drive-setup.ts` difference was only the import
path for the AI defaults — both resolve to the same `DEFAULT_AI_PROVIDER`/`DEFAULT_AI_MODEL`.

`populateUserDrive` now wraps the whole seed in one transaction that takes `SELECT 1 FROM drives …
FOR UPDATE` **before** checking whether the scope is populated, then decides via the pure
`decideDriveSeeding`. A loser of the race blocks on the lock, then reads the winner's pages and
returns `{ seeded: false }`. Return type changed from `void` to `{ seeded: boolean }`.

**Mutation check.** Removed the `existingPageCount > 0` branch from `decideDriveSeeding` → 3 red,
including "given two seeders racing on the same drive, exactly one set of seed pages results" and
"re-running is a no-op rather than a second copy". Separately removed the `FOR UPDATE` statement →
"takes the drive row lock before deciding whether to seed" went red. Both restored.

The concurrency test drives two `populateUserDrive` calls through a database stand-in whose
`transaction` serialises bodies (what the row lock buys in Postgres) and whose reads see prior
inserts; it asserts exactly one "Welcome to PageSpace" insert and that the bodies never overlapped.

---

## 4. Reclaimable content-addressed store — task `ubpt7fvtjdi8haa0t5q1p901`

**Acceptance: a blob two pages reference survives one of them being deleted; the last reference
dropping removes the object.**

`deletePageContent(ref, options?)` in `packages/lib/src/services/page-content-store.ts`. The decision
is pure (`page-content-reclaim.ts`); the S3/filesystem/pg calls stay at the boundary.

Four things this had to get right, since it is the one leaf that can destroy data:

- **Refcount, not ownership.** `getS3Key` shards by hash prefix with no tenant scoping, so one object
  is shared by every page in every drive of every tenant whose content hashes the same.
  `countPageContentReferences` counts across **both** tables that can hold a ref — `page_versions`
  and `activity_logs`. Missing the second would have deleted live content.
- **A coverage guard against the next table.** `page-content-ref-coverage.test.ts` reads the schema
  source, finds every file declaring a `contentRef` column, and fails if it is not in the counted
  set. An uncounted table makes a referenced blob read as unreferenced — the exact failure mode that
  silently deletes data, and the one no ordinary test would catch.
- **An age floor.** `writePageContent` is HEAD-then-PUT: a writer that finds the object present skips
  the upload and stores the ref. A reclaim landing between that HEAD and the writer's row insert
  leaves the new ref pointing at nothing. Blobs younger than `RECLAIM_MIN_AGE_MS` (24h) are never
  reclaimed, which bounds that window far beyond any request.
- **Fail closed.** An object whose age cannot be determined is retained, not deleted. Not being able
  to date something is not evidence that it is old.

Ordering contract, documented on the function: callers delete their rows and commit **first**, then
call. An uncommitted delete reads as "still referenced" and retains the blob — the safe direction.

Pre-cutover content that still lives only on the filesystem (mirroring `readPageContent`'s fallback)
is reclaimed there. Without that branch it would be unreclaimable forever, which would quietly
undermine the GDPR-erasure use case this exists for.

`deletePageContent` has no caller yet — by design; it is the prerequisite the task describes.

**Mutation check.** Removed the `still-referenced` and `too-young` branches from `decideBlobReclaim`
and dropped `activityLogs` from `CONTENT_REF_SOURCES` → 8 red, including "given two pages share the
ref and one is deleted, keeps the blob", "counts references from activity logs too", "never reclaims
a blob written moments ago", and the schema-coverage guard. Restored, green.

---

## Gates

- `bun run typecheck` (monorepo root) — **17 successful, 17 total**. `web:build` compiled, so the new
  `@pagespace/lib/onboarding/*` export entries resolve.
- `bun run lint` (monorepo root) — **15 successful, 15 total**.
- `bunx knip` — exit 0, no new findings.
- Tests — **15 successful, 15 total** (`@pagespace/lib` 458 files, `web` 1197, `@pagespace/processor`
  68, plus db/sdk/realtime/admin/control-plane/cli/desktop/e2e/marketing). Zero failures.

Docker is unavailable in this worktree, so `bun run test` (which starts a test Postgres container)
could not be used as-is. The suite ran against a local Postgres 17 on 5433 with the same credentials,
database name and migrations the script creates, and the same env and turbo invocation the script
uses, plus the `ADMIN_DATABASE_URL` scratch database CI provisions (`docker-compose.test.yml` does
not create it, so the four suites gating on it cannot pass under `bun run test` locally either).

Two things about that environment are worth writing down, because both looked like real failures:

- The first run failed `locked-batch-reorder.integration` and `chat-mutation-matrix.integration`.
  Both were my Postgres running in local time: the reorder assertion was off by exactly 18,000,000 ms
  = 5 hours. `ALTER DATABASE … SET timezone TO 'UTC'` turned both green. CI's container is UTC, which
  is why these never surface there — the same blind spot `packages/lib` already carries a note about
  for `now()` vs `(now() at time zone 'utc')`.
- Four suites (`gdpr-eraser`, `audit-chainer-worker`, `audit-backfill-flip`, `siem-delivery-worker`)
  hard-fail rather than skip without `ADMIN_DATABASE_URL`, by design. Pointing it at a second local
  database turned all four green.

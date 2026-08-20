# Phase A — harden the write path (leaves 2–5)

Branch `pu/mp-phase-a-rest`. Epic `i7qcdfg3evjpn5mbe9ux8mk2`, Phase A page
`tzwinckp7qnjhk1108p4668h`. Leaf 1 (the 409 buffer, PR #2447) was already merged; this finishes the
phase. Board tasks stay `in_progress` — they move to `completed` when the PR merges, and that is the
orchestrator's call, not mine.

Three commits: leaves 1–2, leaves 3–4, then a cleanup pass (`/simplify`, four review
angles) whose findings are folded into the sections below rather than described separately.

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
- **Runtime.** `assertNoContentWrite` throws on a `content` key. The type cannot help a caller that
  arrives through an `as` cast or an untyped JSON payload, and that is exactly the caller this leaf is
  aimed at.

The guard is shared, not inlined, because `pageRepository.update` is not the only seam of this shape:
`agentRepository.updateConfig` (`agent-repository.ts:96`) spreads an equally widened
`Record<string, unknown>` into the same bare `db.update(pages).set(...)`. Hardening one and not the
other would have left the identical hazard one file away. Both now call the guard, and both are
tested.

**Mutation check.** Re-added `content?: string` to the interface → `tsc --noEmit` reported
`TS2578: Unused '@ts-expect-error' directive` at the test line. Replaced the body of
`assertNoContentWrite` with `return;` → both runtime tests went red. Restored, green.

---

## 2. Fence the processor's raw content writes to FILE pages — task `nnxevoxe5b70xv3pwuzuimce`

**Acceptance: a non-FILE page refuses the extraction write and logs; a FILE page converted to
DOCUMENT after enqueue does not get its body overwritten.**

`decideExtractionWrite` (`apps/processor/src/extraction-write-guard.ts`) is the pure decision:
`FILE` → `write`, any other type → `skip-content`, missing page → `skip-all`.

`setPageCompleted` (`apps/processor/src/db.ts`) is **one statement**:

```sql
SET content = CASE WHEN type = $1 THEN $2 ELSE content END, "processingStatus" = $3, … RETURNING type
```

The UPDATE takes the row lock itself and evaluates `type` against the same row version it writes, so
nothing can convert the page in between — which is the whole point, since `convert-to-document` can
land in that window. `decideExtractionWrite` is fed from `RETURNING type` and drives the logging.

I first wrote this as `BEGIN` → `SELECT … FOR UPDATE` → decide → write → `COMMIT`. The cleanup pass
flagged the two near-identical UPDATE strings and the three extra round trips, and it was right: a
single UPDATE gives the same guarantee. It also matches the reconciler's existing shape.

The bookkeeping (`processingStatus`, `extractionMethod`, `extractionMetadata`, `processedAt`) lands
either way; only the body is withheld. Without that the converted page would sit `processing` forever
and the stuck-page reconciler would eventually mark it failed — a worse outcome than the bug.

**The collapse moved the guard from TypeScript into SQL, so the unit tests could no longer execute
it** — a mocked pg driver cannot evaluate a `CASE`. Asserting the statement's shape would have been a
proxy for the property, so the fence is now covered by
`workers/__tests__/set-page-completed.integration.test.ts`, which runs it against a real Postgres:
insert a DOCUMENT page with an authored body, call `setPageCompleted`, assert the body is untouched
and the bookkeeping landed.

**One correction to the task description.** It says
`workers/stuck-page-reconciler-worker.ts:218` runs `UPDATE pages SET content`. It does not — that
statement sets `processingStatus`, `processingError` and `processedAt`; there is no content write in
that file. The candidate scan already filters `p.type = 'FILE'`. The real gap there was the same
*shape* of hazard, so I closed it: the mark-failed UPDATE now re-checks `AND type = 'FILE'` at write
time, so a page converted between the scan and the write does not inherit a file's extraction
failure. No content clobber existed there to fix.

**Mutation check.** Replaced the fence with `CASE WHEN $1::text IS NOT NULL` — valid SQL, no fence —
and the integration suite went red with the thing that actually matters:
`expected 'text pulled out of the PDF' to be '<p>a paragraph a person wrote after converting the
file</p>'`. The authored body was genuinely clobbered. Also removed the `AND type = $3` predicate
from the reconciler's UPDATE → "re-checks the page type at write time" went red. Both restored.

**A latent test-harness defect surfaced on the way.** `apps/processor` runs in a single fork, so
`process.env` is shared across all 67 test files, and three suites assign a placeholder
`DATABASE_URL` that outlives them. Any later suite talking to a real Postgres inherited
`postgresql://localhost:5432/test` and died with `database "test" does not exist` — order-dependent,
and invisible until this PR added the first such suite. Fixed once in `src/test/setup.ts` (stash the
pristine value, restore before each file) rather than in each of the three offenders.

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
FOR UPDATE` **before** checking whether the scope is populated. A loser of the race blocks on the
lock, then reads the winner's pages and returns `{ seeded: false }`. Return type changed from `void`
to `{ seeded: boolean }`.

I had put the two-outcome check behind a pure `decideDriveSeeding` returning a tagged union; the
cleanup pass pointed out the caller only ever compared `.action === 'skip'` and never read the
`reason`, making it a boolean in costume. Inlined, and the module, its test and its exports entry are
gone. (`decideExtractionWrite` and `decideBlobReclaim` kept their shape — three and four outcomes
respectively, with the reason consumed by the caller.)

**Mutation check.** Removed the already-seeded branch → "re-running is a no-op rather than a second
copy" and the two-seeder test went red. Separately removed the `FOR UPDATE` statement → "takes the
drive row lock before deciding whether to seed" went red. Both restored.

**What the two-seeder test does and does not prove.** It drives two `populateUserDrive` calls through
a database stand-in and asserts exactly one "Welcome to PageSpace" insert. But that stand-in
serialises transaction bodies unconditionally, so serialisation is *assumed* there, not demonstrated
— removing the `FOR UPDATE` leaves it green. I originally described it as covering the race; it does
not. What it covers is that the seeder does the right thing given serialisation. That the lock is
taken, and taken before the existence check, is the separate `invocationCallOrder` test. I dropped
the `maxConcurrentBodies` assertion, which only ever restated a property of the fake.

---

## 4. Reclaimable content-addressed store — task `ubpt7fvtjdi8haa0t5q1p901`

**Acceptance: a blob two pages reference survives one of them being deleted; the last reference
dropping removes the object.**

`deletePageContent(ref, options?)` in `packages/lib/src/services/page-content-store.ts`. The decision
is pure (`page-content-reclaim.ts`); the S3/filesystem/pg calls stay at the boundary.

Four things this had to get right, since it is the one leaf that can destroy data:

- **Reference check, not ownership.** `getS3Key` shards by hash prefix with no tenant scoping, so one
  object is shared by every page in every drive of every tenant whose content hashes the same.
  `pageContentIsReferenced` consults **every** table that can hold a ref. Missing one would delete
  live content.
- **The table list is derived from the schema, not maintained by hand.** It walks the `@pagespace/db`
  barrel for tables with a `contentRef` column. My first version hardcoded the two tables and added a
  test that regex-scanned the schema *source* to catch drift — with a comment asserting runtime
  enumeration was impossible. That was simply wrong: `getTableColumns` makes it a three-line walk,
  two existing suites in this repo already do it, and the source scan it replaced was file-granular
  and blind to any `contentRef` not declared as a literal `text(` call. The guard now compares the
  store's derived list against an independent walk, plus a floor assertion so a broken barrel cannot
  silently produce an empty list (which would read as "nothing references anything").
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

The reference check is an existence probe rather than a count: the decision is binary, and neither
`contentRef` column is indexed, so counting every match would scan the whole version history and
activity log to learn what the first row settles. It also runs **before** the storage HEAD, since a
referenced blob is kept whatever its age. `DeletePageContentResult` is a discriminated union, so a
retain always carries its reason and a caller cannot read an absent one.

**Follow-up, deliberately not in this PR:** neither `contentRef` column is indexed, so even the
existence probe seq-scans both tables when a blob is unreferenced — which is the common case for
reclaim. A partial index (`ON ("contentRef") WHERE "contentRef" IS NOT NULL`) belongs in the change
that first calls this on a real workload; adding a migration here, with no caller, would be staging
risk for no benefit. Noted in the code as well.

**Mutation check.** Removed the `still-referenced` and `too-young` branches from `decideBlobReclaim`
→ red, including "given two pages share the ref and one is deleted, keeps the blob" and "never
reclaims a blob written moments ago". Restored, green.

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

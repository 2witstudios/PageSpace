# Content safety PR 5: avatars, backfill, enforce readiness

Branch `pu/cs-avatars-backfill`, based on `pu/cs-publish-gate` (`1baa87eae`). Brief: `~/.claude/plans/cs-pr5-brief.md`.
Nothing pushed, no PR opened, `master` untouched.

## What this PR does

1. **Avatar uploads are scanned** before they replace the current avatar.
2. **Backfill and rescan cron** for content that was public before PR 4: the publish bucket's `assets/` and every `avatars/` object.
3. **Video with no classifier output is `unverified`**, not `clean` (PR 4 open item). Configurable.
4. **Enforce readiness** on the admin content console.
5. Changelog, env docs, crontab, compose.

Enforce is **not** turned on. It stays an env change (`CONTENT_SCAN_MODE=enforce`).

## Steps

### 1. Avatars

Choke point: `POST /api/avatar/upload` in `apps/processor/src/api/avatar.ts`. The decision runs **before** `deleteUserAvatars`.

| Step | Where | Every mode? |
|---|---|---|
| Bytes must be a real JPEG, PNG, GIF or WebP (magic bytes). File name and declared type decide nothing | processor (`services/avatar-gate-client.ts`) and again in the web gate | yes |
| On-prem: blocklist only, read by the processor | processor | — |
| Otherwise the processor posts the bytes to `POST /api/internal/content-safety/avatar-gate` (service secret, uploader ID, 50 s timeout, below the web account route's 60 s). The web app runs `gateAvatarUpload` (lib) **in the web app's own mode**: PR 4's gate on the in-memory bytes (blocklist, fresh verdict, scan with timeout, the same outcome table; `off` is the blocklist only). A processor left without `CONTENT_SCAN_MODE` therefore cannot skip the scan | web | — |
| No answer from the web app (unreachable, timeout, error status, bad body, not configured): the processor reads the blocklist itself and refuses a blocked hash, or one it can't check. That catches a hash-match takedown still in flight, because the takedown blocks first. Then the processor's `CONTENT_SCAN_MODE` decides: `enforce` refuses; anything else accepts, logged | processor | — |
| Store under the extension and `ContentType` **of the sniffed type**, not the uploader's. The served `Content-Type` comes from the extension | processor | yes |

**Why the gate runs in the web app.** The brief allows "an equivalent you justify". Every executor the outcomes need is already wired in the web app, and nowhere else:
- the Hive key;
- the review queue and urgent alert;
- for a hash match, PR 2's global takedown, which needs the uploads, publish and evidence buckets.

Running the whole gate there keeps one implementation and one set of credentials. The processor stays the choke point for the bytes: nothing is deleted or written until the web app answers. The processor needs only `CONTENT_SCAN_MODE`, `SERVICE_API_SECRET` and `WEB_APP_INTERNAL_URL`.

**Outcomes** (PR 4's table, applied to an avatar):

| Outcome | enforce | shadow |
|---|---|---|
| not a real image | 400 "Please upload a JPEG, PNG, GIF or WebP image." | same |
| blocklisted | 422 (neutral message) | same |
| hash match | refused. The bytes are written to `files/<hash>/original`, so the global takedown's preserve step finds them, copies them to evidence, then deletes them. Then PR 2's global takedown runs (category csam, system actor): block, case, urgent alert | **same** |
| classifier flag | refused. Review case opened or joined, urgent alert, verdict `flagged` | accepted; same records, case and alert |
| scan error / Hive timeout / no key (inside the web gate) | refused | accepted, recorded |
| web app gives no answer (see above) | blocklist checked, then refused (logged) | blocklist checked, then accepted (logged). **Nothing is recorded**; the backfill scans it on its next pass |
| clean | accepted | accepted |

- Every refusal shows the uploader the same neutral text: "This image can't be used as a profile picture. Please try a different image."
- The web account route (`apps/web/src/app/api/account/avatar/route.ts`) maps the processor's 422, and its 400 with `code: 'not_an_image'`, to fixed messages. It never forwards the processor's text. Any other processor 400 (no file, a bad user ID) is a generic 500.
- **Bug fixed on the way:** the web account route used to DELETE the old avatar before forwarding the upload. A refused (or failed) upload therefore destroyed the current avatar. That pre-delete is gone; the processor replaces the avatar only after the gate passes.
- The verdict is recorded in `content_scans` under the SHA-256 of the bytes. Re-uploading the same bytes within the TTL costs no vendor call.
- Audit:
  - `content.scan.*`, with `entryPoint: 'user_avatar'`, `fileId: null`;
  - plus the new `content.avatar.rejected` (reason `not_an_image` / `blocked` / `held`, the gate's finding, the mode). Its `resourceId` is the content hash.

### 2. Backfill and rescan

| Piece | File |
|---|---|
| Pure walk, dry run, config, key parsing | `packages/lib/src/content-safety/backfill.ts` |
| Cursor (lease, save, read) | `packages/lib/src/content-safety/backfill-store.ts`, table `content_scan_backfill` |
| Real dependencies and what each finding does | `apps/web/src/lib/content-safety/backfill-service.ts` |
| Route | `apps/web/src/app/api/cron/content-safety-backfill/route.ts` |
| Schedule | `docker/cron/crontab`: `*/10 * * * * flock -n /run/content-safety-backfill.lock cron-curl …` |

**The walk:**
- **Order.** It lists `assets/` in the publish bucket, then `avatars/` in the uploads bucket, in key order, using `StartAfter` from the persisted cursor. Unlike a continuation token, a key never expires.
- **Rate limit.** At most `CONTENT_SCAN_BACKFILL_ITEMS_PER_TICK` objects per tick (default 25, max 500). Every ten minutes, that is at most 150 vendor calls an hour by default.
- **Resumable.** The cursor is saved after every page, only by the run holding the lease (`WHERE lease_until = <claimed>`). A run whose lease was taken over fails its save and writes nothing. A tick stops at half its 30-minute lease, mid-page if needed, so its lease can't expire under it. A truncated listing page with no keys ends the tick. If an object can't be checked (the blocklist is unreachable, for example), the tick stops *before* it, and the next tick retries it. The failed key is never logged or returned: avatar keys name users.
- **Idempotent.** Each object goes through `evaluatePublishAsset`. A fresh verdict (clean, flagged by the classifier, unscanned, unverified) is skipped with no read and no vendor call. No verdict, an expired `clean`, or an `error` is scanned.
- **One at a time.** A lease on the cursor row (`lease_until`, conditional UPDATE) works across containers. `flock` covers one container. A tick that dies leaves the lease to expire after 30 minutes.
- **Re-passes.** When a pass finishes, `last_completed_at` and `last_pass_counts` are set. The next pass starts `CONTENT_SCAN_BACKFILL_REPASS_HOURS` later (default 24). That is the rescan: expired `clean` verdicts (TTL as in PR 4, default 30 days) are scanned again.
- **`scanned`** counts only vendor calls. An unreadable or oversized source is an error with no call.
- **Oversized avatars.** An `avatars/` object over 6 MB was not written by the processor. It is counted as an error, so readiness blocks, rather than being hashed from its first bytes.
- **No bare deletes of the only copy.** Wherever the content may be illegal and the public or avatar copy may be the last one (hash match, block), the copy is held or staged privately first, or only hidden. The one bare public delete is a classifier flag under enforce, where the private original stays.
- **What is scanned.**
  - A public asset `assets/<hash>`: the bytes being served.
  - A derived copy `assets/cache/<hash>/…`: gated as its private original, as PR 4 does.
  - An avatar: read from the uploads bucket and keyed by the SHA-256 of its bytes.
- **No-op** on-prem (`isOnPrem()`), with `CONTENT_SCAN_MODE=off`, and without `HIVE_API_KEY`. A walk that records nothing must not mark existing content as checked.

**What a finding does on already-public content:**

| Finding | enforce | shadow |
|---|---|---|
| blocked (blocklisted hash still served), asset | taken off the web with the takedown's own hold-then-delete (`takePublicOffline`: a verified private copy under the block's case, then the delete). A block with no case holds under `content-hold/backfill-uncased/` | same |
| blocked, avatar | bytes staged to the hash's private (blocked, never served) key, then the avatar is deleted. If staging fails, the avatar is only **hidden** (profile image cleared), never deleted, and the walk stops before it so the next tick (10 minutes) retries | same |
| hash match, asset | global takedown (removes the public copy, holding it privately first). If it stopped part-way with a case, the public copy is taken down the same way under that case. If it opened no case (it threw), nothing is deleted and the walk retries the item | same |
| hash match, avatar | bytes staged for preservation, global takedown, then an `avatar` takedown case (deletes the objects, clears the profile image). The avatar comes down even if the global takedown stopped part-way. If staging fails, the global takedown still runs (block, case, alert; it never touches `avatars/`) and the avatar is **hidden**, not deleted: it is the only copy. The walk stops before it; on the next tick the hash is blocked, and the blocked path stages before it deletes | same |
| classifier flag | review case + alert; **public copy removed** (`deletePublishedAssetsForHash`) or avatar removed (`removeUserAvatar`): no block. Audited `content.backfill.unpublished` | review case + alert; stays up |
| error, unscanned type, unverified video | stays up, counted. A republish holds it under enforce | stays up |

Errors stay up on purpose: those files were public before the gate, and a vendor outage must not take sites down.

### 3. Video with no classifier output

- `refineScanOutcome` (`scan-policy.ts`): a **video** whose scan is `clean` with no classifier scores becomes `unverified`.
- `unverified` is held under enforce, and promoted but recorded under shadow. The verdict is `unverified/unverified` and the audit event `content.scan.unverified`.
- A fresh `unverified` verdict is held without a rescan.
- `CONTENT_SCAN_ALLOW_UNCLASSIFIED_VIDEO=true` relaxes it. A stored `unverified` is then scanned again and comes back `clean`.
- Images keep PR 4's reading, because the classifier legitimately skips images under 100×100.
- The admin "Publish scans" table labels it "Video not classified (held under enforce)".

### 4. Enforce readiness

On the content console's **Publish scans** tab, above the verdict counts. Sources:
- `GET /api/admin/content/readiness?days=14` (admin);
- `GET /api/internal/content-safety/readiness` (web: service secret plus an active admin). It returns booleans and the resolved mode, never a value.

Pure assessment in `packages/lib/src/content-safety/readiness.ts`:

| Check | Blocks enforce when |
|---|---|
| `HIVE_API_KEY` | not set on the web app (or the web app can't be asked) |
| `EVIDENCE_BUCKET` | not set |
| `ABUSE_EMAIL` | not set (alerts fall back to the contact address) |
| Backfill | never started, first pass not finished, or the last pass had objects that could not be checked (`errors > 0`, e.g. a revoked key answering 401). Info items: keys the walk does not recognise (`ignored`), and a missing `PUBLISH_BUCKET` |
| Shadow-mode results | no shadow verdicts in the last N days. Otherwise info: counts of flagged, hash matches, errors, unscanned types, unverified videos, clean |
| Flagged scans reviewed | any flagged case still `reported` |
| Video classifier | info, while unclassified video is held |
| Processor environment | manual |
| Counsel sign-off | manual |

## Files

- **DB**
  - `packages/db/src/schema/content-safety.ts`: `content_scan_backfill`; `unverified` verdict and outcome (text columns, no migration for those).
  - `packages/db/src/schema/security-audit.ts`: `content.scan.unverified`, `content.avatar.rejected`, `content.backfill.unpublished`.
  - Migration `packages/db/drizzle/0387_content_scan_backfill.sql` (one `CREATE TABLE`), generated by `bun run db:generate`. Same numbering quirk as PRs 1, 3 and 4: drizzle-kit named it `0356_*` and overwrote `meta/0356_snapshot.json`. I restored that snapshot from git and renamed the new files to `0387_*`, with the journal tag to match. The SQL is untouched. A second `db:generate` reports "No schema changes".
- **Lib** (`packages/lib/src/content-safety/`)
  - New: `avatar-gate.ts`, `backfill.ts`, `backfill-store.ts`, `readiness.ts`.
  - Changed:
    - `publish-gate.ts`: `evaluatePublishAsset` and `GateFinding`; entry points `user_avatar` and `backfill`; `fileId` nullable.
    - `scan-policy.ts`: `unverified`, `refineScanOutcome`.
    - `scan-mode.ts`: `allowUnclassifiedVideo`.
    - `scan-store.ts`: `findScanVerdicts`, `countShadowOutcomesSince`, `countOpenScanFlaggedCases`.
  - `package.json`: exports.
- **Processor**: `src/services/avatar-gate-client.ts` (new), `src/api/avatar.ts`.
- **Web**
  - New:
    - `lib/content-safety/avatar-gate-service.ts`, `lib/content-safety/backfill-service.ts`;
    - `app/api/internal/content-safety/avatar-gate/route.ts`, `app/api/internal/content-safety/readiness/route.ts`;
    - `app/api/cron/content-safety-backfill/route.ts`.
  - Changed:
    - `publish-gate-service.ts`: `runHashMatchTakedown`, `stageBytesForTakedown`, deps overrides, bounded read moved to `lib/storage/s3-objects.ts`;
    - `takedown-service.ts`: `removeUserAvatar`;
    - `canvas/published-storage.ts`: list and read helpers for `assets/`;
    - `app/api/account/avatar/route.ts`.
- **Admin**
  - New: `components/admin/content/enforce-readiness.tsx`, `app/api/admin/content/readiness/route.ts`, `lib/content/web-readiness.ts`.
  - Changed: `scan-verdicts.tsx`, `(admin)/content/page.tsx`.
- **Ops**: `docker/cron/crontab`, `docker-compose.yml` (processor `WEB_APP_INTERNAL_URL`), `.env.example`, `apps/web/.env.example`, `apps/processor/.env.example`, `CHANGELOG.md`.

## Env vars

| Var | Service | Default | Notes |
|---|---|---|---|
| `CONTENT_SCAN_ALLOW_UNCLASSIFIED_VIDEO` | web | `false` | `true` once Hive confirms its classifier runs on video |
| `CONTENT_SCAN_BACKFILL_ITEMS_PER_TICK` | web | `25` (max 500) | objects per tick; each can be one vendor call |
| `CONTENT_SCAN_BACKFILL_REPASS_HOURS` | web | `24` | wait between passes |
| `CONTENT_SCAN_MODE` | **processor** (new) | `off` | must equal the web app's. Root compose passes it through `.env` |
| `SERVICE_API_SECRET` | **processor** (new) | — | same as web/admin |
| `WEB_APP_INTERNAL_URL` | **processor** (new) | — | `http://web:3000`; set in root `docker-compose.yml` |

**Tenant compose** (`infrastructure/docker-compose.tenant.yml`):
- The processor now gets `CONTENT_SCAN_MODE` (default off), `SERVICE_API_SECRET` and `WEB_APP_INTERNAL_URL=http://web:3000`.
- The web service still gets none of the scan variables (as PR 4 noted), and no `SERVICE_API_SECRET`. A tenant that turns scanning on must add `CONTENT_SCAN_*`, `HIVE_API_KEY` and `SERVICE_API_SECRET` to web. Until then the avatar gate route answers 403, so the processor falls back to the blocklist (the tenant runs with scanning off anyway).

## How to run the dry run

From the cron container (it holds `CRON_SECRET` and signs the request):

```bash
cron-curl GET "http://web:3000/api/cron/content-safety-backfill?dryRun=1"
# continue a large walk:
cron-curl GET "http://web:3000/api/cron/content-safety-backfill?dryRun=1&phase=assets&startAfter=<next.startAfter>&maxPages=50"
```

- **No vendor calls, no byte reads, no cursor change.** It lists keys and looks up verdicts in batches. It works in any mode except on-prem, so it can run before `CONTENT_SCAN_MODE` is turned on.
- **Bounded.** It stops after `maxPages` listing pages (default 50 × 1000 keys) and returns `next` to continue.
- **Answer:** `counts.assets` (objects, distinct hashes, fresh, needScan, bytesToRead, ignored), `counts.avatars` (objects, bytesToRead), and `estimatedVendorCalls`. That estimate is an upper bound: asset hashes with no fresh verdict, plus every avatar, since an avatar's hash is only known once read. PDFs, fonts and other unscanned types cost no call.
- **Cost:** multiply `estimatedVendorCalls` by Hive's per-call price (not published; sales conversation). For time, divide by `ITEMS_PER_TICK × 6` per hour.

## Re-review of PR 4's last fixes (`1baa87eae`)

In the independent reviewer's scope (see Review): whole-file text detection, chained Ogg, missing `ContentLength`. The bounded read was moved, unchanged in behaviour, to `readS3ObjectBounded` (`lib/storage/s3-objects.ts`). An unknown size is still treated as too large.

## Known gaps (from the plan, still true)

- **Inline `data:` images** in canvas HTML never pass through the asset pipeline.
- **Published apps** run customer code on their own domains and can serve anything.
- **External image URLs** in published pages aren't ours, but they appear on our domains.
- **Private files** remain unscanned, and pages stay viewable before processing finishes.
- **PDFs** (and office documents, SVG, zips by first entry) can contain images and are published unscanned.
- **Upload rate limit:** `FILE_UPLOAD` remains unused, and email verification still isn't required to upload.
- **Cached avatars:** the one-year `public, immutable` cache header means a taken-down avatar may persist in browsers and any CDN. A new upload changes the `?t=` URL, but the old URL stays cached.

New or sharpened by this PR:

- **Errors, unscanned types and unverified video already public stay public** after the backfill. They are counted, and held only when republished.
- **A thumbnail whose private original is gone** is an `error` on every pass (unreadable source). It stays public and is retried each pass.
- **Avatars are re-read every pass.** They are not content-addressed, so their hash is only known after reading. That costs S3 reads, not vendor calls.
- **Shadow-mode avatar uploads with no answer from the web app** are accepted after a blocklist check only (logged). A hash-match scan slower than the 50 s timeout, whose takedown has not blocked the hash yet, is in this group. The backfill scans them on its next pass.
- **A derived public copy whose private original is gone** is never scanned by its own bytes (see above).
- **Staged avatar bytes for an already-blocked hash** sit at the blocked private key `files/<hash>/original`, which is never served. They are not copied to evidence automatically unless a case's resweep or resume picks them up. Resume that hash's case from the console to preserve them.
- **A hidden avatar** (staging failed) is no longer shown in the product, but its URL (`/api/avatar/<userId>/avatar.<ext>`) still answers until a tick can stage and delete it. The walk retries it every tick and stays on that key until it succeeds. The avatar GET routes do not check the blocklist.
- **A blocked hash with no case** that was still public is held at `content-hold/backfill-uncased/<hash>`. No case preserves or cleans that copy, so the backfill logs a security error asking for a case to be opened.
- **A failed staging write on the upload path** is logged, not alerted. The takedown still runs, and the case shows its preserve step.
- **Unrecognised keys** under `assets/` (any legacy shape other than `assets/<64-hex>` or `assets/cache/<64-hex>/…`) are counted as `ignored`, shown on the readiness panel, and not scanned.
- **Drive and org avatars** are members-only and out of scope.
- **The new internal routes trust `SERVICE_API_SECRET`.** A leaked secret already allows takedowns in an admin's name. The avatar gate route can only refuse uploads or open cases for real users, and a hash match needs Hive's say-so.

## Before enforce

1. Counsel signs off: runbook, evidence retention, who may view flagged content, vendor scanning, legal holds vs GDPR erasure.
2. Hive answers PR 4's ten assumptions. Assumption 7 (classifier on video) decides `CONTENT_SCAN_ALLOW_UNCLASSIFIED_VIDEO`.
3. `HIVE_API_KEY`, `EVIDENCE_BUCKET` and `ABUSE_EMAIL` are set on the web app. The processor gets `CONTENT_SCAN_MODE`, `SERVICE_API_SECRET` and `WEB_APP_INTERNAL_URL`.
4. Run shadow mode. Run the dry run, agree the cost, then let the backfill complete one pass.
5. Review every shadow flag (the readiness check blocks while any is unreviewed). Look at the error / unscanned / unverified counts: under enforce those are held on republish.
6. The readiness panel shows no blocking item. Then set `CONTENT_SCAN_MODE=enforce` on web **and** processor.

## Tests

Lib, pure:
- `avatar-gate.test.ts` (14):
  - the four types by bytes; HTML, PDF, MP4, BMP and empty refused;
  - **magic-byte mismatch refused in every mode, before the blocklist or the scanner**;
  - clean is recorded by SHA-256;
  - blocked in every mode; hash match takes down in shadow too;
  - enforce refuses a flag, an error and a missing key;
  - **shadow accepts but records and opens the case**;
  - off skips the scan; a blocklist failure throws; a failing audit changes nothing.
- `backfill.test.ts` (14):
  - key parsing; config;
  - **respects the per-tick limit and resumes from its persisted cursor**;
  - assets then avatars, with completion counts; a phase change within one tick;
  - **a failing object stops before it, and the next tick retries it**;
  - busy lease; repass timing; ignored keys; a failing save;
  - counts;
  - **dry run counts with no scan, no byte read and no cursor**; dry-run continuation; the freshness rule.
- `readiness.test.ts` (11).
- `publish-gate.test.ts` (+7): unverified held, shadow records, a classified video is clean, an unclassified image is clean, the relaxation flag, a cached unverified verdict; findings.
- `scan-mode.test.ts` (+1).

Lib, Postgres: `backfill-store.integration.test.ts` (3):
- lease create, refuse, release, expire;
- **a real-cursor tick resumes and respects the limit**;
- batch verdicts and shadow counts.

Processor: `avatar.test.ts` (+12, fixtures now real JPEG bytes):
- **a refused upload leaves the old avatar in place** (no list, delete or put);
- **magic-byte mismatch refused** before the gate or storage;
- the bytes go to the web gate with service auth;
- the extension and type come from the bytes;
- enforce refuses when the web app is unreachable or the gate is unconfigured;
- shadow accepts when unreachable; **shadow stores what the gate accepted**;
- on-prem: local blocklist only, and a blocklist failure refuses;
- with no answer from the web app, a blocked hash is refused in every mode;
- the web app decides when the processor has no `CONTENT_SCAN_MODE`;
- a non-image 400 carries `code: 'not_an_image'`.

Web:
- `avatar-gate-service.test.ts` (4): a hash match stages the bytes and then takes down; the takedown runs even when staging fails; shadow records; a gate failure refuses.
- `avatar-gate/route.test.ts` (4): secret, unknown user, `{ accept }` only, size.
- `backfill-service.test.ts` (13):
  - served bytes scanned; a thumbnail is gated as its original;
  - **an asset hash match runs the global takedown, in shadow too**;
  - enforce removes a flagged copy with no block; shadow leaves it;
  - a blocked hash is removed with no scan; an error stays up; a blocklist failure throws;
  - avatar read and hash; an avatar gone since listing;
  - **an avatar hash match stages, then global takedown, then avatar takedown**, even when the global takedown fails;
  - a flagged avatar is removed under enforce.
- `content-safety-backfill/route.test.ts` (7):
  - HMAC;
  - **on-prem no-op, for the run and the dry run**;
  - the off and no-key no-ops;
  - **the dry run makes no tick and builds no gate deps**;
  - the per-tick limit from env; a failure is a 500 without the key; busy and idle.
- `readiness/route.test.ts` (3).
- `account/avatar/route.test.ts`: the pre-delete tests are replaced. No DELETE call; a refusal leaves the profile image untouched, with the neutral message; the not-an-image message.

Admin: `readiness/route.test.ts` (2), `enforce-readiness.test.tsx` (1). `no-file-rendering.test.ts` covers the new component automatically.

## Commands and results

Test DB: `pagespace-postgres-test` on port 5433, migrated with `DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test bun run db:migrate` (applied `0387`). `bun install` was needed first: the worktree had no `node_modules`. `packages/db` and `packages/lib` were built.

| Command | Result |
|---|---|
| `bun run db:generate` (second run) | "No schema changes" |
| `bun run typecheck` (`NODE_OPTIONS=--max-old-space-size=8192`, `--concurrency=3`) | PASS, 23 of 23 at `1c8fc51cc`. The first run failed on one test-fixture type in web, since fixed. Later commits touched only web and lib: `tsc --noEmit` clean for both at the final commit |
| `packages/lib`: `bunx vitest run src/content-safety src/email-templates` (test DB) | PASS, 23 files, 482 tests |
| `packages/lib`: `bunx vitest run --config vitest.integration.config.ts src/content-safety` (test DB) | PASS, 6 files, 66 tests |
| `packages/db`: `bunx vitest run src/schema/__tests__` (test DB) | PASS, 16 files, 285 tests |
| `apps/processor`: `bunx vitest run src/api/__tests__/avatar.test.ts` | PASS, 32 tests (final) |
| `apps/processor`: `bunx vitest run` (at `502568b46`) | 72 of 75 files, 1,226 tests pass. The 3 failing files are the audit-chainer and SIEM integration tests, which need `ADMIN_DATABASE_URL` (a separate admin DB, not set here); unrelated |
| `apps/web` (test DB): content-safety, canvas, storage, publish, drives, security-audit-coverage, report, user-reports, internal, cron, account/avatar, avatar, components/content-safety, middle-content | PASS, 163 files, 2,627 tests (at `502568b46`) |
| `apps/web` (test DB), after the review fixes: content-safety, storage, the backfill cron, internal, account/avatar, canvas, publish, drives, security-audit-coverage | PASS, 82 files, 1,698 tests (final commit) |
| `apps/admin` (test DB): content components, content API, lib/content | PASS, 14 files, 86 tests |
| `eslint` on every changed TS/TSX file in web, admin, processor, lib | Clean (lib test files are outside its ESLint config: warnings only) |

Not run: the whole-repo `bun run test`, `bun run lint`, `bun run test:security`, a browser run, a real cron container, and any call to Hive (no key).

## Review

Independent reviewer: a fresh agent using the `/review` skill, read-only, posting nothing (there is no PR). Scope: `git diff 607f59019..HEAD`, which is PR 4's unreviewed commit `1baa87eae` plus this PR.

| Round | At | Verdict |
|---|---|---|
| 1 | `502568b46` | 0 blocker / 2 major / 7 minor / 5 nit — CHANGES REQUESTED |
| 2 (verify) | `1c8fc51cc` | 0 blocker / 1 major / 3 minor / 1 nit — CHANGES REQUESTED |
| 3 (verify) | `190865b38` | 0 blocker / 0 major / 1 minor / 2 nit — APPROVE WITH MINORS |

**`1baa87eae` (PR 4's last fixes): no findings.**
- Text is now recognised only on whole files.
- In a complete chained Ogg, every stream-opening page must be audio. A false `OggS` hit resolves to video, the safe direction.
- A missing `ContentLength` is treated as too large.

| Finding | Outcome |
|---|---|
| R1 major — shadow: any no-answer from the web gate accepted the avatar with no blocklist check. A slow hash-match takedown could leave a CSAM avatar public | Fixed (`1c8fc51cc`): every no-answer path reads the blocklist locally first (refuse if blocked or unreadable). A takedown in flight blocks first. Gate timeout 50 s |
| R1 major — readiness reported "backfill complete" after a pass where every object errored (e.g. a revoked key) | Fixed: a pass with `errors > 0` blocks enforce |
| R1 minor — avatar scanning depended on the processor's own mode; tenant compose lacked processor env; readiness text wrong | Fixed: the web app's mode decides (the processor asks unless on-prem); tenant processor env added; text corrected |
| R1 minor — a part-way hash-match takedown counted the asset as removed | Fixed (`1c8fc51cc`, then corrected by R2 major A) |
| R1 minor — `scanned` counted unreadable/too-large errors | Fixed: only vendor calls |
| R1 minor — fixed 30-minute lease, no ownership check on save | Fixed: saves require the claimed `lease_until`; a tick stops at half the lease; lease-lost integration test |
| R1 minor — unrecognised `assets/` keys silently ignored | Partly: `ignored` shown on the readiness panel; still not scanned (documented) |
| R1 minor — a thumbnail whose original is gone is an error forever | Documented gap |
| R1 minor — staging failure could lose the only avatar copy | Fixed across R1–R3: nothing is deleted without staging; the avatar is hidden and retried |
| R1 nits — empty truncated page loop; oversized avatar hashed from 4 KB; unused `publishBucketSet`; unbounded GET on growth; every processor 400 shown as a file-type error | All fixed |
| R2 major A — the part-way fallback deleted the public copy with no private hold | Fixed (`190865b38`): `takePublicOffline` (hold, verify, delete) under the case; no case means no delete and a retry. Blocked public copies are held under the block's case too |
| R2 minor B — staging failure skipped the block and alert | Fixed: the global takedown runs anyway; the avatar is hidden |
| R2 minor C — ranged GET of a zero-byte object answers 416 | Fixed: no `Range` at size 0; `s3-objects.test.ts` |
| R2 minor D — an oversized avatar was counted as ignored | Fixed: counted as an error |
| R3 minor — "hidden" still served by URL and counted as removed until the next pass | Fixed (this commit): not counted as removed; the walk stops before it and retries every tick |
| R3 nit — doc comment misplaced on `hideUserAvatar` | Fixed |
| R3 nit — the uncased hold is never preserved or cleaned | Logged as a security error asking for a case; documented |

The R3 fixes were made after the last verify round and were not re-reviewed.

## Rebased onto master at `4ef25e9f4`

The stack was cut from `b18d504aa` and rebased onto `origin/master` at `4ef25e9f4` (52 commits newer). Master added
`0382_page_content_revision`, so every content-safety migration moved up one: `0383` to `0387`; this branch's `0386_content_scan_backfill` is now `0387_content_scan_backfill`. Each was regenerated with
`bun run db:generate --name <same name>` at the commit that first added it, on top of master's snapshot, then renamed
to the next file number as before (journal index is still behind the file numbers). The regenerated DDL is
byte-identical to the original; only the numbers changed.

Conflicts on this branch: the drizzle journal and snapshot only.

PR #2975 (`sec/chat-attachment-key-scope`, not merged) edits `reconstructFromStructuredContent` in
`message-utils.ts` at the same spot as PR 1's removed-attachment drop: both move `filePartIndex++` up and add a
`continue`. Whichever merges second gets a text conflict and must keep both drops. #2975 also closes a gap the
blocklist write screen leaves: a parts-less message is stored raw, so typed envelope-shaped text with a
`fileParts` storage key is never refused at write by `screenFilePartsAgainstBlocklist` (the read-side drop still
hides a blocked attachment). #2975 neutralizes such text on write.

Test DB recreated from empty and migrated: 357 migrations applied. Then:

| Command | Result |
|---|---|
| `bun run db:generate` | "No schema changes" |
| `bun run typecheck` (`NODE_OPTIONS=--max-old-space-size=8192`, `--concurrency=4`) | PASS, 23 of 23 |
| packages/db unit | PASS, 1 file, 13 tests |
| packages/lib unit | PASS, 20 files, 458 tests |
| packages/lib integration | PASS, 7 files, 85 tests |
| apps/web unit | PASS, 52 files, 1198 tests |
| apps/admin unit | PASS, 15 files, 108 tests |
| apps/processor unit | PASS, 7 files, 194 tests |
| apps/marketing unit | PASS, 2 files, 16 tests |

Test runs cover every test file this stack adds or changes in each package, with
`DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test`.

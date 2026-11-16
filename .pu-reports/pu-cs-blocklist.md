# Content safety PR 1 — data model and re-upload block

Branch `pu/cs-blocklist`. Brief: `~/.claude/plans/cs-pr1-brief.md`. Review fixes: `~/.claude/plans/cs-pr1-fixes.md`, `~/.claude/plans/cs-pr1-fixes-2.md`.
Nothing pushed, no PR opened.

## What exists now

- **Schema** `packages/db/src/schema/content-safety.ts`: `content_blocks`, `content_scans`, `content_cases`.
  No foreign keys on any of them (a schema test enforces it).
- **Migration** `packages/db/drizzle/0383_content_safety.sql` (three `CREATE TABLE`, four indexes). Applied
  cleanly to a fresh Postgres 17 test database.
- **Lib module** `packages/lib/src/content-safety/`:
  - `policy.ts` — pure: `normalizeContentHash`, `normalizeContentHashes`, `requiresGlobalPurge`,
    `ContentBlockedError`, the neutral message and status. Hash canonicalization delegates to the upload
    routes' existing `validateContentHash`, so there is one definition of a valid hash.
  - `blocklist.ts` — `isHashBlocked`, `findBlockedHashes` (one indexed lookup, no cache).
  - `upload-gate.ts` — `findBlockedUploads` (batch), `isUploadBlocked`, `assertUploadNotBlocked`: one
    blocklist query, and one audit event per blocked hash.
  - Exported as `@pagespace/lib/content-safety/{policy,blocklist,upload-gate}`.
- **Refusal**: HTTP 422, body `{ "error": "This file can't be uploaded" }`. Same in every deployment mode.
  A refused page copy uses the same status with `{ "error": "One or more files can't be copied" }`.
- **Audit event on a hit**: its own type, `content.upload.blocked` (added to `SecurityEventType` in
  `packages/db/src/schema/security-audit.ts`; the column is `text`, so no migration). `resourceType: 'file'`,
  `resourceId: <hash>`, `userId`, `riskScore: 0.9`, `details: { …ids, entryPoint }`. PR 2 finds attempts with
  `event_type = 'content.upload.blocked'`, optionally by `resource_id`.
- **Audit event when a file can't be verified** (copy and send only, see "Legacy key form"): the same type,
  with `details.reason: 'unverifiable_file_reference'`, `riskScore: 0.5`, and `resourceId` set to the page or
  file id rather than a hash. Filter on `details->>'reason' is null` for true blocklist hits.

## Entry points gated

Bytes entering storage:

| # | Entry point | Gate at | On a blocked hash |
|---|---|---|---|
| 1 | Page-file presign | `apps/web/src/app/api/upload/presign/route.ts:80` | 422 before the storage probe, slot or presigned URL |
| 2 | Page-file complete | `apps/web/src/app/api/upload/complete/route.ts:228` | 422, slot and pending-upload row released, no page or `files` row |
| 3 | Channel + DM attachment presign | `apps/web/src/lib/upload/attachment-direct.ts:92` | 422 before the storage probe, slot or presigned URL |
| 4 | Channel + DM attachment complete | `apps/web/src/lib/upload/attachment-direct.ts:191` | 422 before processor verify, slot released, no `files` row |
| 5 | Server-side image writer (AI image generation) | `apps/web/src/lib/upload/create-file-page.ts:260` | throws `ContentBlockedError` before `putObject` |
| 6 | AI chat attachments — new uploads | `apps/web/src/lib/repositories/message-repository.ts:667`, `:739` | see below |

An existing hash attached to something new, with no upload (added after review):

| # | Entry point | Gate at | On a blocked hash |
|---|---|---|---|
| 7 | AI chat attachments — echoed storage keys | same screen as 6 | see below |
| 8 | Bulk copy of pages | `apps/web/src/app/api/pages/bulk-copy/route.ts:160` (`refuseUnsafeCopy`, whole tree) | 422 before the transaction opens; nothing is written |
| 9 | Channel message send | `apps/web/src/app/api/channels/[pageId]/messages/route.ts:253` | 422 before any insert |
| 10 | DM send | `apps/web/src/app/api/messages/[conversationId]/route.ts:328` | 422 before any insert |
| 11 | v1 chat completions — every request message | `apps/web/src/app/api/v1/chat/completions/route.ts:158` | 422 before the credit hold; the model is never called |

Notes:

- **3 and 4** cover all four attachment routes; `channels/[pageId]/upload/{presign,complete}` and
  `messages/[conversationId]/upload/{presign,complete}` are thin wrappers over `attachment-direct.ts`.
- **5** has one caller, `apps/web/src/lib/ai/tools/image-generation-tools.ts:354`, whose existing catch
  already returns a generic "could not be saved" message.
- **6 and 7** are one mechanism. `screenFilePartsAgainstBlocklist` (`apps/web/src/lib/ai/core/message-utils.ts:520`)
  hashes every new `data:` attachment and reads the hash out of every echoed `chat-attachments/<hash>/original`
  key, then makes **one** blocklist query. The message repository calls it before the save transaction opens
  and before any bytes are written, so there is no lookup inside the transaction and no sibling attachment is
  written when one is blocked. `uploadChatAttachment` itself no longer checks.
  - A **user** message with a blocked attachment is refused. The page turn
    (`chat-pipeline/page-chat-turn.ts:1066`), the global turn (`chat-pipeline/global-chat-turn.ts:606`) and v1
    completions (`api/v1/chat/completions/route.ts:873`) return the neutral 422; the turn stops before the model
    sees the file.
  - An **assistant or system** message is saved without the blocked part rather than failed.
  - The interrupted-stream materializer (`apps/web/src/lib/ai/core/materialize-interrupted-stream.ts:206`)
    treats a block as terminal: it drops the part, materializes the rest and settles the row instead of being
    retried by every sweep. The audit event is written before the terminal write, so if that write fails the
    next sweep audits the same part once more.
  - An assistant save has no `userId`; the audit event for a dropped part names `triggeredBy.userId`, the user
    who drove the turn, when the caller supplies it.
- **8** reads the whole tree before the transaction (`collectDescendants`, `route.ts:354`: one query per tree
  level, three columns), then makes **one** blocklist query for every hash in it. No lookup runs while the
  copy holds its connection. The transaction copies only the descendants that screen saw (`route.ts:434`), so a
  page created or moved into the tree after the screen is left out rather than copied unchecked. The
  transaction re-reads each screened page and compares its `filePath` and `contentHash` with what the screen
  checked; if either changed, the whole copy rolls back with a retryable 409.
  - One blocked or unverifiable file anywhere in the tree refuses the whole copy. The response does not name
    the page: that would point at the blocked file. A user who needs to know which page can copy the children
    one at a time; support can read the audit event.
- **11** screens the `file` parts of every message in the request body with one query, whether or not the
  call is threaded. Persistence (6, 7) only sees the newest message of a threaded call; a stateless call
  saves nothing, and a `client_manages_history` call resends earlier turns the server never stored. Its
  coverage is that of 6 and 7: `data:` bytes and echoed keys. Two pre-existing gaps remain, in Follow-ups 1
  and 8. A threaded call with attachments makes two blocklist queries, the route's and persistence's.
  The route's audit event has no IP or user agent, because the screen takes no `Request`.
- **9 and 10** normally receive a file id that is the content hash. For any other id the gate reads the row's
  `storagePath` (one extra query, only for such ids) and resolves it the way the file readers do.
- **10**: the DM validator already required the sender to have uploaded the file into this conversation; the
  gate adds the case of a hash blocked after that upload. **9** had no such check at all — see Follow-ups.

## Legacy key form

The file readers still accept a `filePath` / `storagePath` of the form `files/<hash>/original` as well as a
bare hash (`toContentHash`, `apps/web/src/lib/presigned-url.ts:32`; mirrored in the view and download routes).
The copy and send gates now resolve references the same way, through `resolveStoredContentHash`
(`apps/web/src/lib/upload/stored-content-hash.ts`), which is `toContentHash` followed by the blocklist's own
`normalizeContentHash`.

A reference that resolves to nothing can't be checked against a hash blocklist at all, so both gates **fail
closed** and audit it:

- **Copy**: a page whose `filePath` is set but is neither form refuses the whole copy.
- **Send**: a `files` row whose `storagePath` (or, if that is null, id) is neither form refuses the send. The
  fixes file specified fail-closed for copy; I applied the same rule to send because the reasoning is
  identical. An id with no `files` row is passed on to the send's own validation, which already rejects it.

`pages.contentHash` is looked up when it is a hash and ignored otherwise: readers serve from `filePath`, so
that is the column that decides whether a page is verifiable.

### Needs a production check

If either `unverifiable_*` count is above zero, those rows can no longer be copied (first query) or attached
to a new message (second query) until they are rewritten to a bare hash. The `legacy_form_still_checked`
counts are informational: those rows keep working. The first query slightly overcounts: it includes a
whitespace-padded hash, which the gate trims and accepts. Run both before this ships:

```sql
-- FILE pages whose filePath is not a bare sha256. Legacy-form rows are still checked; the rest are refused.
select count(*) filter (where "filePath" ~* '^files/[0-9a-f]{64}/original$') as legacy_form_still_checked,
       count(*) filter (where "filePath" !~* '^files/[0-9a-f]{64}/original$') as unverifiable_copy_refused
from pages
where "filePath" is not null and "filePath" <> '' and "filePath" !~* '^[0-9a-f]{64}$';

-- files rows whose id is not a bare sha256, split the same way by storagePath.
select count(*) filter (where coalesce(nullif("storagePath", ''), id) ~* '^(files/[0-9a-f]{64}/original|[0-9a-f]{64})$') as legacy_form_still_checked,
       count(*) filter (where coalesce(nullif("storagePath", ''), id) !~* '^(files/[0-9a-f]{64}/original|[0-9a-f]{64})$') as unverifiable_send_refused
from files
where id !~* '^[0-9a-f]{64}$';
```

## Found but not gated, and why

Storage writers (`git grep` for `buildS3Key`, `PutObjectCommand`, `files/${`):

| Writer | Why not gated in PR 1 |
|---|---|
| `apps/processor/src/cache/content-store.ts:419,454` (`saveOriginal`, `saveOriginalFromFile`) | Write `files/<hash>/original`, but have no production callers — only the processor's own tests. If one gains a caller, it needs the gate. |
| `apps/processor/src/cache/content-store.ts:347,387` (cache objects and metadata), `:239` (JSON sidecar) | Derived from an original that already passed the gate. PR 2's purge covers `cache/<hash>/*`. |
| `apps/processor/src/api/avatar.ts:137`, `apps/processor/src/api/subject-avatar.ts:95` | Avatars are keyed by user/subject ID, not content hash. PR 5. |
| `apps/web/src/lib/canvas/published-storage.ts:163,215,416`, copy at `:441`; `apps/web/src/lib/canvas/asset-pipeline.ts:229` | Publish bucket. The copy to the public bucket is where PR 4's publish gate goes. |
| `packages/lib/src/services/page-content-store.ts:175` | Page text content, addressed by its own content ref. |
| `apps/processor/src/services/anchor-publishers.ts:124`, `apps/web/scripts/test-s3-roundtrip.ts` | Audit-chain anchors; a dev script. |

Paths that carry an existing hash, swept across `apps/web`, `apps/processor`, `apps/realtime`, `packages/lib`:

| Path | Finding |
|---|---|
| AI message edit — `apps/web/src/app/api/ai/chat/messages/[messageId]/route.ts:120`, `.../ai/global/[id]/messages/[messageId]/route.ts:74`, `.../ai/page-agents/[agentId]/conversations/[conversationId]/messages/[messageId]/route.ts:87` | Closed by #2975 (`931dc7457`, merged in). An edit of an envelope replaces only its text parts, and `processMessageContentUpdate` neutralizes envelope-shaped text, so an edit can no longer attach a hash. |
| Cross-drive move — `apps/web/src/services/api/page-cross-drive-move-service.ts:199,335` | No new row: rewrites `driveId`/`parentId` on the existing page. The reference predates the move, so it is PR 2's "existing references". |
| Page create (`page-service.ts:941`, `page-repository.ts:179`), AI `create_page`, `copy_content`, convert-to-document, drive backup restore, trash restore, version rollback, page PATCH, reorder, share links, task/agent/memory/starter seeding | Cannot carry `filePath`/`contentHash`, or compute nothing from a client-supplied hash. |
| Channel and DM message edit | Only `content` is written. |
| Message forward/copy, page duplicate, drive duplicate, template instantiate, import | Do not exist. |
| Processor and realtime | Never insert into `pages`, `files`, `file_pages` or `file_conversations`. |

The plan lists "the processor's chat-attachment path". There isn't one: `chat-attachments/<hash>/original` is
written only by the web app.

## Decisions recorded

- **The refusal is distinguishable, on purpose.** A caller who already has an exact hash can learn from the
  422 whether it is blocked. Accepted, and the response is not merged into the existing 409: a probe needs the
  exact sha256, so it reveals nothing about files the caller doesn't already hold or know; every probe is
  audited at riskScore 0.9; and a distinct response is what lets support tell a real block from an ordinary
  failed upload. Commented at `apps/web/src/lib/upload/content-blocked-response.ts`.
- **Bytes left behind when complete refuses are not deleted.** A presigned PUT issued before a block stays
  valid for up to 15 minutes, so bytes can land at `files/<hash>/original` and then be refused at complete with
  no row created. Deleting them there would destroy evidence before PR 2's preservation step. **PR 2's takedown
  must handle them**: re-sweep the hash's keys after the presign TTL.
- **No IP or user agent on entry points 5–7.** Those writers have no `Request` in scope; the event carries the
  hash, user and entry point. Entry points 1–4 and 8–10 carry IP and user agent.
- **Existing references are not touched.** A page or message that already points at a blocked hash still
  resolves. That is PR 2's "dangling references" work.

## Follow-ups (out of scope; predate this branch; not fixed)

1. **Any client that knows a chat-attachment hash can get a presigned GET for it, with no proof it ever
   uploaded those bytes.** #2975 narrowed this: the signer now refuses every key except an exact
   `chat-attachments/<64 hex>/original`, so it is confined to chat attachments. It is not closed.
   - `apps/web/src/lib/upload/chat-attachment-storage.ts:12`: `CHAT_ATTACHMENT_KEY_PATTERN` is still unanchored,
     because it has to find a key inside a URL. So any URL, on any host, that contains
     `chat-attachments/<hash>/original` is recognised as "ours".
   - `apps/web/src/lib/ai/core/validate-image-parts.ts:104`: such a part skips validation as "already persisted".
   - `apps/web/src/lib/ai/core/message-utils.ts:588` (`extractStructuredContentFromParts`, echoed-key branch):
     it is saved as `{ storageKey }` with no ownership check. This branch adds only the blocklist check, which
     reads the hash from the path.
   - `apps/web/src/lib/ai/core/message-utils.ts:473` → `apps/web/src/lib/upload/chat-attachment-storage.ts:71`:
     on read, a one-hour presigned GET is issued for the stored key.
   - Chat attachments are in a global content-addressed namespace with no per-user record of who uploaded what,
     so there is nothing to check ownership against today.
2. *(Resolved by #2975, merged in at `931dc7457`: the signer refuses keys outside the chat-attachments shape,
   and text stored raw or written by an edit is neutralized so it can't be read back as an envelope.)*
3. **Channel send accepts any stored file by hash.** `lockAndValidateChannelAttachments`
   (`packages/lib/src/services/channel-message-repository.ts:212`) only checks that each `fileId` has a `files`
   row — not that the sender uploaded it or that it is linked to this channel. The DM validator checks both.
   Reading the bytes still needs a `file_pages` link, so this writes a reference rather than granting access.
   The blocklist gate (entry point 9) is in place; the ownership check is not.
4. **A bulk-copied FILE page gets no `files`/`file_pages` row** (`apps/web/src/app/api/pages/bulk-copy/route.ts`),
   so storage accounting and file-link permissions don't see the copy.
6. **Bulk copy recurses without bound on a `parentId` cycle** (`copyChildrenRecursively`). Needs corrupt data:
   `packages/lib/src/pages/circular-reference-guard.ts` guards the reorder route. Unchanged from `master`; the
   blocklist screen's own walk does terminate.
5. **Bulk copy reads the tree twice**: once for the blocklist screen, once inside the transaction. Copying
   from the first read would remove the second; it means restructuring the route's copy loop, so it is left.

7. **Page-file uploads are served before the stored bytes are verified.** `upload/complete` checks the
   blocklist against the hash declared at presign and commits the page; the processor re-hashes the stored
   object afterwards and deletes it on a mismatch. Until then the object is reachable through the page's
   download and view routes, which don't look at `processingStatus`. If the enqueue fails, the window stays
   open. So a client that declares a clean hash and PUTs blocked bytes gets them served for that window. The
   presigned PUT signs `ContentLength` but no checksum. The commit-then-process order predates this branch.
   Closing it means either verifying synchronously before the commit, which the attachment path already does
   (`verifyAttachmentBytes`; the drive path would need a processor auth scope it doesn't have), or gating
   serving on processing status. Both change the upload flow, so it is not done here.
8. **v1 completions accepts client-built tool outputs with image bytes.** `normalizeMessage`
   (`apps/web/src/lib/ai/core/validate-inference-request.ts`) passes a client's `parts` through unchanged. An
   assistant part `tool-read_page` with `output.type: 'visual_content_delivered'` and its own `imageBase64`
   reaches the provider as image data through `toModelOutputForReadPage`. Neither file validation nor the
   blocklist screen sees it: both look only at `type: 'file'`. On a threaded `client_manages_history` call,
   the tool-result back-fill can also write that output to the caller's own row (`updateMessageToolResults`).
   This predates the branch. The fix is to drop or degrade client-supplied `visual_content_delivered` outputs
   in normalization. Also, entry point 11 trusts an echoed key by its path, so Follow-up 1's unanchored
   pattern lets an attacker-hosted URL reach the provider. That is fixed with Follow-up 1.

## Erasure

`packages/lib/src/compliance/erasure` does not enumerate tables. It runs a fixed list of steps
(`erasure-plan.ts`) and ends with `delete-user`, relying on FK cascades from `users`. The new tables have no
foreign keys, so no cascade can reach them and there was nothing to exclude. Two guards:

- `packages/db/src/schema/__tests__/content-safety.test.ts` fails if any FK is added.
- `packages/lib/src/content-safety/__tests__/erasure-survival.integration.test.ts` opens a case and a block
  naming a real user, deletes the account through `accountRepository.deleteUser`, and asserts both rows survive
  with their IDs intact. Run against Postgres: PASS.

## Things you might not expect in the diff

- **Migration numbering.** `drizzle-kit generate` named the file `0352_content_safety` and overwrote
  `meta/0352_snapshot.json`, because the journal index (352) is behind the file numbering (0382). I restored
  the old `0352` snapshot from git and renamed the new files to `0383_content_safety.sql` /
  `meta/0383_snapshot.json`, with the journal tag to match — the same thing master's `0382` commit did. The SQL
  itself is untouched. A second `bun run db:generate` reports "No schema changes".
- **Duplication ratchet 153 → 154.** The page and global chat turns share the save-failure mapping through
  `chat-pipeline/user-message-save-refusal.ts` rather than copying it; the net change is +1. The figure is
  updated in the ratchet test, `handle-chat-turn.ts` and `docs/2.0-architecture/agent-sessions.md`.
- **`content_blocks.created_by` and `content_cases.category` are nullable.** A `hash_match` block has no
  admin, and a visitor report has no category until triaged.
- **Enum-like columns are `text` with a TypeScript union**, not `pgEnum`.
- **`packages/lib/vitest.config.ts`** excludes the two new Postgres-backed tests from the default run, like the
  other integration tests listed there; `vitest.integration.config.ts` (which CI runs) picks them up.
- **`knip.json`** lists the new schema and lib files as entries, as it does for their neighbours.
- **No CHANGELOG entry.** Nothing is user-visible until PR 2 can create a block.

## Review findings and what was done

| Finding | Outcome |
|---|---|
| major — echoed chat-attachment key not gated | Fixed: entry point 7. |
| major — bulk copy not gated | Fixed: entry point 8. Sweep for other copiers found channel send (fixed, 9) and message edit (closed by #2975). |
| minor — blocklist lookup inside the save transaction; stranded sibling attachments | Fixed: one query before the transaction and before any write. |
| minor — membership oracle | Accepted; comment and "Decisions recorded". |
| minor — blocked attachment on an assistant message retried forever | Fixed: terminal in the materializer; assistant saves drop the part. |
| minor — refusals logged as `authz.access.denied` | Fixed: `content.upload.blocked`. |
| minor — no handler-level tests for the three chat entry points | Fixed: one each. |
| minor — bytes left behind when complete refuses | Left in place deliberately; PR 2. |
| nit — duplicate log line | Fixed: removed; the audit pipeline already logs at warn. |
| nit — caller `details` could overwrite gate fields | Fixed: `entryPoint` is spread last. `reason` is gone; the event type carries it. |
| nit — test did not assert `checkObjectExists` was skipped | Superseded: `uploadChatAttachment` no longer checks. The screening test asserts nothing is uploaded on a block. |
| nit — no test runs the real blocklist query | Fixed: `blocklist.integration.test.ts`, run against Postgres. |

Second review (at `b27f8b0ce`):

| Finding | Outcome |
|---|---|
| major — arbitrary-key presign through the message envelope (predates the branch) | Fixed by #2975 on master (`931dc7457`), merged into this branch. |
| minor — bulk-copy descendant lookups inside the transaction | Fixed: whole tree read first, one blocklist query, before the transaction. |
| minor — copy and send gates ignored the legacy key form | Fixed: both resolve `files/<hash>/original`; unverifiable references fail closed and are audited. See "Legacy key form" and its production check. |
| minor — channel send has no ownership check | Left as Follow-ups 3, by decision. |
| nit — assistant-side drop audited with no user | Fixed: falls back to `triggeredBy.userId`. |
| nit — vacuous "no upload" assertion | Fixed: removed; `savePageMessage` now has a test that a blocked `data:` upload writes no bytes. |
| nit — materializer comment overclaimed "no re-audit" | Fixed: comment and this report say when a second audit can happen. |
| third review, major — a page selected together with its ancestor was dropped from the ancestor's copy (regression from the tree screen) | Fixed: the screened set includes the selected pages; test added. |
| nit — refused copy said "can't be uploaded" and named no page | Wording fixed (`One or more files can't be copied`). Still names no page, deliberately; see note on entry point 8. |

PR #2976 review (at `d0c276eac`):

| Finding | Outcome |
|---|---|
| CI — GDPR export coverage: `content_blocks`, `content_cases`, `content_scans` had no Art 15 decision | Fixed: each excluded with its own reason in `gdpr-export-coverage.ts`. |
| major — v1 completions sends unscreened attachments to the model when stateless or `client_manages_history` | Fixed: entry point 11. |
| minor — a throwing blocklist lookup in attachment complete leaked the slot and pending-upload row | Fixed, along with the same leak in page-file complete. |
| major (unverified) — bulk copy keyed the screen by id only, so a changed `filePath`/`contentHash` slipped through | Fixed: the reference is compared, and a change aborts with a 409. |
| major — page-file bytes are served before the processor verifies the hash | Not fixed: predates this branch and needs a design decision. See Follow-ups 7. |
| independent review — an attacker-hosted URL matching the key pattern, and forged `read_page` tool outputs, get past 11 | Both predate the branch. The claim is narrowed in the code and here; see Follow-ups 1 and 8. |
| independent review — the `content_cases` exclusion ignored the subject as reporter | Reason rewritten: either subject's request is answered by hand through the case process. Needs legal sign-off. |

## Commands and results

Test database: `docker compose -f docker-compose.test.yml up -d postgres-test`, then
`DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test bun run db:migrate` — all migrations
applied, including `0383`.

| Command | Result |
|---|---|
| `bun run typecheck` | PASS, 23 of 23 tasks (rerun after the second round) |
| `bun run --filter @pagespace/lib test -- src/content-safety` (no database) | PASS: 3 files, 35 tests |
| `packages/lib`: `bunx vitest run --config vitest.integration.config.ts src/content-safety` (test database) | PASS: 2 files, 5 tests |
| `packages/lib`: `bunx vitest run src/content-safety src/compliance/erasure src/audit` (test database, before the two new tests moved to the integration config) | PASS: 46 files, 503 tests — includes the erasure integration suites |
| `packages/db`: `bunx vitest run src/schema/__tests__ src/__tests__` (test database) | PASS: 56 files, 780 tests |
| `apps/web`: `bunx vitest run src/lib/repositories src/lib/ai/core src/lib/ai/chat-pipeline src/lib/upload src/app/api/upload src/app/api/channels src/app/api/messages src/app/api/pages src/app/api/v1/chat src/app/api/ai` (test database) | PASS: 268 files, 4,402 tests (rerun after the second round) |
| `eslint` on every changed or new file in `apps/web`, `packages/lib`, `packages/db` | Clean |

The second round changed only `apps/web`, so the `packages/lib` and `packages/db` rows are from the first
round and were not rerun.

Not run: the whole-repo `bun run test`, `bun run lint`, `bun run test:security`, `knip`.

PR #2976 review round (test database as above):

| Command | Result |
|---|---|
| `bun run typecheck` (`NODE_OPTIONS=--max-old-space-size=8192`, `--concurrency=4`) | PASS, 23 of 23 |
| `eslint` on the 8 changed `apps/web` files | Clean |
| `apps/web`: the v1 completions, bulk-copy, upload complete and attachment-direct suites | PASS: 4 files, 187 tests |
| `packages/lib`: `bunx vitest run src/compliance src/content-safety` | PASS: 355 tests. One file, `gdpr-eraser.integration.test.ts`, can't start locally without `ADMIN_DATABASE_URL`; CI runs it. |

## Rebased onto master at `4ef25e9f4`

The stack was cut from `b18d504aa` and rebased onto `origin/master` at `4ef25e9f4` (52 commits newer). Master added
`0382_page_content_revision`, so every content-safety migration moved up one: `0382_content_safety` is now `0383_content_safety`. Each was regenerated with
`bun run db:generate --name <same name>` at the commit that first added it, on top of master's snapshot, then renamed
to the next file number as before (journal index is still behind the file numbers). The regenerated DDL is
byte-identical to the original; only the numbers changed.

Conflicts: `apps/web/src/lib/upload/__tests__/create-file-page.test.ts` (master moved the riteway helper to
`@/test/riteway`; kept that path and this branch's `beforeEach` import), and the drizzle journal and snapshot.

Test DB recreated from empty and migrated: 353 migrations applied. Then:

| Command | Result |
|---|---|
| `bun run db:generate` | "No schema changes" |
| `bun run typecheck` (`NODE_OPTIONS=--max-old-space-size=8192`, `--concurrency=4`) | PASS, 23 of 23 |
| packages/db unit | PASS, 1 file, 6 tests |
| packages/lib unit | PASS, 3 files, 35 tests |
| packages/lib integration | PASS, 2 files, 5 tests |
| apps/web unit | PASS, 17 files, 564 tests |

Test runs cover every test file this stack adds or changes in each package, with
`DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test`.

## Merged master at `931dc7457` (#2975, chat-attachment key scope)

Merged, not rebased. Conflicts in `message-utils.ts`, `message-repository.ts`, and their tests and
`chat-attachment-storage.test.ts`. Both behaviours are kept:
- #2975's anchored-key refusal: the signer, the reconstruct drop, and envelope neutralization.
- This branch's blocklist screen and blocked-hash drop.

The import lists were unioned. The storage-attachments test now takes master's `importOriginal` mock, which
passes the real `parseChatAttachmentContentHash` and `hashAttachmentBuffer` through, so the hand-written
stand-ins were dropped. Both describe blocks are kept in `chat-attachment-storage.test.ts`. Follow-up 2 and
the message-edit gap are closed by #2975. Follow-up 1 is narrowed but still open: the URL recognizer is
unanchored and there is no ownership record.

| Command | Result |
|---|---|
| `bun run typecheck` (`NODE_OPTIONS=--max-old-space-size=8192`, `--concurrency=4`) | PASS, 23 of 23 |
| `apps/web`: `bunx vitest run src/lib/repositories src/lib/ai/core src/lib/ai/chat-pipeline src/lib/upload src/app/api/upload src/app/api/channels src/app/api/messages src/app/api/pages src/app/api/v1/chat src/app/api/ai` (test database, migrated to head) | PASS: 269 files, 4,455 tests |

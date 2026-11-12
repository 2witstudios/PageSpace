# Content safety PR 1 — data model and re-upload block

Branch `pu/cs-blocklist`. Brief: `~/.claude/plans/cs-pr1-brief.md`. Review fixes: `~/.claude/plans/cs-pr1-fixes.md`.
Nothing pushed, no PR opened.

## What exists now

- **Schema** `packages/db/src/schema/content-safety.ts`: `content_blocks`, `content_scans`, `content_cases`.
  No foreign keys on any of them (a schema test enforces it).
- **Migration** `packages/db/drizzle/0382_content_safety.sql` (three `CREATE TABLE`, four indexes). Applied
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
- **Audit event on a hit**: its own type, `content.upload.blocked` (added to `SecurityEventType` in
  `packages/db/src/schema/security-audit.ts`; the column is `text`, so no migration). `resourceType: 'file'`,
  `resourceId: <hash>`, `userId`, `riskScore: 0.9`, `details: { …ids, entryPoint }`. PR 2 finds attempts with
  `event_type = 'content.upload.blocked'`, optionally by `resource_id`.

## Entry points gated

Bytes entering storage:

| # | Entry point | Gate at | On a blocked hash |
|---|---|---|---|
| 1 | Page-file presign | `apps/web/src/app/api/upload/presign/route.ts:80` | 422 before the storage probe, slot or presigned URL |
| 2 | Page-file complete | `apps/web/src/app/api/upload/complete/route.ts:225` | 422, slot and pending-upload row released, no page or `files` row |
| 3 | Channel + DM attachment presign | `apps/web/src/lib/upload/attachment-direct.ts:92` | 422 before the storage probe, slot or presigned URL |
| 4 | Channel + DM attachment complete | `apps/web/src/lib/upload/attachment-direct.ts:187` | 422 before processor verify, slot released, no `files` row |
| 5 | Server-side image writer (AI image generation) | `apps/web/src/lib/upload/create-file-page.ts:260` | throws `ContentBlockedError` before `putObject` |
| 6 | AI chat attachments — new uploads | `apps/web/src/lib/repositories/message-repository.ts:661`, `:733` | see below |

An existing hash attached to something new, with no upload (added after review):

| # | Entry point | Gate at | On a blocked hash |
|---|---|---|---|
| 7 | AI chat attachments — echoed storage keys | same screen as 6 | see below |
| 8 | Bulk copy of pages | `apps/web/src/app/api/pages/bulk-copy/route.ts:159` (top level), `:351` (each level of descendants) | 422; a descendant hit rolls the whole copy back |
| 9 | Channel message send | `apps/web/src/app/api/channels/[pageId]/messages/route.ts:253` | 422 before any insert |
| 10 | DM send | `apps/web/src/app/api/messages/[conversationId]/route.ts:328` | 422 before any insert |

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
    completions (`api/v1/chat/completions/route.ts:859`) return the neutral 422; the turn stops before the model
    sees the file.
  - An **assistant or system** message is saved without the blocked part rather than failed.
  - The interrupted-stream materializer (`apps/web/src/lib/ai/core/materialize-interrupted-stream.ts:204`)
    treats a block as terminal: it drops the part, materializes the rest and settles the row, so no later sweep
    retries or re-audits it.
- **8** checks the top-level pages before the transaction. Descendants are only discovered as the copy walks
  the tree inside the transaction, so each level is checked there (one query per level, sequential) and a hit
  throws, which rolls the copy back. This matches how the route already refuses on org-lapse and model policy.
- **10**: the DM validator already required the sender to have uploaded the file into this conversation; the
  gate adds the case of a hash blocked after that upload. **9** had no such check at all — see Follow-ups.

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
| AI message edit — `apps/web/src/app/api/ai/chat/messages/[messageId]/route.ts:120`, `.../ai/global/[id]/messages/[messageId]/route.ts:74`, `.../ai/page-agents/[agentId]/conversations/[conversationId]/messages/[messageId]/route.ts:87` | **Not gated.** Not a blocklist-shaped problem: see Follow-ups 2. |
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
   uploaded those bytes.**
   - `apps/web/src/lib/upload/chat-attachment-storage.ts:12` — `CHAT_ATTACHMENT_KEY_PATTERN` is unanchored, so
     any URL on any host that merely contains `chat-attachments/<hash>/original` is recognised as "ours".
   - `apps/web/src/lib/ai/core/validate-image-parts.ts:104` — such a part skips validation as "already persisted".
   - `apps/web/src/lib/ai/core/message-utils.ts` (`extractStructuredContentFromParts`, echoed-key branch) —
     it is saved as `{ storageKey }` with no ownership check. This branch adds only the blocklist check.
   - `apps/web/src/lib/ai/core/message-utils.ts:444` → `apps/web/src/lib/upload/chat-attachment-storage.ts:52` —
     on read, a one-hour presigned GET is issued for the stored key.
   - Chat attachments are in a global content-addressed namespace with no per-user record of who uploaded what,
     so there is nothing to check ownership against today.
2. **AI message edit can store an arbitrary storage key, and reads will presign it.** More serious than 1.
   - `apps/web/src/lib/repositories/message-repository.ts:1499` — `processMessageContentUpdate` returns the
     client's `newContent` verbatim when the existing content is not structured JSON (a plain-text message).
   - Reached from the three PATCH routes listed above.
   - A client can therefore PATCH content of the form `{"textParts":[…],"fileParts":[{"storageKey":"<key>"}],"partsOrder":[…]}`.
   - `apps/web/src/lib/ai/core/message-utils.ts:444` then calls `getChatAttachmentUrl(fp.storageKey)`
     (`chat-attachment-storage.ts:52`), which signs a GET for **whatever key is stored** — it does not require the
     `chat-attachments/` prefix. That includes `files/<hash>/original` belonging to another tenant.
   - I verified the code path by reading it; I did not exercise it against a running app. It bypasses the
     blocklist, and the wider issue is cross-tenant read by hash. Suggested fix: never accept structured JSON
     from the edit body, and make `getChatAttachmentUrl` refuse keys that do not match the anchored
     chat-attachment pattern.
3. **Channel send accepts any stored file by hash.** `lockAndValidateChannelAttachments`
   (`packages/lib/src/services/channel-message-repository.ts:212`) only checks that each `fileId` has a `files`
   row — not that the sender uploaded it or that it is linked to this channel. The DM validator checks both.
   Reading the bytes still needs a `file_pages` link, so this writes a reference rather than granting access.
   The blocklist gate (entry point 9) is in place; the ownership check is not.
4. **A bulk-copied FILE page gets no `files`/`file_pages` row** (`apps/web/src/app/api/pages/bulk-copy/route.ts`),
   so storage accounting and file-link permissions don't see the copy.

## Erasure

`packages/lib/src/compliance/erasure` does not enumerate tables. It runs a fixed list of steps
(`erasure-plan.ts`) and ends with `delete-user`, relying on FK cascades from `users`. The new tables have no
foreign keys, so no cascade can reach them and there was nothing to exclude. Two guards:

- `packages/db/src/schema/__tests__/content-safety.test.ts` fails if any FK is added.
- `packages/lib/src/content-safety/__tests__/erasure-survival.integration.test.ts` opens a case and a block
  naming a real user, deletes the account through `accountRepository.deleteUser`, and asserts both rows survive
  with their IDs intact. Run against Postgres: PASS.

## Things you might not expect in the diff

- **Migration numbering.** `drizzle-kit generate` named the file `0351_lethal_annihilus` and overwrote
  `meta/0351_snapshot.json`, because the journal index (351) is behind the file numbering (0381). I restored
  the old `0351` snapshot from git and renamed the new files to `0382_content_safety.sql` /
  `meta/0382_snapshot.json`, with the journal tag to match — the same thing the `0381` commit did. The SQL
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
| major — bulk copy not gated | Fixed: entry point 8. Sweep for other copiers found channel send (fixed, 9) and message edit (Follow-ups 2). |
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

## Commands and results

Test database: `docker compose -f docker-compose.test.yml up -d postgres-test`, then
`DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test bun run db:migrate` — all migrations
applied, including `0382`.

| Command | Result |
|---|---|
| `bun run typecheck` | PASS, 23 of 23 tasks |
| `bun run --filter @pagespace/lib test -- src/content-safety` (no database) | PASS: 3 files, 35 tests |
| `packages/lib`: `bunx vitest run --config vitest.integration.config.ts src/content-safety` (test database) | PASS: 2 files, 5 tests |
| `packages/lib`: `bunx vitest run src/content-safety src/compliance/erasure src/audit` (test database, before the two new tests moved to the integration config) | PASS: 46 files, 503 tests — includes the erasure integration suites |
| `packages/db`: `bunx vitest run src/schema/__tests__ src/__tests__` (test database) | PASS: 56 files, 780 tests |
| `apps/web`: `bunx vitest run src/lib/repositories src/lib/ai/core src/lib/ai/chat-pipeline src/lib/upload src/app/api/upload src/app/api/channels src/app/api/messages src/app/api/pages src/app/api/v1/chat src/app/api/ai` (test database) | PASS: 268 files, 4,390 tests |
| `eslint` on every changed or new file in `apps/web`, `packages/lib`, `packages/db` | Clean |

Not run: the whole-repo `bun run test`, `bun run lint`, `bun run test:security`, `knip`.

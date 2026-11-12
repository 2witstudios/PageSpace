# Content safety PR 1 — data model and re-upload block

Branch `pu/cs-blocklist`. Brief: `~/.claude/plans/cs-pr1-brief.md`. Nothing pushed, no PR opened.

## What exists now

- **Schema** `packages/db/src/schema/content-safety.ts`: `content_blocks`, `content_scans`, `content_cases`.
  No foreign keys on any of them (a schema test enforces it).
- **Migration** `packages/db/drizzle/0382_content_safety.sql` (three `CREATE TABLE`, four indexes).
- **Lib module** `packages/lib/src/content-safety/`:
  - `policy.ts` — pure: `normalizeContentHash`, `isValidContentHash`, `normalizeContentHashes`,
    `requiresGlobalPurge`, `isContentBlockCategory`, `ContentBlockedError`, the neutral message and status.
  - `blocklist.ts` — `isHashBlocked`, `findBlockedHashes` (one PK lookup, no cache).
  - `upload-gate.ts` — `isUploadBlocked` / `assertUploadNotBlocked`: checks the blocklist and, on a hit,
    writes the audit event and a security log line.
  - Exported as `@pagespace/lib/content-safety/{policy,blocklist,upload-gate}`.
- **Refusal**: HTTP 422, body `{ "error": "This file can't be uploaded" }`. Same in every deployment mode.
- **Audit event on a hit**: `authz.access.denied`, `resourceType: 'file'`, `resourceId: <hash>`, `userId`,
  `riskScore: 0.9`, `details: { reason: 'content_blocked', entryPoint, …ids }`. PR 2 can find attempts with
  `resourceType = 'file' AND details->>'reason' = 'content_blocked'`.

## Entry points found and gated

| # | Entry point | Gate at | Behaviour on a blocked hash |
|---|---|---|---|
| 1 | Page-file presign | `apps/web/src/app/api/upload/presign/route.ts:82` | 422 before the storage probe, slot or presigned URL |
| 2 | Page-file complete | `apps/web/src/app/api/upload/complete/route.ts:226` | 422, slot and pending-upload row released, no page or `files` row |
| 3 | Channel + DM attachment presign | `apps/web/src/lib/upload/attachment-direct.ts:90` | 422 before the storage probe, slot or presigned URL |
| 4 | Channel + DM attachment complete | `apps/web/src/lib/upload/attachment-direct.ts:186` | 422 before processor verify, slot released, no `files` row |
| 5 | Server-side image writer (AI image generation) | `apps/web/src/lib/upload/create-file-page.ts:260` | throws `ContentBlockedError` before `putObject` |
| 6 | AI chat image attachments | `apps/web/src/lib/upload/chat-attachment-storage.ts:42` | throws `ContentBlockedError` before the existence probe and `putObject` |

Notes on each:

- **3 and 4** cover all four attachment routes. `channels/[pageId]/upload/{presign,complete}/route.ts:12` and
  `messages/[conversationId]/upload/{presign,complete}/route.ts:12` are thin wrappers over
  `handlePresign` / `handleComplete` → `presignAttachment` / `completeAttachment`.
- **5** has one caller, `apps/web/src/lib/ai/tools/image-generation-tools.ts:354`. Its existing catch already
  returns "The image was generated but could not be saved to your drive." for any non-quota error, which is
  neutral, so I left it alone.
- **6** is reached from `apps/web/src/lib/ai/core/message-utils.ts:519` (`extractStructuredContentFromParts`),
  which the message repository calls when it saves a message. The user-message save runs before generation,
  so a blocked attachment stops the turn before the model sees the file. The three callers that turn this
  into an HTTP response now return the neutral 422 instead of a 500:
  - `apps/web/src/lib/ai/chat-pipeline/page-chat-turn.ts:1067`
  - `apps/web/src/lib/ai/chat-pipeline/global-chat-turn.ts:607`
  - `apps/web/src/app/api/v1/chat/completions/route.ts:859`

  I threaded `userId` from the repository through `extractStructuredContentFromParts` into
  `uploadChatAttachment` so the audit event names the sender.

## Found but not gated, and why

`git grep` for `buildS3Key`, `PutObjectCommand`, `files/${` across `apps/web`, `apps/processor`, `packages/lib`.

| Writer | Why not gated in PR 1 |
|---|---|
| `apps/processor/src/cache/content-store.ts:419,454` (`saveOriginal`, `saveOriginalFromFile`) | Write `files/<hash>/original`, but have no production callers — only the processor's own tests call them. Dead code today. If one gains a caller, it needs the gate. |
| `apps/processor/src/cache/content-store.ts:347,387` (`saveCache`, cache metadata) | Derived `cache/<hash>/…` objects, produced only from an original that already passed the gate. PR 2's purge covers `cache/<hash>/*`. |
| `apps/processor/src/cache/content-store.ts:239` (`writeOriginalMetadata`) | JSON sidecar, not user bytes. |
| `apps/processor/src/api/avatar.ts:137`, `apps/processor/src/api/subject-avatar.ts:95` | Avatars are keyed by user/subject ID, not content hash. Brief puts avatars in PR 5. |
| `apps/web/src/lib/canvas/published-storage.ts:163,215,416` and the copy at `:441`; `apps/web/src/lib/canvas/asset-pipeline.ts:229` | Publish bucket. The copy of `files/<hash>/original` to the public bucket is exactly where PR 4's publish gate goes (blocklist check first). |
| `packages/lib/src/services/page-content-store.ts:175` | Page text content, addressed by its own content ref — not the uploads `files/` namespace. |
| `apps/processor/src/services/anchor-publishers.ts:124` | Audit-chain anchors. |
| `apps/web/scripts/test-s3-roundtrip.ts` | Dev script. |

The plan lists "the processor's chat-attachment path". There isn't one: `chat-attachments/<hash>/original`
is written only by the web app (entry point 6). The processor's `ingest` and `verify` routes read existing
objects and write nothing under `files/`.

## Gaps PR 2 should know about

1. **A presigned PUT issued before a block stays valid for up to 15 minutes.** If a hash is blocked after
   presign, the client can still PUT the bytes; `/complete` then refuses (no row is created), but the object
   sits at `files/<hash>/original` unreferenced. I did not add an S3 delete to `/complete` because the brief
   puts takedown actions in PR 2. The global takedown should re-sweep the hash's keys after the presign TTL,
   or `/complete` should delete on a block.
2. **No IP or user agent on entry points 5 and 6.** Those writers have no `Request` in scope, so the audit
   event carries the hash, user and entry point only. Entry points 1–4 carry IP and user agent.
3. **Existing references are not touched.** A page, message or echoed chat-attachment `storageKey` that
   already points at a blocked hash still resolves. That is PR 2's "dangling references" work.
4. **Linking an existing hash without new bytes** (the dedup fast-path) is covered: presign and complete
   both refuse a blocked hash before the fast-path is considered.

## Erasure

`packages/lib/src/compliance/erasure` does not enumerate tables. It runs a fixed list of steps
(`erasure-plan.ts`) and ends with `delete-user`, relying on FK cascades from `users`. The three new tables
have no foreign keys, so no cascade can reach them and there was nothing to exclude. The guard is
`packages/db/src/schema/__tests__/content-safety.test.ts`, which fails if any FK is added, plus a header
comment in the schema file explaining why.

## Things you might not expect in the diff

- **Migration numbering.** `drizzle-kit generate` named the file `0351_lethal_annihilus` and overwrote
  `meta/0351_snapshot.json`, because the journal index (351) is behind the file numbering (0381). I restored
  the old `0351` snapshot from git and renamed the new files to `0382_content_safety.sql` /
  `meta/0382_snapshot.json`, with the journal tag to match — the same thing the `0381` commit did. The SQL
  itself is untouched. A second `bun run db:generate` reports "No schema changes".
- **Duplication ratchet 153 → 154.** `turn-duplication-ratchet.test.ts` counts identical lines between the
  page and global chat turns. I extracted the save-failure mapping (deleted conversation → 404, blocked
  attachment → 422) into `chat-pipeline/user-message-save-refusal.ts` rather than copying it; the net change
  is +1 (shared import and call in, the old `instanceof` branch out). The figure is updated in the test,
  `handle-chat-turn.ts` and `docs/2.0-architecture/agent-sessions.md`, as that test requires.
- **`content_blocks.created_by` and `content_cases.category` are nullable.** A `hash_match` block has no
  admin, and a visitor report has no category until triaged.
- **Enum-like columns are `text` with a TypeScript union**, not `pgEnum`, so adding a category later needs no
  enum migration.
- **`knip.json`** lists the new schema and lib files as entries, as it does for their neighbours.
- **No CHANGELOG entry.** Nothing is user-visible until PR 2 can create a block; the plan puts the changelog
  entry in PR 5.

## Commands and results

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | The worktree had no `node_modules`, so packages were resolving to the main checkout. Installed. |
| `bun run db:generate` | Generated the migration; second run: "No schema changes, nothing to migrate". |
| `bun run build` in `packages/db` and `packages/lib` | Pass (web tests resolve these through `dist`). |
| `bun run typecheck` | Pass, 23 of 23 tasks. The first attempt was killed for memory in `web` while I had a large vitest run going at the same time; it passed when run on its own. |
| `bun run --filter @pagespace/lib test -- src/content-safety` | Pass: 3 files, 37 tests. |
| `packages/db`: `bunx vitest run src/schema/__tests__` | Pass: 16 files, 278 tests (6 new). |
| `apps/web`: `bunx vitest run src/app/api/upload src/app/api/channels src/app/api/messages src/lib/upload src/lib/ai/core/__tests__/message-utils-storage-attachments.test.ts src/lib/ai/chat-pipeline/__tests__/turn-duplication-ratchet.test.ts src/lib/ai/chat-pipeline/__tests__/user-message-save-refusal.test.ts src/lib/ai/tools/__tests__/image-generation-tools.test.ts src/app/api/v1/chat` | Pass: 33 files, 475 tests. |
| `eslint` on every changed or new file in `apps/web`, `packages/lib`, `packages/db` | Clean. |

Not run: the full `bun run test` (needs the dockerized test Postgres, which isn't up here). A wider web run
over `src/lib/repositories`, `src/lib/ai/core`, `src/lib/ai/chat-pipeline`, `src/app/api/ai` had 19 failing
files, all of them tests that connect to Postgres (`role "test" does not exist`); 179 passed. That includes
the erasure integration tests in `packages/lib`, so "erasure leaves these rows alone" is established by the
no-FK schema test and by reading the erasure code, not by an integration run. `bun run lint` across the
whole repo and `knip` were not run.

## Test coverage per gate

Each gated entry point has a test that a blocked hash is refused and one that an unblocked hash is unaffected:

- `apps/web/src/app/api/upload/presign/__tests__/route.test.ts`
- `apps/web/src/app/api/upload/complete/__tests__/route.test.ts`
- `apps/web/src/lib/upload/__tests__/attachment-direct.test.ts` (presign and complete, page and DM targets)
- `apps/web/src/lib/upload/__tests__/create-file-page.test.ts`
- `apps/web/src/lib/upload/__tests__/chat-attachment-storage.test.ts`
- `apps/web/src/lib/upload/__tests__/content-blocked-response.test.ts`
- `apps/web/src/lib/ai/chat-pipeline/__tests__/user-message-save-refusal.test.ts`
- `apps/web/src/lib/ai/core/__tests__/message-utils-storage-attachments.test.ts`

The page and global chat turns and the v1 completions route have no test that drives a blocked attachment
through the whole handler; the mapping they call is unit tested, and the throw is tested at the storage layer.

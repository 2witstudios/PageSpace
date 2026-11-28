# Security fix: chat message envelopes could sign a download link for any storage key

Branch `sec/chat-attachment-key-scope`, cut from `origin/master` at `4ef25e9f4`
(local `master` was at `b18d504aa`, an ancestor). Nothing pushed, no PR, `master` untouched.

## Status

- The cross-tenant read is closed. The signer now refuses every key except the
  exact shape it mints.
- Confirmed by reading the code and by a regression test that runs the real
  repository, real `message-utils` and real signer with only the DB and the AWS
  presigner mocked. **Not exercised against a running app** (no Postgres or S3
  in this worktree).
- No migration is needed. Rows already holding envelope-shaped text stay as
  they are; the signer check makes them harmless (they render their `textParts`
  and lose the forged file part, with a security warning logged per read).

## The exploit, confirmed

`messages.content` holds either prose or a JSON envelope, and the reader told
them apart by shape alone (`parseStructuredContent`,
`apps/web/src/lib/ai/core/message-utils.ts:384`). Any save without
`uiMessage.parts` stored the caller's text raw, so text shaped like
`{"textParts":[…],"partsOrder":[{"type":"file"}],"fileParts":[{"storageKey":"files/<hash>/original"}]}`
came back as an envelope, and reconstruct asked `getChatAttachmentUrl` to sign
that key. The signer had no check, so the response carried a one-hour GET for
another tenant's file.

Every route that could store caller-influenced text raw into a `content`
column that is later reconstructed:

| # | Entry point | Where the raw save happens | Who controls the text |
|---|---|---|---|
| 1 | `POST /api/ai/page-agents/consult` (session or MCP) | `apps/web/src/app/api/ai/page-agents/consult/route.ts:561` (`role: 'user'`, `content: consultationMessage`) | The caller. With no `context`, `question` is stored verbatim (`route.ts:550`). This is the reported trigger. |
| 2 | `PATCH /api/ai/chat/messages/[messageId]` (session or MCP) | `route.ts:120` → `processMessageContentUpdate` | The caller, when the existing row is plain text (any row from 1, 4–8). |
| 3 | `PATCH /api/ai/page-agents/[agentId]/conversations/[conversationId]/messages/[messageId]` (session or MCP) | `route.ts:87` → same function | Same as 2. |
| 4 | `PATCH /api/ai/global/[id]/messages/[messageId]` (session) | `route.ts:74` → same function | Same as 2. |
| 5 | Workflow runs (manual, scheduled, triggered) | `apps/web/src/lib/workflows/workflow-executor.ts:894` (user prompt) and `:945` (assistant reply) | The workflow author: `exec.prompt` is stored verbatim when no context is appended (`:618`). |
| 6 | `POST /api/v1/chat/completions` | `apps/web/src/app/api/v1/chat/completions/route.ts:631` (assistant `text`) | Indirect: the model must emit the JSON verbatim ("repeat exactly"). The user turn at `:545` passes `uiMessage` and was never affected. |
| 7 | Consult and `ask_agent` assistant replies | `consult/route.ts:862`, `apps/web/src/lib/ai/tools/agent-communication-tools.ts:981` | Indirect, as 6. |
| 8 | Voice transcripts | `apps/web/src/lib/ai/realtime/transcript-persistence.ts:209` and `:257` | Indirect: the transcriber would have to produce the JSON. Unlikely, but the same shape. |

Not affected: the page and global chat pipelines (`page-chat-turn.ts`,
`global-chat-turn.ts`) and `ask_agent`'s user turn always pass
`uiMessage.parts`, so typed text was already nested inside a real envelope.
`materialize*InterruptedMessage` and `ask-user-resume.ts` write server-built
content.

Read side: both converters (`convertDbMessageToUIMessage` and its global twin,
`message-utils.ts:307` and `:595`) go through the same
`reconstructFromStructuredContent`, so one change covers both.

## The fix

1. **Signer scope** — `apps/web/src/lib/upload/chat-attachment-storage.ts:51-68`.
   New `isChatAttachmentStorageKey`, anchored
   `^chat-attachments/[0-9a-f]{64}/original` with a true end-of-string
   (`(?![\s\S])`, because JS `$` also matches before a trailing newline).
   `getChatAttachmentUrl` throws for anything else. The existing unanchored
   `CHAT_ATTACHMENT_KEY_PATTERN` is untouched and still only used to find a key
   inside a URL.
2. **Reconstruct drops the part, not the read** — `message-utils.ts:454-464`.
   A refused key skips that file part, logs
   `loggers.security.warn('Refused to sign chat attachment…', { messageId, role, keyPreview })`,
   and the remaining parts render normally.
3. **Typed text can't become an envelope** — new
   `neutralizeEnvelopeShapedText` (`message-utils.ts:402`), applied in both raw
   savers (`message-repository.ts:137` and `:218`). Text that
   `parseStructuredContent` would accept is wrapped in a real envelope whose
   single text part is the raw string, so it reads back as exactly what was
   typed. Everything else is stored byte-for-byte as before. It reuses the
   reader's own test, so writer and reader can't disagree about what an
   envelope is. Because it sits in the repository's private savers, it covers
   routes 1 and 5–8 and any future caller.
4. **Edit routes** — `processMessageContentUpdate`
   (`message-repository.ts:1489`), shared by all three edit routes, now
   neutralizes new content on the plain-text branch. Editing an existing
   envelope already nested the new text as a string. I wrapped rather than
   returned a 400: a user who pastes JSON into an edit should get their JSON
   back as text, and the three routes stay untouched.

Diff is local to the two files `pu/cs-blocklist` also edits plus the
repository: one added function and one guarded block in `message-utils.ts`, one
added function and a three-line guard in `chat-attachment-storage.ts`.
`pu/cs-blocklist` wasn't available on the remote from here, so I couldn't
check the merge directly.

A user-facing line was added to `CHANGELOG.md` under Unreleased.

## Sweep: other places that sign or fetch a key

Nothing else of the same shape was found, so nothing else was changed.

| Site | Key comes from | Verdict |
|---|---|---|
| `apps/web/src/lib/upload/chat-attachment-storage.ts:65` (`getSignedUrl`) | persisted envelope | **Was vulnerable; fixed.** |
| `apps/web/src/lib/presigned-url.ts:37` `generatePresignedUrl` | callers below | Safe via callers. The helper itself doesn't validate `contentHash`, and `toContentHash` (`:31`) returns a non-matching `storagePath` unchanged. Worth hardening to `^[a-f0-9]{64}$` later; left alone to keep this diff small. |
| `apps/web/src/app/api/files/[id]/download/route.ts:69,98` | `pages.filePath` / `files.storagePath` after `canUserViewPage` / `canUserAccessFile` | Safe. Both columns are only written from a server-verified content hash (`upload/complete/route.ts:154,263`, `create-file-page.ts:144,284`, `attachment-upload-core.ts:198`) or copied from a page the caller can view (`pages/bulk-copy/route.ts:198,344`, permission check at `:133`). Preset is the literal `'original'`. |
| `apps/web/src/app/api/files/[id]/view/route.ts:66,97` | same | Safe, same reasoning. |
| `apps/web/src/app/dashboard/[driveId]/[pageId]/view/route.ts:79` | `pages.filePath`, strict local `toContentHash` returning null on mismatch | Safe. |
| `apps/web/src/app/api/files/[id]/thumbnail/route.ts:51` | `pages.extractionMetadata.thumbnailKey` | Safe today: only the processor writes it (`apps/processor/src/workers/video-processor.ts:38`, `api/s3-pull-adapter.ts:133`) or bulk-copy copies it. The regex at `:45` is loose (`cache/<hex+>/<anything>`), so if that column ever became user-writable this would sign any `cache/` object. Recommend tightening the leaf to `thumbnail\.webp`. |
| `apps/web/src/lib/channels/agent-mention-responder.ts:384` | `files.storagePath` after `canUserAccessFile` | Safe. |
| `apps/web/src/lib/ai/core/image-preset-fetch.ts:29` (`GetObjectCommand`) | `preset` from the hard-coded chain at `:49-53` (`ai-vision`, `ai-chat`, `original`); `contentHash` from the page row at `apps/web/src/lib/ai/tools/page-read-tools.ts:507` | Safe. The preset is an allowlist; no caller passes its own. |
| `apps/web/src/app/api/avatar/[userId]/[filename]/route.ts:46` | route params | Safe: `SAFE_USER_ID`, no `/`, `\`, `..` or leading dot, extension allowlist, fixed `avatars/` prefix. Avatars are public by design. |
| `apps/web/src/lib/avatars/avatar-route.ts:79` | `isAvatarFilename` + `avatarStorageKey` | Safe. |
| `apps/web/src/lib/canvas/published-storage.ts:408` | `assertPrivateSourceKey` (`:104`), anchored `files/<64hex>/original` or `cache/<hex>/thumbnail.webp`; built server-side in `asset-pipeline.ts:212,229` | Safe. |
| `apps/web/src/lib/upload/s3-effects.ts:40` (presigned PUT) | key built from a validated content hash in the presign routes | Safe; write-side, content-addressed. |
| `apps/web/src/app/api/cron/verify-db-backup-freshness/route.ts` | fixed prefix, list only | Safe. |
| `apps/processor/src/cache/content-store.ts:259,370,411,572,598,614` | `normalizeContentHash` (`^[a-f0-9]{64}$`, `:44,172`) and `isValidPreset` (`:47`) | Safe. |
| `apps/processor/src/api/serve.ts:16,70,184` | validates hash and preset, then `assertFileAccess` / `authorizeFileAccess` | Safe. |
| `apps/processor/src/api/avatar.ts:82` | `normalizeIdentifier` + `sanitizeExtension`, fixed `avatars/<id>/avatar<ext>` | Safe. |
| `packages/lib/src/services/page-content-store.ts:204,241` | `getS3Key` → `assertContentRef` (`^[a-f0-9]{64}$`, `:28,109`) | Safe. |

One thing next to this that I did not change: a persisted file part with a
legacy `url` and no `storageKey` is passed through as-is on read
(`message-utils.ts:465`). It signs nothing, so it's outside this fix, but
rows written before this change could carry an arbitrary URL in a file part.

## Tests

- `apps/web/src/lib/repositories/__tests__/message-repository-envelope-key-scope.test.ts` (new, 16 tests):
  save envelope-shaped text with `storageKey: "files/<64hex>/original"` through
  `savePageMessage` and `saveGlobalMessage`, read it back, assert the presigner
  is never called and the text returns verbatim; legacy raw rows (foreign key,
  `/../` after a valid prefix, non-hex hash, `cache/` key, non-string key)
  sign nothing and log; a refused key doesn't drop a legitimate attachment
  beside it; real attachments still sign; edits can't create an envelope.
- `apps/web/src/lib/upload/__tests__/chat-attachment-storage.test.ts` (+20):
  the anchored check — other prefixes, `/../`, non-hex, uppercase, short and
  long hashes, leading or trailing content, trailing newline, URL, query
  string, empty, non-string.
- `apps/web/src/lib/ai/core/__tests__/message-utils-storage-attachments.test.ts`:
  its fixture key was `chat-attachments/deadbeef/original`, which the signer
  now rightly refuses; switched the read-side fixtures to a 64-hex key.

Red first: before the fix the 19 new signer tests failed and the chain test
could not pass.

## Commands run

```bash
git fetch origin master && git checkout -b sec/chat-attachment-key-scope origin/master
bun install --frozen-lockfile
(cd packages/db && bun run build) && (cd packages/lib && bun run build)

# red, then green
cd apps/web
bunx vitest run src/lib/repositories/__tests__/message-repository-envelope-key-scope.test.ts \
  src/lib/upload/__tests__/chat-attachment-storage.test.ts
bunx vitest run src/lib/repositories/__tests__/message-repository-envelope-key-scope.test.ts \
  src/lib/upload/__tests__/chat-attachment-storage.test.ts src/lib/ai/core/__tests__/message-utils
#   → 7 files, 91 tests passed

bunx vitest run src/lib/repositories/__tests__/message-repository src/lib/upload \
  src/lib/ai/core/__tests__/message-utils src/app/api/ai/chat/messages src/app/api/ai/global \
  "src/app/api/ai/page-agents/[agentId]/conversations/[conversationId]/messages" \
  src/app/api/v1 src/lib/workflows
#   → 50 files passed, 820 tests passed; 3 files (5 tests) failed, all
#     *.integration.test.ts that need Postgres, which isn't running here

bun run typecheck          # 22 of 23 tasks passed; web's tsc ran out of heap (exit 137)
NODE_OPTIONS=--max-old-space-size=12288 bun run typecheck   # in apps/web → exit 0
bunx eslint <the six changed files>                         # clean
```

Typecheck caveat: the root `bun run typecheck` did not go green on this
machine because `tsc` for `apps/web` hit Node's default heap limit, not a type
error. With a larger heap the web typecheck passes; the other 22 packages
passed in the root run.

A wider run over `src/lib/ai/core`, `src/lib/repositories` and all of
`src/app/api/ai/page-agents` also showed failures, all of them either
Postgres-backed integration tests or suites that import
`@pagespace/browser-worker`, which I did not build. None touch the changed code.

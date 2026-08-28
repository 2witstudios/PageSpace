# COLLAB_SCHEMA_VERSION v1 freeze — report

Branch `pu/mp-schema-freeze`. Freezes the ProseMirror schema every stored document and
future Y.Doc will be parsed/serialized against, writes `collabExtensions()` /
`clientExtensions()`, lands the schema-drift guard, and makes the anchoring decision.

## Scope note — why this PR is bigger than its five assigned leaves

The five assigned leaves (v1 decision `fz4774b48df251i1ts48xrgb`, anchoring
`nellzsa0ww4vhpq9qft8f8pi`, `collabExtensions()` `peub6cakmsko4pkmcthga4qu`,
`clientExtensions()` `kk56idf3sx9wtirbp73yl42x`, drift guard `wgusafl1rbe6bs8aqtjqhvmk`)
cannot be done honestly without the six "schema-content" leaves the `collabExtensions()`
page itself says ship in the same PR: Reconcile FontFormatting, `tiptap-markdown` tight
lists, stable block ids, comment/suggestion marks, split CodeBlockShiki, split
PageMention. I checked every other worktree/branch in the repo before starting — nothing
else touches this work — so I implemented all of it here. **Their task board entries are
untouched** (still `pending`); this PR's diff satisfies their stated requirements, but
flipping their status is the orchestrator's call at merge, same as mine (left
`in_progress`).

## What shipped

### New files (`apps/web/src/lib/editor/`)
- `collab-schema.ts` — `collabExtensions()` (Node-safe, zero React/DOM imports),
  `SCHEMA_HASH`, `COLLAB_SCHEMA_VERSION = 1`, the projection/hash functions.
- `client-schema.ts` — `clientExtensions({ readOnly, isPaginated, collab })`, the
  client-only superset (view extensions + Yjs `Collaboration`/`CollaborationCaret` when
  `collab` is passed).
- `page-mention-node.ts` — `PageMentionNode`: the DOM-free `pageMention` schema (attrs,
  `parseHTML`, `renderHTML`) split out of `tiptap-mention-config.tsx`, which now only
  adds the node view (`document.createElement`) and suggestion picker (tippy/React/fetch).
- `code-block/CodeBlockNode.ts` — the DOM-free `codeBlock` schema (just the `language`
  attribute) split out of `CodeBlockShikiExtension.ts`, which now extends it with the
  React node view and Shiki highlight plugin.
- `block-id.ts` — `BlockId` extension: `blockId`, `changeId`, `changeType` global
  attributes on every block node (`BLOCK_NODE_TYPES`). Schema-only, inert — no UI, no
  commands. `blockId` is the anchor comments use (see decision below); `changeId`/
  `changeType` are the block half of tracked changes.
- `collab-marks.ts` — `CommentMark` (`threadId` only, deliberately no mutable state),
  `InsertionMark`, `DeletionMark` (`authorId`, `changeId`) — the inline half of tracked
  changes. Schema-only, inert.
- `image-node.ts` — `ImageNode`: `fileId`/`alt`/`width`/`height`, parses/renders via
  `data-file-id` only — never `src`. A plain `<img src="...">` (no `data-file-id`) does
  NOT parse as this node (falls through, still dropped — raw-HTML passthrough is an open
  decision, not silently resolved here).
- `__tests__/collab-schema-drift-guard.test.ts` — the drift guard (10 tests).
- `__tests__/v1-schema-additions.test.ts` — direct round-trip coverage per v1 addition
  (19 tests).

### Modified
- `RichEditor.tsx` — now imports `clientExtensions` directly (not the old
  `buildRichEditorExtensions` wrapper), so the drift guard's structural scan has
  something real to check.
- `rich-editor-extensions.ts` — `buildRichEditorExtensions()` is now a thin delegating
  wrapper over `clientExtensions()`, kept only because the census script and the mention
  round-trip test still import it.
- `tiptap-mention-config.tsx` — trimmed to the client-only node view + suggestion, per
  the split above.
- `code-block/CodeBlockShikiExtension.ts`, `code-block/index.ts` — extend/export the new
  `CodeBlockNode`.
- `font-formatting.ts` — **deleted**, not moved. Verified `TextStyleKit` already
  registers `fontFamily`/`fontSize` as global attributes on `textStyle` via its bundled
  `FontFamily`/`FontSize` extensions (`@tiptap/extension-text-style@3.23.5` source, both
  reading/writing the identical `style="font-family: …"` / `style="font-size: …"` shape
  `FontFormatting` did). It was a pure duplicate.
- `census/__tests__/round-trip.test.ts` — 4 tests updated: h4-h6, taskList, textAlign,
  and `<mark>` are no longer reported as dropped by the census, because v1 now
  represents them. `<sup>`/`<sub>` still drop (no v1 evidence for them — see below).
- `package.json`/`bun.lock` — added `@tiptap/extension-highlight@3.23.5`,
  `@tiptap/extension-text-align@3.23.5`, `@tiptap/extension-collaboration@3.23.5`,
  `@tiptap/extension-collaboration-caret@3.23.5`, `@tiptap/extension-list@3.23.5`,
  `yjs@13.6.32` — all exact-pinned to match the installed `@tiptap/core@3.23.5` line.
  `taskList`/`taskItem` did NOT need a new package: `@tiptap/extension-list` was already
  a transitive dependency (StarterKit imports `BulletList`/`ListItem`/`OrderedList` from
  it) and already ships `TaskList`/`TaskItem` at the same version.

## Schema additions (v1, per the RECOMMENDATION table in `oopiowlhezncu0m63tvees7i`)

| construct | verdict | how |
|---|---|---|
| `taskList`/`taskItem` | included | `@tiptap/extension-list`, already-pinned version |
| `image` | included, file-ref only | `image-node.ts`, `data-file-id`, never `src` |
| heading 4-6 | included | `StarterKit.configure({ heading: { levels: [1..6] } })` |
| `tight` (list attr) | already present | confirmed `Markdown` already registers `MarkdownTightLists` via its own `addExtensions()`; nothing to add |
| `highlight` | included | `@tiptap/extension-highlight`, pinned |
| `textAlign` | included | `@tiptap/extension-text-align`, `types: ['paragraph','heading']` |
| `raw-html` passthrough | **deferred, not silently dropped** | recorded as open in `collab-schema.ts`'s docstring — no node invented for it |
| `blockId`, inert `comment`/`insertion`/`deletion` | included | `block-id.ts`, `collab-marks.ts` |
| superscript/subscript | **not included** | not in the RECOMMENDATION table; no detector for them in `census/constructs.ts` either — no positive evidence, so skipped per the leaf's own rule ("a zero count is only decisive when the feature exists and nobody used it" — here there's no feature *or* evidence either way) |

Block-level tracked changes: `changeId`/`changeType` attributes added to every block
node in `block-id.ts`, alongside the inline `insertion`/`deletion` marks — the two are a
deliberate pair (block: "this whole paragraph is a pending change"; mark: "this run of
text within a block is a pending change"), matching the leaf's "either add block
attributes in v1, or record inline-only forever" — this PR takes the "add" branch.

## Where the extension sets live, and why

`apps/web/src/lib/editor/` — not `packages/editor` (explicitly out of scope: 21 files, 9
Docker COPY sites, its own change). Split into two files specifically so
`collabExtensions()` stays genuinely Node-safe: `collab-schema.ts` imports only
Node-safe TipTap extensions plus the DOM-free node/mark modules above; `client-schema.ts`
imports the React-dependent client variants (`PageMention`, `CodeBlockShiki`,
`PaginationPlus`, `Collaboration*`). A future headless collab server can import
`collabExtensions()`/`SCHEMA_HASH`/`COLLAB_SCHEMA_VERSION` from `collab-schema.ts`
without pulling in React at all. Moving both files into `packages/editor` later is a
file move (relative imports become package imports), not a rewrite.

Verified Node-safety directly: grepped every Node-safe file
(`collab-schema.ts`, `page-mention-node.ts`, `block-id.ts`, `collab-marks.ts`,
`image-node.ts`, `code-block/CodeBlockNode.ts`) for `document.`/`window.` — the only
hits are inside doc comments, none in executable code. `parseHTML`/`renderHTML`
callbacks all take an explicit `element`/`attributes` argument rather than touching a
global.

## Anchoring decision

Recorded on `d252zxw1sms1uetrls615zyz` (task `nellzsa0ww4vhpq9qft8f8pi`), not as a code
comment: **comments anchor on `blockId` + `Y.RelativePosition`**; `blockId` landed in
this PR. `packages/lib/src/content/anchoring/` is **retained**, not deleted — it's tag
infrastructure (`reanchor.ts:14-17` explicitly distinguishes tags from comments), out of
scope for the comment mark.

**Refinement found while implementing, recorded on the same page:** the leaf's premise
("only importer is `tag-core.ts`") undercounts — `apps/web/src/lib/editor/census/round-trip.ts`
also imports `projectContent` from `content/anchoring/text-projection.ts`, a genuinely
separate, zero-I/O, pure HTML→text flattening utility with its own purity test
(`content/anchoring/__tests__/purity.test.ts`). It is not the CRDT-incompatible piece —
that's `reanchor.ts`/`anchor.ts`/`resolve.ts`, whose correctness rests on
`applyPageMutation` holding one transaction. This strengthens the "do not delete" call
rather than reversing it: the directory has more real, comments-unrelated usage than
previously measured, and `text-projection.ts` should stay regardless of whether the tags
feature itself is alive (still an open product question, unchanged).

## Mutation checks (every new test file)

- **`collab-schema-drift-guard.test.ts`**: two tests are themselves mutation proofs —
  (1) `getSchema([StarterKit])` alone vs `collabExtensions()`'s full projection: asserted
  NOT equal (fails if the assertion machinery were vacuous). (2) A copy of
  `collabExtensions()` with the last extension (`DeletionMark`) sliced off: asserted the
  `deletion` mark is present in the full projection and absent in the sliced one — not
  just "not equal" but the *specific* thing that disappeared.
- **`v1-schema-additions.test.ts`** — mutated the real source, confirmed red, restored
  (diffed clean after restore):
  - `image-node.ts`: changed `parseHTML`'s tag selector from `img[data-file-id]` to
    `img[data-mutated-away]` → both image tests failed (`toContain('data-file-id=…')`
    and the `"type":"image"` presence check).
  - `block-id.ts`: deleted the `blockId` attribute definition from `addGlobalAttributes`
    → 3 tests failed (`toBeNull()` on a fresh node, the round-trip
    `toContain('"blockId":"b1"')`, and the "every block node has blockId" sweep).
  - `collab-marks.ts`: emptied `CommentMark.addAttributes()` → 2 tests failed (the
    `['threadId']` attrs-list assertion, and the round-trip presence check).
- Existing suites I touched (`census/__tests__/round-trip.test.ts`) already assert the
  *opposite* of the old behavior (`not.toContain`) — reverting my schema changes would
  turn those green assertions back into the failures the census originally reported, so
  they're mutation-proof by construction against exactly the regression that matters
  (v1 nodes silently stop being represented).

## Gates

- `bun run typecheck` (monorepo root): **17/17 tasks green** (this also ran `web:build`,
  which succeeded — full production build, no type errors).
- `bun run lint` (monorepo root): **15/15 tasks green**. Pre-existing warnings only
  (react-hooks/exhaustive-deps, unused eslint-disable) in files I did not touch.
- `bun run --filter web test`: **19077 passed / 30 failed / 223 skipped** across 1256
  files. All 30 failures are pre-existing and unrelated to this change — none touch
  editor/schema code:
  - ~20 are Postgres integration tests (`*.integration.test.ts` under
    `agent-workspaces`, `repositories`, `webhooks`, `monitoring`, `memory`,
    `ai/tools`) that need `bun run test` (the DB-backed runner), not the plain
    `--filter web test` invocation.
  - `export/csv` and `export/xlsx` route tests (~15 tests) — fail on `main`/unrelated to
    this PR's diff; xlsx/csv generation, not editor content.
  - `admin-role-version.test.ts`, `publish-page.test.ts`, `activity-tools.test.ts` — no
    connection to the editor schema.
  - I ran the entire `src/lib/editor/**` test tree explicitly: **all 349 tests across 21
    files pass**, including the new drift guard and schema-additions suites, the
    existing 37-test mention round-trip suite, and all 6 code-block suites.
- `bun run test` (the DB-backed full runner, `scripts/test-with-db.sh`): **could not
  complete** — the shared test Postgres container (`pagespace-postgres-test`, named and
  reused across every worktree in this repo per the script's own design) was already
  running in a partially-migrated state owned by another checkout (`relation "pages"
  does not exist` on a later migration). The script explicitly refuses to tear down a
  container it didn't start ("Leaving shared test container running (owned by another
  checkout)"), and I did not force it — that state belongs to whichever other session
  is using it. This is an environment/shared-infra issue, not something this PR's diff
  caused: no migration, schema, or DB code is touched here.
- `bun run knip`: pre-existing failures (4 duplicate exports, 7 config hints), none in
  files this PR touches. Not attempted to fix — out of scope.

## What I'd flag, not narrow scope on

Nothing in the v1 decision, the anchoring decision, or the block-level-tracked-changes
call turned out wrong against the real source — only the anchoring leaf's "only
importer" claim needed a refinement (recorded above), which supports the existing
decision rather than contradicting it.

The raw-HTML passthrough question (24 pages, flagged as "needs its own decision" in the
v1 leaf) is still open. I did not invent a node for it and did not drop it silently —
it's named as deferred in `collab-schema.ts`'s docstring.

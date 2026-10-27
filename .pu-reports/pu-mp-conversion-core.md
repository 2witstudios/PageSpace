# Phase B — the conversion core: `htmlToYDoc`, the four projections, `applyPmDocToYDoc`

All three leaves' acceptance criteria are met, in `packages/editor`. The headline results:

- **The cross-DOM parse-equality blocker is answered, and answered positively.** happy-dom and a
  real Chromium produce byte-identical ProseMirror JSON for every fixture in the construct corpus,
  including the three cases the leaf singled out as most likely to diverge (a single-quoted
  `font-family` in a `style` attribute, list tightness inferred via `querySelector('p')`, and a
  table written with no explicit `<tbody>`). This was the highest-impact unknown in Phase B and it
  is now a test that runs in CI, not an assumption.
- **Every construct in the corpus reaches a one-pass fixpoint and loses nothing.** 23 fixtures,
  measured, with the cosmetic rewrites named in an explicit allowlist rather than absorbed by a
  loose comparison.
- **Mutation testing found a real error in my own implementation**, described below. It is the one
  thing in this PR I would not have caught any other way.

`SCHEMA_HASH` is unchanged at `'ded0823d'` — nothing in this PR touches `collabExtensions()`.

## What landed

Nine new modules in `packages/editor`, all pure, all React-free, all importable from a Node
service with no DOM installed process-wide:

| module | what it is |
|---|---|
| `dom-workspace.ts` | happy-dom as a **production `dependency`**, wrapped so a window is never leaked and never installed as a global |
| `collab-document.ts` | memoised frozen schema, `COLLAB_FRAGMENT_FIELD`, `Y.Doc` ⇄ ProseMirror |
| `html-to-ydoc.ts` | the seed parse, `describeHtmlLoss`, fail-closed |
| `y-doc-to-html.ts` | the lossless projection — what `pages.content` keeps holding |
| `y-doc-to-text.ts` | the search projection — no markup, at all |
| `y-doc-to-markdown.ts` | the AI-context projection, on `prosemirror-markdown` directly |
| `y-doc-to-blocks.ts` | block addressing, replacing line-number splicing |
| `apply-pm-doc-to-y-doc.ts` | minimal CRDT diff via `updateYFragment` |
| `projection-errors.ts` | `UnknownNodeError`, `UnrepresentableContentError` |

287 tests, all new work mutation-checked. Coverage floors raised: lines 71 → 92, functions
53 → 96, statements 71 → 92.

## The correction mutation testing forced

My first `applyPmDocToYDoc` called `initProseMirrorDoc(fragment, schema)` to build a populated
binding mapping before `updateYFragment`, and the docstring asserted — confidently, in bold — that
passing a fresh empty mapping "would quietly defeat the whole thing, because every existing node
would fail the identity check and be rewritten."

**That was wrong.** The mutation that replaced the populated mapping with an empty one *survived*
every test. Measured directly: a one-word change in a 37 KB document emits a **41-byte** update
with a populated mapping and a **41-byte** update without one. On a mapping miss `updateYFragment`
falls back to `equalYTypePNode`, a deep structural comparison, so the diff is minimal either way.
`initProseMirrorDoc` materialises the entire fragment as ProseMirror nodes to build a mapping that
changes nothing — an O(document) walk on **every apply**, in the hot path of a service that applies
on every AI edit.

Removed. `y-prosemirror` itself passes `{ mapping: new Map(), isOMark: new Map() }` for exactly
this kind of one-shot conversion (`sync-plugin.js:564`), and `isOMark` is a lazily-populated memo,
so empty is not merely tolerable but correct.

What *is* load-bearing is `updateYFragment` rather than delete-and-reinsert, and that mutation goes
red: replacing it with `fragment.delete(...)` + `prosemirrorToYXmlFragment` fails the size and
identity assertions. The comment now says the true thing, with the measurement in it.

The general lesson is the one already in this epic's history: a test that only compares *documents*
cannot tell a correct diff from a correct-looking one. Both converge on the same content. Only
update size and Y-type identity separate them, so those are what is asserted.

## The corrections from the brief, and how each was handled

**1. Byte-identical round-trip is the wrong bar.** Not built. `seed-fidelity.test.ts` asserts
`render(parse(h1)) == h1` plus zero construct loss, and expresses the tolerance as
`ALLOWED_COSMETIC_ADDITIONS` — twenty named markup constructs one pass may add (`<colgroup>`,
`ul@data-tight`, `TaskItem`'s checkbox markup, `Link`'s `target`/`rel`, …), each with a comment
saying why its absence from the source is not information. A twenty-first fails the suite.

The allowlist has its own guard: a test asserts it contains **nothing the corpus does not actually
produce**, so it cannot rot into a blanket tolerance that hides the next real change. (That guard
must be computed per fixture and unioned, not over the concatenated corpus — in the concatenation a
construct one fixture gains is already present in another fixture's source, and five real rewrites
read as never produced. The comment records this.)

**2. No `tiptap-markdown` in the projector.** `yDocToMarkdown` is written on `prosemirror-markdown`
directly, over all 19 nodes and 11 marks of the frozen schema. (The leaf says "16 nodes and 7
marks" — that predates the v1 freeze, which added `taskList`/`taskItem`, `image`, the three collab
marks and the table nodes. The live count is 19/11.)

GFM tables are hand-written, because `prosemirror-markdown` has no table serializer: alignment from
each cell's `align` attribute, pipes escaped inside cells so a cell containing `|` cannot forge a
column boundary, and an empty header row when the first row is not a header — rather than promoting
a data row, which would silently change what the table says.

**3. happy-dom as a production dependency.** Done, with the reasoning in the module docstring. It
is never installed as `globalThis.window`/`document`: this package drives `prosemirror-model`'s
`DOMParser`/`DOMSerializer` with an explicit element, so importing it in a Node service mutates
nothing process-wide and two conversions cannot race on a shared document. Every window is closed
in a `finally`.

**4. The cross-DOM equality check.** `cross-dom-parse-equality.test.ts` bundles the real parse path
with esbuild, injects it into a Chromium page via `playwright-core`, and compares
`doc.toJSON()` against the happy-dom parse for all 23 fixtures, the whole corpus as one document,
and three targeted divergence candidates. **It does not skip when the browser is missing** — a
cross-DOM check that quietly reports green on a machine with one DOM is worse than no check — so
`.github/workflows/ci.yml`'s unit-test job gains one `playwright install chromium` step.

It runs under `// @vitest-environment node` rather than the package's default jsdom. Practical
reason: esbuild refuses to start under jsdom, whose `TextEncoder` does not return a real
`Uint8Array`. Better reason: the Node half of the comparison must parse through happy-dom
explicitly, and an ambient jsdom `document` in scope is exactly the accident that could make it
silently do something else.

Mutation-checked: making the browser strip `style` attributes before parsing turns the suite red,
so the comparison is real rather than two paths trivially agreeing.

**5. Minimal diff via `updateYFragment`.** See the correction above. Asserted: a one-word change in
a 200-paragraph document emits < 500 bytes and < 1/50th of the document; the diff is > 20× smaller
than replacing the fragment wholesale (that comparison is what gives the 500 its meaning); an
untouched paragraph keeps its Y-type **identity**, not merely equal content; a concurrent edit in
an untouched paragraph survives; a concurrent edit *inside the very paragraph being rewritten*
merges character-level; the whole apply is one transaction carrying the caller's origin.

**6. `y-prosemirror` pinned.** `"y-prosemirror": "1.3.7"` — exact, in the same commit that adds it,
alongside `"yjs": "13.6.32"` matching the root override. `prosemirror-model`, `-state`, `-view` and
`y-protocols` are declared explicitly to satisfy y-prosemirror's peers deterministically rather
than by hoisting luck; verified single copies of `yjs`, `prosemirror-model` and `y-prosemirror` in
the tree, because two copies of yjs throw "Yjs was already imported" at runtime.

**7. Fail closed.** Every projector throws `UnknownNodeError` on a node or mark the frozen schema
does not describe — including `y-doc-to-html.ts`, where it is *not* automatic:
`DOMSerializer.fromSchema` builds its map from the schema the **document** was created against, so
a foreign node serializes through whatever `toDOM` it brought, or yields nothing. Either way the
projection would be written and the loss invisible. An explicit name check turns that into a throw.

Block and inline are separate code paths in the text projection, and the first version only guarded
the block one — the inline guard was untested until a mutation exposed it (see below). Both are now
guarded and both mutations go red.

On the inbound half, `htmlToPmDoc` throws `UnrepresentableContentError` rather than seed a lossy
document: an `<img>` with no `data-file-id`, an `<iframe>`, `<video>`, `<svg>`, or any change to the
visible character stream. Error messages carry **counts and element names only** — never the markup
or the prose, because these run over production user content and land in logs and Sentry, and there
is a test asserting exactly that. `describeHtmlLoss` is exported so a bulk seed can survey a corpus
and route the exceptions in one pass instead of catching a page at a time.

`<br>` is deliberately excluded from the dropped-element check: ProseMirror legitimately discards a
trailing `<br>` at the end of a block (browsers emit those as caret padding), and counting them
would report a loss on markup that lost nothing — a false alarm on the seed path is a blocked
migration.

## Verification against the leaves' criteria

- **`SCHEMA_HASH` unchanged** — `'ded0823d'`, recomputed and confirmed.
- **Fixpoint + no loss over tables, nested lists, every `mentionType` (page/user/role/everyone plus
  the AI dialect), code blocks with `language`, all 11 marks, `<span style>`, tight vs loose lists,
  task lists, images with `fileId`, headings 1–6** — 23 fixtures, all green, plus the corpus as one
  document.
- **The text projection contains no markup** — asserted against nine markup tokens (`span`, `href`,
  `style`, `table`, `class`, `data-`, `<`, `>`, `colspan`) over a corpus that is full of all of
  them. One corpus fixture's prose was changed from "styled" to "tinted" so that `style` stays a
  pure markup token; leaving it would have made that assertion untestable rather than passing.
- **The markdown projection is materially cheaper** — under 60% of the HTML on the corpus by two
  independent proxies (characters, and whitespace/punctuation-delimited words). No tokenizer
  dependency was added: the gap is a factor, not a few per cent, so no tokenizer's segmentation
  could reverse it, and a production package should not carry one for a single assertion.
- **Same PM JSON under the Node shim and a real browser** — 28 assertions, green.

## Mutation checks

29 mutations, every one applied **by content-verified edit** (the harness asserts the file changed
on disk and restores it afterwards, so a no-op mutation is reported as INVALID, never as
"survived"). Three survived the first pass. All three are resolved:

| survivor | what it actually meant |
|---|---|
| text projection's unknown-**inline**-node throw | A **coverage gap**. The first-occurrence replace hit `inlineText`'s `default` branch, not `collectLines`' — the two functions end with the identical three lines. The block guard was covered; the inline one was not. Added a test with an unknown inline node inside a known paragraph; both mutations now go red. (This is the twin-line first-occurrence trap, again.) |
| `initProseMirrorDoc` → empty mapping | A **real defect in my code**, described above. Removed. |
| `<hr>` → `<hr/>` in the HTML projection | An **invalid mutation** — it does not break idempotency, since both passes emit `<hr/>`. Replaced with one that does (append a paragraph per render); that goes red. |

What was broken and confirmed red, by mechanism: the `@` sigil on mentions; block newline joining;
table-cell tab joining; images contributing no text; both unknown-node throws in the text
projection; `assertProjectable` in the HTML projection; `assertMarkdownProjectable`; heading level;
task-item checked state; cell pipe escaping; the image file reference; the code-fence language; the
fence widening past a nested backtick run; table column alignment; transparent underline; the
textless-element loss check; the visible-text loss check; script/style stripping; the throw on loss;
`COLLAB_FRAGMENT_FIELD`; per-block doc wrapping; `null` (not index) for a missing `blockId`; the
allowlist's own guard; the one-pass fixpoint assertion; `updateYFragment` vs delete-and-reinsert;
the single transaction and its origin; and the browser side of the cross-DOM comparison.

**On the `assert` hazard:** this package's suites use vitest's `describe/it/expect`, matching the
five that were already here. No riteway-style `assert({given, should, actual, expected})` is used
anywhere in the new tests, so the chai-truthy-global shadowing that shipped a production deadlock
behind 22 green tests in this epic is not reachable here.

## Decisions taken, and their costs

**The markdown projection is one-way.** It renders `pageMention` as its visible `@label` and drops
mention identity; `underline`, `highlight`, `textStyle` and the three collab marks pass through
transparently; `colspan`/`rowspan` have no GFM form. Every one of those preserves the *text* and
drops only an annotation, and `pages.content` (HTML) remains lossless. The consequence worth
flagging for Phase D: **a block tool that rewrites a block through markdown cannot preserve mention
identity**, so `replace_block` must carry ids out of band rather than expecting them in the
markdown. Stated in the module docstring, not buried.

**The image markdown is `![alt](pagespace-file:<fileId>)`.** The v1 `image` node holds a file
reference and never a URL, so there is nothing to put in the parentheses;
`prosemirror-markdown`'s default `image` serializer reads `node.attrs.src` and would throw. An
explicit non-resolvable scheme beats fabricating a URL, and keeps the reference recoverable.

**`yDocToBlocks` does not flatten nesting.** A list is one block. "Replace this list" is an
operation a caller can express safely; "replace the third `listItem` of the second list" is a
position, and positions do not survive concurrency.

**The text projection excludes image `alt`.** It is an accessibility annotation, not document
prose; putting it in the search corpus lets a decorative image's alt text answer a prose query.

**Coverage branch floor 94 → 92**, while lines/functions/statements rose sharply. Not a relaxation
of anything already covered: the new modules carry type-narrowing fallbacks the frozen schema
cannot reach (`node.text ?? ''` on a text node, `Number(attrs.level) || 1` on a heading), and
covering them would mean asserting against documents the schema forbids. Deleting the narrowing is
not available under `no any`. The reasoning is in `vitest.config.ts` next to the numbers.

## Cleanup pass (second commit)

A four-angle quality review (reuse / simplification / efficiency / altitude) ran over the diff.
What it changed, beyond the mechanical dedup:

- **The two fail-closed guards had already drifted.** HTML checked the document root, markdown did
  not — `descendants` never visits the root — so a document whose TOP node a projection cannot
  represent was accepted. Now one shared `assertProjectable`, and the root is checked. The *sets*
  stay separate on purpose: the markdown serializer's node map legitimately differs from the schema.
- **Two totality gaps.** Nothing compared the schema's node set against what each projector handles,
  so adding a node in a Class B change and forgetting a projector left CI green and threw in the
  collab service instead. And `BLOCK_NODE_TYPES` fails *open*: a block node missing from it silently
  yields `blockId: null`, which callers read as legitimate pre-v1 content and skip. Both are now
  compared against the schema in `projector-totality.test.ts`. The current lists are correct — the
  mechanism was the gap, not the data.
- **A latent bug the refactor surfaced:** `tableMarkdown` sized the table from the *first* row rather
  than the widest, so a ragged table dropped the extra cells of every wider row. Found by rewriting
  it around one `line()` helper; now tested.
- **The fidelity gate was blind to attribute VALUES.** `attr:p@style` merged the question with the
  answer — `text-align:center` becoming `left`, or `data-type="taskList"` becoming `taskItem`, moved
  no construct key. Now keyed per CSS property and per `data-type` value.
- **Removed a mirror test.** "preserves every visible character" recomputed what `describeHtmlLoss`
  already asserts and could not fail unless that failed first, while its duplicated whitespace rule
  would silently drift from `visibleCharacters`.
- **Efficiency, measured:** `assertMarkdownProjectable` rebuilt two `Set`s per call and
  `pmDocToBlocks` projects once per block — 400 throwaway sets on a 200-block document, ~40% of its
  runtime. Now built once.
- **CI:** the Chromium step had been inserted *between* the `ADMIN_DATABASE_URL` comment and the step
  it explains. Moved, and cached on the resolved Playwright version — with no CI concurrency group in
  this repo, every superseded run was re-downloading ~170MB.

Deliberately **not** done, each a real finding parked rather than dismissed:

- **`TEXTLESS_CONTENT_ELEMENTS` is a deny-list, so an unknown embed (`<math>`, `<model-viewer>`, the
  24 raw-HTML-passthrough pages) fails OPEN** — the one place the inbound half is not fail-closed.
  The fix is a catch-all "unrecognised `<tag>`" reason, which changes which documents refuse to seed.
  That belongs to the seed-fidelity leaf, with real corpus numbers behind it.
- **A `<br>` dropped mid-paragraph is undetectable** — `visibleCharacters` strips `\n`, and `<br>` is
  excluded from the element count to tolerate trailing caret padding. The precise fix (count only
  non-trailing `<br>` against `hardBreak`) is also a behaviour change; same leaf.
- **The happy-dom `Window` per call** (~1.1ms per flush, ~25% of the HTML projection). A shared
  module-level workspace would recover it, but it argues against a decision this module documents at
  length, and 1.1ms per flush is not the constraint. Noted, not changed.
- **`createDomWorkspace` now exists three times** (here, `apps/web/.../document-content-format.ts`,
  `apps/web/.../census/constructs.ts`). `apps/web` already depends on `@pagespace/editor`, so the
  direction is legal and this is the right home — but collapsing them edits `apps/web` and the census
  is documented as temporary. The `dom-workspace.ts` docstring now names both twins so the next
  reader is not misled.

Final: **283 tests**, 11 files. **19 further mutations** run against the refactored paths; four
survived and all four were genuine gaps in the new code (the root check, a label-less mention, an
empty `blockId`, and the ragged table), each now covered and re-confirmed red.

## Not in scope, and deliberately not done

- The **seed-fidelity gate over real production documents** is its own leaf (`jklkkf8aaao6v7jpc0mk8qub`,
  still `pending`). This PR builds the machinery and proves it over a synthetic corpus;
  running it against 4,771 real pages is that leaf's job, and `describeHtmlLoss` exists to make it
  a survey rather than a crash.
- **Markdown image ingestion** (`![alt](url)` → `fileId`) remains the open Phase K gate. Nothing
  here changes it.
- No `apps/collab` service, no wiring into `applyPageMutation`, no `page_docs` columns. Those are
  later phases; this is the pure core they rest on.

## Gates

At the monorepo root:

| gate | result |
|---|---|
| `bun run typecheck` | **green** — 19/19 tasks (includes `web:build`) |
| `bun run lint` | **green** — 17/17 tasks |
| `bun run knip:check` | **green** |
| `bun run test` | **could not run locally** — see below |
| `packages/editor` suite | **green** — 283 tests, 11 files |

`SCHEMA_HASH` unchanged at `'ded0823d'`.

**`bun run test` did not run here.** `scripts/test-with-db.sh` requires the Docker test-Postgres
container and the Docker daemon is not running in this environment (`Cannot connect to the Docker
daemon`). Two things worth stating plainly rather than glossing: the shell pipeline reported exit 0
because the failure was swallowed by `| tail`, which is exactly the trap `feedback_run_the_command_ci_runs`
describes — the real signal was in the body, not the status; and the run was a **no-op**, not a
pass. No suite outside `packages/editor` was executed locally. Nothing outside `packages/editor`
and one CI workflow step is touched by this diff, and `typecheck` (which builds every package
including `web`) and `lint` both ran clean across the whole monorepo, so CI is the gate for the
remainder. Do not read the table above as "the full suite passed".

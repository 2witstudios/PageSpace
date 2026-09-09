# Phase B — seed fidelity gate over real documents, and `userColor`

Both leaves are met in code and verified against fixtures and a seeded local database. **The
production run has not happened** — by design, the orchestrator holds that credential. The exact
command is at the end.

Headlines:

- **`scripts/collab-seed-audit.ts` runs every DOCUMENT page through BOTH chains on one parse** —
  the census chain (HTML → PM → HTML) and the seed chain (HTML → PM → Y.Doc → PM → HTML) — and
  prints the three criteria for each side by side, plus a table of exactly what differs between
  the two projections. If the seed chain is lossier than the census chain, the table names what
  `y-prosemirror` changed; the ProseMirror schema is held constant between them.
- **The audit already found a blind spot in the package's own seed gate.** `describeHtmlLoss`
  (what `htmlToYDoc` throws on) accepts a page that loses `<sup>`: the text survives, the mark does
  not, and the gate only measures text and textless elements. The audit reports this as a
  `gateBlindSpot` cell so the production run will say how many real pages are affected. Not fixed
  here — `sup`/`sub` are *representable* and adding them is a v1 decision, which the leaf reserves
  for the orchestrator.
- **The "never prints content" test caught a real PII leak in my first draft**: `alt` text was
  riding into construct keys (`attr:img@alt=<prose>`) and out to the terminal. Fixed by folding
  every value-bearing key except the schema's own enumerations back to presence form before
  tallying; the sentinel test now guards it.
- `SCHEMA_HASH` is unchanged at `'ded0823d'`. Nothing here touches `collabExtensions()`.

## What landed

| file | what it is |
|---|---|
| `scripts/collab-seed-audit.ts` | the audit — streaming, keyset-paginated, one query at a time, read-only at the server, exit 0 = PASS / 1 = BLOCKED |
| `scripts/lib/seed-audit/criteria.ts` | the three criteria as pure functions: 20 content counters, whitespace-stripped visible text, `isTagless` |
| `scripts/lib/seed-audit/analyze.ts` | `auditPage` — both chains, the divergence between them, and the package gate's own verdict per page |
| `scripts/lib/seed-audit/report.ts` | tallies with example page ids, census-keyed construct table, gate-agreement matrix, `contentFreeKey` |
| `scripts/lib/seed-audit/options.ts` | `--limit`, `--batch-size`, `--progress-every`; refuses a non-integer rather than auditing everything |
| `scripts/__tests__/collab-seed-audit.test.ts` | 48 tests, incl. read-only-by-construction and no-`Promise.all` scans of every audit source |
| `packages/editor/src/seed-fidelity.ts` | **new subpath** — `ALLOWED_COSMETIC_ADDITIONS`, `VALUE_BEARING_ATTRIBUTES`, `constructKeysOf`; extracted from the corpus test so the corpus and real documents are held to ONE allowlist |
| `packages/editor/src/user-color.ts` | **new subpath** — `userColor(userId)` and `USER_COLOR_PALETTE` (second leaf) |
| `packages/editor/src/html-to-ydoc.ts` | exports `parseHtmlElementUnchecked` (the parse without the gate), `describeParseLoss` (the gate's verdict over an already-parsed page), `stripNonContentElements` and `visibleCharacters` — so the audit measures exactly what the gate measures instead of mirroring it; `htmlToPmDoc` still throws |
| `packages/editor/src/y-doc-to-html.ts` | `pmDocToHtmlIn(doc, workspace)` — `pmDocToHtml` into a caller-owned window, for the audit's four renders per page |
| `packages/editor/src/collab-schema.ts` | `djb2` extracted from `hashProjection` and shared with `userColor` (hash value unchanged) |
| `packages/db/src/read-only-session.ts` | **moved** from `apps/web/src/lib/editor/census/` — its own docstring said "a second read-only consumer is the signal to promote it"; the census now imports `@pagespace/db/read-only-session` |
| root `package.json` | `@pagespace/editor` as a workspace devDependency (root scripts could not resolve it), and `bun run collab:seed-audit` |

Corpus additions in `packages/editor`: `bare-table` (no `<tbody>`, no spans, bare cell text) and
`bare-ordered-list` — each earns allowlist entries the leaf named but the corpus had never produced
(`td`/`th` `colspan="1"`/`rowspan="1"`, and `ol` gaining `class="tight" data-tight="true"`).

## The three criteria, exactly as implemented

1. **Stability** — `h1 === render(parse(h1))`, byte-equal. Per chain.
2. **Content-bearing loss** — instance counts of `img`, `h4`, `h5`, `h6`, `table`, `tr`, `td`,
   `th`, `li`, `pre`, `code`, `a[data-page-id]`, `span[data-mention-type]`, `mark`, `sup`, `sub`,
   `iframe`, `details`, `div` (outside task items — `TaskItem` renders its own `<div>`, and stored
   task-list markup already carries it, so it is excluded on both sides or a lost wrapper could be
   "paid back"), `input[type=checkbox]`. `src` vs `h1`; any decrease is loss; increases are not.
3. **Text** — `textContent` with `<script>`/`<style>`/`<noscript>`/`<template>` removed first
   (mirroring the seed parse) and **all whitespace stripped**, not collapsed to one space. The
   judgement call, and why: stored HTML is often pretty-printed, and the newline-and-indent between
   two `<p>` is a text node ProseMirror correctly drops — collapsing to a single space would fail
   every pretty-printed page for a reason that is not loss. The cost is that a space vanishing
   *between* words is invisible to criterion 3; that case is reported as a separate
   "whitespace-only text differences" diagnostic count (never a verdict).

Cosmetic rewrites are allowlisted in `ALLOWED_COSMETIC_ADDITIONS` (35 entries, every one earned by
a corpus fixture — the package test still asserts the list is not larger than the corpus produces).
Additions **outside** the allowlist are reported in their own table; they do not fail the run, but
they are the "look at this" list.

A page is LOSSY if any of the three fails on the seed chain. Any lossy page, or any page the chain
could not process, makes the run BLOCKED and the exit code 1. No thresholds anywhere.

## What the report also measures

- **Gate agreement.** For every page, `describeHtmlLoss` (the package gate) vs this audit's seed
  verdict, in four cells. `gate ACCEPTS, audit lossy` is the one to read first — those are pages
  Phase E would seed today.
- **Census comparison.** Dropped constructs are tallied twice: tag-qualified (`attr:p@style:text-align`)
  for diagnosis, and re-keyed to the census's own scheme (`style:text-align`, `<img>`) so the numbers
  line up with `apps/web/scripts/collab-content-census.ts` output row for row.
- **Tagless html-mode pages** (no HTML element at all — markdown or plain text under an html
  label). Not a criterion, because such a page passes all three trivially, but the count is put in
  the header next to the verdict so a PASS cannot hide it. The backfill reported 0 remaining; this
  is the cross-check.
- `contentMode='markdown'` pages are counted and skipped (Phase K), empty pages counted.

## Verified how

- **Fixtures**: 48 script tests + 344 editor tests (the corpus suites run over 25 fixtures now) +
  5 db tests + the census's own read-only scan in web (9). All green as single-file runs.
- **Seeded local database** (`pagespace_seed_audit`, migrated to head, 12 pages: clean, `<img>`
  without file id, `<iframe>`, `<style>` block, tagless markdown, markdown-mode, empty, TipTap task
  list, `h4`+mention+`mark`+`sup`, bare table + `ol start=7`, pretty-printed, and a FOLDER decoy).
  Result: BLOCKED, exit 1, 3 lossy pages (img, iframe, sup), 1 blind spot (sup), 1 tagless, 0
  divergence, 0 failures, correct skip of the FOLDER and the markdown page. `--limit 3` → 3 pages,
  exit 1. `--limit x` → refused. Database dropped afterwards.
- **Scale**: the local `pagespace_test` database (1,501 DOCUMENT pages, all tagless test
  fixtures) — 1.2 s wall (6.0 s before the `/simplify` pass below), PASS with the tagless NOTE in
  the header, exit 0. Extrapolated, the production corpus is well under a minute.
- **Read-only**: `SET default_transaction_read_only = on` on every connection, read back with
  `SHOW` before the first `select`; a test asserts that ordering in the source, and another scans
  every audit module for `insert`/`update`/`delete`/`transaction`/DDL keywords and the script for
  `Promise.all`. Note: bun's `pg` prints a `DeprecationWarning` for the `client.query()` issued from
  the pool's `connect` handler (the census has the same). The `SHOW` check proves the `SET` still
  runs first; the warning goes to stderr and not into the report.

### Gates

Local load was 129 (iOS simulator + Steam) with ten other pu agents running, so per the standing
rule I did **not** run the monorepo-wide `typecheck`/`lint`/`test` locally — CI is the gate for
those. What I did run: `bun run lint:scripts` (clean), a scratch `tsc --noEmit` over the audit
script, lib and test (clean — `scripts/` is in no tsconfig, so this is the only typecheck it gets),
eslint over every touched db/editor file (clean), and `bun run knip:check`. **knip:check fails
locally on 4 findings in `packages/lib/src/env-bridge` and `drive-envs` — files this branch does not
touch, and the known knip-in-a-pu-worktree phantom.** If CI's knip is red on those same four, they
are pre-existing on master; if it is red on anything under `scripts/` or `packages/editor`, that is
mine.

### `/simplify` pass (after the first push)

Four review agents (reuse, simplification, efficiency, altitude). Applied:

- **One DOM window per run, not five per page.** `pmDocToHtml` and `describeHtmlLoss` each opened
  a fresh happy-dom `Window` (~2 ms, ~0.26 MB, not collectable until the event loop turns — ~260 MB
  of transient heap per 200-page batch). The package now exports `pmDocToHtmlIn(doc, workspace)`
  and `describeParseLoss(source, doc)`; the audit renders and judges through its single workspace,
  and the gate stage no longer re-parses the page. Scale run: 6.0 s → 1.2 s over 1,501 pages; the
  seeded-fixture report is byte-identical before and after.
- **No mirrored constants.** `criteria.ts` imported `visibleCharacters`/`stripNonContentElements`
  from `html-to-ydoc.ts` instead of carrying copies "that mirror" them — the audit now cannot drift
  from what the gate sees.
- **Printability lives beside the value-bearing list.** `PRINTABLE_ATTRIBUTE_VALUES` and
  `contentFreeKey` moved into `packages/editor/seed-fidelity.ts`, next to `VALUE_BEARING_ATTRIBUTES`,
  with a package test that the printable set is a subset and that the non-printable complement is
  exactly the prose/url/id attributes. Adding a value-bearing attribute now forces the decision in
  the same file.
- One `djb2` (was copied into `user-color.ts`); gate-agreement counts derived from the one tally
  rather than kept as a second counter; `record(pageId, verdict)` instead of passing the whole
  audit plus a chain selector; `FailureStage` named once; a `chainResult()` test helper; the
  test-only `constructsOf` export pulled back into the test; the accidental `workspaces` reflow in
  the root `package.json` reverted.

Skipped, deliberately: sharing `main()`/the option parser/the read-only scanner with the census
(cross-app — apps/web cannot import root `scripts/` and vice versa, and the census is documented as
temporary); a `getReadOnlyDb()` pool with `default_transaction_read_only` as a connection option
(right idea, but new shared pool infrastructure in `packages/db` is outside this leaf — noted as a
follow-up); filtering markdown/empty rows in SQL (changes what `--limit` counts); moving the
census's `HTML_ELEMENT_NAMES`-aware tagless rule and key scheme into `packages/editor` (the right
home, but it drags the whole census module with it — `isTagless` here is the weaker
"no element at all" rule, which counts an unescaped `<T>` in prose as HTML; flagged so the
production tagless count is read with that in mind); the task-item `div` exclusion staying in the
audit rather than as schema-chrome metadata in the package.

Two mutations SURVIVED the first re-check after the refactor and were fixed by strengthening tests:
deriving `bothLossy` from the wrong cell (the agreement test had one page per cell, so every count
was 1 — now 2/1/3/4), and judging the gate over the unstripped source (no test asserted the gate's
verdict on a `<style>` page — now it does).

### Mutation sweep — 33 mutations, 0 survivors (first pass) + 12 after the refactor, 0 survivors after fixes

Each mutation was applied by exact-needle replacement with the runner asserting the needle occurred
once, the file content changed on disk, the test went red, and the file was byte-identical to the
original after restore. `S2` rebuilt the editor dist before and after, since the scripts tests
import `@pagespace/editor` from `dist`.

| id | what I broke | red? |
|---|---|---|
| U1 | djb2 → sum of char codes (anagram ids collide) | ✔ (`distinguishes ids` test) |
| U2 | one palette entry to a low-contrast pink | ✔ |
| U3 | index modulo 3 instead of palette length | ✔ (spread + pin) |
| U4 | duplicate palette entry | ✔ |
| S1 | drop `attr:td@colspan=1` from the allowlist | ✔ (`bare-table`) |
| S2 | `el:${tag}` → `el:${tag}x` (via scripts tests, dist rebuilt) | ✔ 7 tests |
| S3 | `constructDifference` inverted | ✔ 52 tests |
| R1 | `SET … = off` | ✔ |
| R2 | `assertReadOnlySession` inverted | ✔ |
| C1 | remove the `img` counter | ✔ 6 tests |
| C2 | decrease → increase | ✔ |
| C3 | stop excluding task-item `<div>` | ✔ |
| C4 | stop stripping `<style>` | ✔ |
| C5 | strip whitespace → collapse to one space | ✔ |
| C6 | `isTagless` inverted | ✔ |
| A1 | instability no longer lossy | ✔ |
| A2 | gate reason shape not folded | ✔ |
| A3 | `stage = 'render'` not recorded | ✔ |
| A4 | divergence comparison flipped | ✔ |
| A5 | unexpected additions ignore the allowlist | ✔ |
| A6 | whitespace-only diagnostic inverted | ✔ |
| P1 | census element key loses its brackets | ✔ |
| P2 | `alt` made printable | ✔ (sentinel test) |
| P3 | failures no longer block | ✔ |
| P4 | four example ids | ✔ |
| P5 | PASS/BLOCKED swapped | ✔ |
| P6 | blind spot counted as "gate stricter" | ✔ |
| P7 | tagless NOTE only from 2 pages | ✔ |
| P8 | census-key fold not de-duplicated | ✔ |
| O1 | `--limit 0` accepted | ✔ |
| T1 | an `INSERT` string appears in a lib module | ✔ |
| T2 | `Promise.all` appears in the script | ✔ |
| T3 | `assert` moved before `enforce` | ✔ |
| U1′ | shared `djb2` loses order | ✔ |
| E1 | `<style>` no longer stripped in the package (via scripts tests, dist rebuilt) | ✔ |
| E2 | `visibleCharacters` collapses to a space (package, via scripts) | ✔ |
| E3 | `describeParseLoss` never reports dropped elements (package, via scripts) | ✔ |
| E4 | `alt` made printable in the package (via scripts) | ✔ sentinel |
| E5 | `pmDocToHtmlIn` skips `assertProjectable` | ✔ 4 tests |
| P6′ | blind spot counted as "gate stricter" | ✔ |
| P9 | `bothLossy` derived from the `bothClean` tally | survived → test fixed → ✔ |
| P10 | `bothClean` rows leak into the example table | ✔ |
| A7 | gate judged over the unstripped source | survived → test fixed → ✔ |

Honest gap: "divergence always `null`" (as opposed to flipped) would survive, because no fixture
I could construct makes `y-prosemirror` alter a projection — every construct in the corpus and the
seeded DB round-trips through the Y.Doc byte-identically. The divergence *accounting* is fully
tested through `divergenceBetween` and the accumulator; the trigger will be exercised the first time
production produces a divergent page. Every riteway-style `assert` concern is moot here — the tests
use `expect` from an explicit `vitest` import (`globals: false` in `scripts/vitest.config.ts`).

## Findings to carry to the orchestrator

1. **`<sup>` (and `<sub>`) are silently dropped and the seed gate does not notice.** Representable →
   report, do not add. The production run will give the population; the leaf's three outcomes
   apply: v1 addition (orchestrator decision), quarantine, or "schema is wrong" if corpus-wide. The
   census never had a `sup`/`sub` detector, so this is the first measurement.
2. **The `describeHtmlLoss` gate is text-and-textless-elements only.** Any inline *mark* loss
   (`sup`, `sub`, a future unknown span) passes it. Phase E's "fidelity check that refuses rather
   than storing a lossy doc" should run this audit's criteria, not just `describeHtmlLoss`. Worth a
   leaf.
3. `contentFreeKey` in the audit is the reason construct keys can be printed; the package's
   `constructKeysOf` is deliberately NOT content-free (the corpus test needs to see a rewritten
   href). Anyone else printing those keys from real data must fold them the same way.

## The command to run against production

From the repo root of a checkout at this branch (or master once merged), with the dist builds in
place (`bun install`, then `@pagespace/db`, `@pagespace/lib`, `@pagespace/editor` builds), and
`DATABASE_URL` pointing at production the same way the census was run:

```bash
# smoke first — 200 pages, prints the full report shape, exit code tells you the verdict
DATABASE_URL='<production url>' bun run collab:seed-audit --limit 200 > seed-audit-smoke.txt

# the real run — ~4,769 DOCUMENT pages, expect well under a minute
DATABASE_URL='<production url>' bun run collab:seed-audit > seed-audit.txt
echo "exit $?"
```

Only the report goes to stdout; progress (every 500 pages), the schema version/hash banner and the
`pg` deprecation warning go to stderr. Exit 0 is PASS; exit 1 is BLOCKED, a processing failure, or
Ctrl-C (which still prints what it has, labelled INTERRUPTED). Read the header NOTE (tagless count),
then `gate ACCEPTS, audit lossy`, then the seed-chain criterion failures table, in that order.

Then compare `seed chain — constructs dropped, census keys` against the 2026-08-24 census output:
matching rows mean the schema is the whole story; anything in the `y-prosemirror` table is the
CRDT layer's doing.

## Board

Both tasks left `in_progress`: `jklkkf8aaao6v7jpc0mk8qub` (gate) and `p7ant1pe661k0izfpxh4ohje`
(`userColor`). Phase B does not close until the production run reads PASS.

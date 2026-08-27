# Backfill the 3,003 mislabelled markdown documents

Branch: `pu/mp-contentmode-backfill` · Board task: `sdnmolb83k4h2u04009r9kt0`

## What this is

`pages.contentMode='html'` claims a page is HTML. The collab content census measured 3,003
DOCUMENT pages (of 3,488 non-empty html-mode pages) that parse to **zero real HTML elements** —
they hold markdown source under the wrong label. `htmlToYDoc` on markdown source succeeds without
throwing and returns one paragraph of raw markdown as literal text: every heading, list, code
fence and table is destroyed, permanently, the moment that content is seeded into a Y.Doc. This is
the hard gate on Phase E (seeding) that the epic named.

This PR ships the classifier and the backfill script. **It does not run the backfill against
production** — see "What to run" below.

## 1. The classifier

`apps/web/src/lib/editor/document-content-format.ts` — `classifyDocumentContent(content,
workspace)` classifies stored content as `'empty' | 'html' | 'markdown-source' | 'unknown'`
(confidence-gated) **by parsing the content**, never by trusting `contentMode`.

**`detectPageContentFormat` (packages/lib) was evaluated and not reused.** It decides `html` from
a boundary heuristic (`trimmed.startsWith('<') && trimmed.endsWith('>')`) with no DOM parse and no
markdown category. `# heading\n\nsome text ending in >` satisfies that heuristic and would be
misclassified `html` despite containing zero real elements — exactly the failure mode this backfill
exists to catch. It remains correct for its own callers (diffing/version-snapshot format detection
across html/json/tiptap/text), where a wrong markdown-vs-text guess has no data-loss consequence;
nothing about it was changed.

Instead, the classifier parses content with the same DOM-inspection method the collab content
census used to measure the 3,003-page population — the only method proven against production data
(`hasRealHtmlElement`, moved out of `census/constructs.ts` into this permanent module together with
`HTML_ELEMENT_NAMES`/`UNESCAPED_ANGLE_BRACKET_KEY`, since the census itself is TEMPORARY BY DESIGN
and slated for deletion once `COLLAB_SCHEMA_VERSION` v1 freezes — a future Phase E seed-guard needs
to keep importing this classifier after that deletion). `census/constructs.ts` keeps its own richer
`DomWorkspace` (needed for its round-trip diffing) and imports only the two shared primitives.

A parse failure classifies as `{ confident: false }` rather than guessing — callers must skip and
report these, never act on them.

Tests: `apps/web/src/lib/editor/__tests__/document-content-format.test.ts` (7 cases), including the
exact trap (`ActionResult<void>` in prose must not read as HTML) and the `detectPageContentFormat`
boundary-heuristic failure case reproduced directly.

## 2. The backfill script

`apps/web/scripts/backfill-mislabelled-content-mode.ts` (thin CLI wrapper) +
`apps/web/src/lib/editor/content-mode-backfill.ts` (testable core, same script/core split as
`collab-content-census.ts` vs. `census/`).

**Choice recorded: corrects the LABEL, never the content.** `contentMode` is flipped to
`'markdown'`; the markdown source itself is never touched or converted to HTML. Two reasons:

1. Converting would run the exact lossy markdown-through-an-HTML-parser path the census exists to
   warn about — it succeeds without throwing and comes back as prose, which is the whole trap.
   Relabelling makes zero content changes, so there is nothing to verify per page beyond the
   classification itself.
2. Phase K already scopes a dedicated markdown migration onto the real editing surface once the
   schema freezes. Relabelling is what puts these 3,003 pages into that correctly-scoped
   population, matching the plan's own framing ("Phase K's real population is roughly four times
   the label count").

**Verification per page, not aggregate.** Every `contentMode='html'` DOCUMENT page (trashed
included — a restored page is seeded like any other) is classified individually; a page that
cannot be classified confidently is skipped and reported by id + error-type, never corrected.

**Reversible.** Only `contentMode` changes — `content`, `revision`, `updatedAt` are untouched
(`updatedAt` pinned to its prior value, so this reads as a label correction, not a user edit, in
the UI or GDPR export). Every corrected page id is written to `--out <path>` as a JSON array;
`--revert <path>` reads that file back and flips exactly those ids to `'html'` again, guarded so a
page a user has since re-saved through the real markdown migration (i.e. no longer `'markdown'`)
is left alone rather than forced.

**Dry-run is the default.** `--apply` refuses to run without `--out <path>`, so the correction can
never be un-reversible for want of a log. Compare-and-swap on the exact `content`/`contentMode`
read guards every write against a page edited between the select and the write; a concurrently
modified row is skipped and reported, never clobbered. Per-batch writes run concurrently
(`Promise.all`, capped at the 200-row batch size); the revert path is one batched
`UPDATE ... WHERE id = ANY(...) RETURNING id`.

**Never prints document content.** Every log line is page ids, counts, and JS error *names* only.

Tests: `apps/web/src/lib/editor/__tests__/content-mode-backfill.test.ts` (17 cases) — dry-run vs.
apply, correctly-labelled pages left alone, empty pages left alone, low-confidence classification
skipped and reported, concurrent-modification skip, cursor pagination termination, updatedAt
pinning, batched revert (including a mixed reverted/already-changed result and the empty-list
no-op), and every `parseBackfillArgs` branch.

## 3. Re-running markdown construct detection at the corrected population

**Not done in this PR.** The leaf's acceptance criteria (per the task page) scope this PR to the
classifier + backfill script; re-running `collab-content-census.ts`'s markdown-construct detection
across the corrected ~4,000-page population is a follow-up run against production, using the
already-existing census script, once this backfill has actually executed. Flagging this explicitly
rather than silently narrowing scope.

## 4. Phase E hard-precondition guard — not yet wired, and correctly so

The task page's requirement ("a seed that encounters markdown source in an html-mode page must
refuse, not proceed") describes a precondition Phase E's seed code must enforce. **Phase E doesn't
exist in the codebase yet** (per the plan: "Then the schema construction leaves... in the recorded
Phase B order" — schema freeze and Phase E are both still ahead). There is no seed function to gate.
What this PR does instead: places the classifier in a permanent module
(`document-content-format.ts`) specifically so that when Phase E's seed path is built, it imports
`classifyDocumentContent` from here and refuses on `'markdown-source'`/`'unknown'` results — the
guard's *mechanism* exists now; its *call site* doesn't exist to wire it into yet.

## Mutation checks

Every test file was mutation-checked: broke the mechanism, confirmed the relevant tests went red,
restored, confirmed green again.

- `document-content-format.ts`: `hasRealHtmlElement`'s tag-match branch flipped to always return
  `false` → 4 tests failed (`classifies real HTML markup as html`, `classifies markdown embedding
  real raw HTML as html`, plus the corresponding backfill-core tests that depend on real HTML being
  recognized) → restored, 22 tests green.
- `content-mode-backfill.ts`, concurrent-modification path: made the `rowCount === 0` branch push
  to `corrected` instead of `skippedConcurrentModification` → 1 test failed (`a row modified
  concurrently between select and write is skipped, not clobbered`) → restored, 17 tests green.
- `content-mode-backfill.ts`, batched revert: swapped `reverted`/`skippedAlreadyChanged` filter
  predicates → 3 tests failed (all three `revertBackfill` result-shape tests) → restored, 17 tests
  green.

## Gates

Worktree was rebuilt clean before gating (`bun install`; `@pagespace/db` and `@pagespace/lib` dist
builds; `apps/web` prod build) per repo convention.

- `bun run typecheck` (monorepo root): **17/17 tasks successful.**
- `bun run lint` (monorepo root): **15/15 tasks successful** (only pre-existing warnings unrelated
  to this diff).
- `bun run knip:check`: **within baseline** (4/4, no new issues).
- Full test suite, run against a dedicated isolated Postgres (the fixed-name shared test container
  used by `scripts/test-with-db.sh` is shared across every concurrent worktree/session on this
  machine and was being torn down and rebuilt mid-run by other sessions throughout — chasing that
  down cost real time before it was conclusively ruled unrelated to this diff):
  - `packages/db`: **45/45 files, 664/664 tests.**
  - `packages/lib`: **494/495 files, 11,264/11,264 tests** — the one excluded file
    (`gdpr-eraser.integration.test.ts`) is self-documented as requiring a **separate, dedicated
    scratch Postgres** (never the app DB) via `ADMIN_DATABASE_URL`; CI provisions that, this
    verification run did not.
  - `apps/processor`: **66/69 files, 1,163/1,163 tests** — the 3 excluded files need the same
    separate `ADMIN_DATABASE_URL` scratch DB (one of them literally names its own throwaway
    database, `pagespace_main_siem_it` — this is also what explains the stray scratch databases
    observed sitting in the shared container).
  - `apps/realtime`: **33/33 files, 1,146/1,146 tests.**
  - `apps/web`: **1,253/1,254 files, 19,263/19,269 tests** (1 file/6 tests skipped, pre-existing,
    unrelated).
  - None of the excluded/skipped tests touch this diff's files.

## What command to run against production

**Do not run this yourself — the orchestrator holds the production credential.**

```bash
# 1. Dry run first. Sanity-check the reported count against the census's 3,003.
cd apps/web && bun run backfill:content-mode

# 2. Apply, with the ids log kept somewhere durable.
bun run backfill:content-mode -- --apply --out mislabelled-content-mode-backfill-<date>.json

# Revert path, if ever needed:
bun run backfill:content-mode -- --revert mislabelled-content-mode-backfill-<date>.json
```

## Files changed

- `apps/web/src/lib/editor/document-content-format.ts` (new) — the classifier.
- `apps/web/src/lib/editor/content-mode-backfill.ts` (new) — the backfill's testable core.
- `apps/web/scripts/backfill-mislabelled-content-mode.ts` (new) — CLI entry point.
- `apps/web/src/lib/editor/__tests__/document-content-format.test.ts` (new).
- `apps/web/src/lib/editor/__tests__/content-mode-backfill.test.ts` (new).
- `apps/web/src/lib/editor/census/constructs.ts` — refactored to import
  `HTML_ELEMENT_NAMES`/`UNESCAPED_ANGLE_BRACKET_KEY` from the new permanent module instead of
  owning a second copy; its own richer `DomWorkspace`/`createDomWorkspace` (needed for round-trip
  diffing) is unchanged and stays local. All 7 existing census test files still pass unmodified
  (131 tests).
- `apps/web/package.json` — added `backfill:content-mode` script.

## Board status

Leaving task `sdnmolb83k4h2u04009r9kt0` `in_progress` — it completes on merge, which is the
orchestrator's call, per instructions. (Also noting: PageSpace MCP tools are not connected in this
`pu` worktree session, so I could not read/write the board directly from here regardless.)

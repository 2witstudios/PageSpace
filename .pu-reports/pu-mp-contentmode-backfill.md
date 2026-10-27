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

**Reversible.** `content` is never touched. `contentMode` flips, `updatedAt` is pinned to its prior
value (so this reads as a label correction, not a user edit, in the UI or GDPR export), and
`revision` is bumped by 1 on every write (see "Review round" below for why). Every corrected page
is written to `--out <path>` as `{ id, revisionAfterApply }` objects, **incrementally after each
batch commits**; `--revert <path>` reads that file back and flips exactly those pages to `'html'`
again, requiring both `contentMode='markdown'` AND the exact recorded `revisionAfterApply` — a page
genuinely edited since (through the real markdown migration or otherwise; every ordinary save bumps
`revision`) no longer matches and is reported as skipped rather than having that edit discarded.

**Dry-run is the default.** `--apply` refuses to run without `--out <path>`, so the correction can
never be un-reversible for want of a log. Compare-and-swap on the exact `content`/`contentMode`
read guards every write against a page edited between the select and the write; a concurrently
modified row is skipped and reported, never clobbered. Per-batch writes run concurrently
(`Promise.all`, capped at the 200-row batch size); the revert path is one batched UPDATE whose WHERE
clause pins each id to its own expected revision (`or(and(id=X, revision=rX), and(id=Y,
revision=rY), ...)` — a single `inArray` on ids alongside a separate `inArray` on revisions would
cross-match any id against any revision in the list, not the specific pairing this guard needs).

**Never prints document content.** Every log line is page ids, counts, and JS error *names* only.

Tests: `apps/web/src/lib/editor/__tests__/content-mode-backfill.test.ts` (22 cases) — dry-run vs.
apply, correctly-labelled pages left alone, empty pages left alone, low-confidence classification
skipped and reported, concurrent-modification skip, cursor pagination termination, updatedAt
pinning, the revision bump using a SQL increment expression (not a stale JS-side value),
`onBatchCorrected` firing once per batch with only that batch's corrections (and never in dry-run,
and never for a batch that corrected nothing), batched revert (including the per-row revision
pairing, a mixed reverted/already-changed result, and the empty-list no-op), and every
`parseBackfillArgs` branch.

## Review round (CodeRabbit + Codex, PR #2511) — findings and what changed

Both automated reviewers converged independently on the same two P1/Major findings, plus one more
each. All were verified against the actual source (not taken on faith) before acting.

1. **Increment `revision` when relabelling live pages (Codex, P1).** Verified: `applyPageMutation`
   (the normal save path) never reads or writes `contentMode`, and a raw `contentMode` flip with no
   revision bump leaves a client session that had the page open under the old mode with a still-valid
   `expectedRevision`. Its next ordinary save would then land content under the label that no longer
   matches what it actually wrote — recreating, in the opposite direction, the exact mismatch this
   migration exists to fix. **Fix:** the apply write now also sets `revision = revision + 1` (a SQL
   expression, not a stale read value, so it's correct even under concurrent writes). This forces
   the existing `PageRevisionMismatchError` / 409 "modified elsewhere" path on that client's next
   save — the codebase's already-established mechanism for exactly this class of staleness.

   Considered and rejected: routing through `applyPageMutation` (as the existing
   `convert-content-mode` API route does) to also get realtime broadcast and a `page_versions`
   snapshot. Rejected because that route's job is a genuine content *conversion* (turndown/marked)
   for a single page a user requested — running it here would mean creating ~3,003 broadcast events
   and version-snapshot rows for a correction that changes zero bytes of content, and worse, its
   markdown-mode conversion path feeds content through `marked.parse()` assuming real HTML input —
   exactly the lossy path this whole backfill exists to avoid, since our population's content is
   already raw markdown text. The revision bump alone eliminates the actual data-corruption risk
   (silent wrong-mode writes); it does not eliminate a stale client needing to refresh, which Codex's
   own alternative ("or require the backfill to run while writes are quiesced") already accepts as
   within tolerance for a one-time migration.

2. **Guard `--revert` against edits made after apply (Codex P1 + CodeRabbit Major).** Verified: the
   original revert only checked `contentMode='markdown'`, so a page a user had genuinely edited
   after the backfill (content changed, but `contentMode` legitimately stays `'markdown'`) would
   still match and get forced back to `'html'`, discarding the edit and recreating the exact
   mislabelling this PR fixes. **Fix:** solved by the same revision bump above — `--revert` now
   requires the page to still be at the exact `revisionAfterApply` this run recorded, and any
   ordinary save since (which always bumps revision) makes that page fail the guard and be reported
   as skipped. (CodeRabbit's suggested alternative, a separate content-digest column, would add a
   new persisted field for a check the existing revision counter already answers precisely.)

3. **Persist the revert manifest incrementally, not only once at the end (Codex P1 + CodeRabbit
   Major).** Verified: `--out` was written exactly once, after the entire run. A process killed
   partway through a multi-thousand-row run would leave every already-committed correction with no
   record to revert it by. **Fix:** `planAndApplyBackfill` gained an `onBatchCorrected` callback,
   invoked after each batch's writes commit; the CLI wrapper appends to the manifest and rewrites
   `--out` after every batch. This bounds exposure to at most one in-flight batch (200 rows) instead
   of the whole run. Not implemented as a true write-ahead-log/transactional-audit-record (what
   CodeRabbit's "Heavy lift" label suggests) — that is disproportionate engineering for a one-time,
   human-operated migration script of this size; per-batch durability resolves the actual risk named
   (an unrecoverable partial run) without it.

4. **`HTML_ELEMENT_NAMES` was missing `search` (CodeRabbit Minor).** Verified empirically (not just
   via the review's own citation): happy-dom parses `<search>` as a real `search`-tagged element
   (confirmed with a throwaway probe script), and `search` was absent from the set, so
   `<search>only content</search>` misclassified as `markdown-source` and would have relabelled a
   genuinely-HTML page. **Fix:** added `search` to the set, plus a regression test asserting a bare
   `<search>` element (no nested known element) classifies as `html`. Mutation-checked: removing it
   again made the new test fail as expected.

5. **Nitpick — rename `priorUpdatedAt` to `PRIOR_UPDATED_AT` (CodeRabbit Trivial).** Declined, with
   evidence: the exact precedent this test's pattern was modeled on
   (`scripts/__tests__/backfill-legacy-ciphertext-reencrypt.test.ts:100`) uses camelCase
   `priorUpdatedAt` for the identical fixture; this repo's own style guide
   (`.claude/rules/javascript/javascript.mdc`) states "Avoid ALL_CAPS for constants... there's no
   need for a hard distinction between constants and variables"; and a scan of top-level `Date`
   fixtures across `apps/web/src/**/__tests__/*.test.ts` shows a genuine mix of both conventions in
   active use. No change made.

All four substantive findings were fixed and mutation-checked (broke the mechanism, confirmed the
relevant new/updated test went red, restored, confirmed green). See "Mutation checks" below.

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

Review-round fixes, each mutation-checked the same way:

- `document-content-format.ts`: removed `search` from `HTML_ELEMENT_NAMES` → the new `<search>`
  regression test failed as expected → restored, 8 tests green.
- `content-mode-backfill.ts`, revert per-row guard: dropped the revision pairing from the `or(...)`
  branches (`or(...corrections.map(c => eq(pages.id, c.id)))`, i.e. matching on id alone) → the new
  "builds the WHERE clause as a per-row pairing" test failed as expected → restored, 21 tests green.
- `content-mode-backfill.ts`, `onBatchCorrected` guard: dropped the `batchCorrected.length > 0`
  check before invoking the callback → initially passed against the existing test (which used a page
  that was never mislabelled at all, so the guarded branch was never reached) — caught as a gap in
  my own test, not the code; added a second case (a mislabelled page whose write loses the
  compare-and-swap, so `batchCorrected` stays empty even though the batch had mislabelled pages) →
  the mutation now correctly fails that test → restored, 22 tests green.

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
- Review-round fixes were re-gated after every change: `bun run typecheck` (root, forced past a
  stale turbo cache) 17/17, `bun run lint` 15/15, `bun run knip:check` within baseline, and the full
  `apps/web` test suite re-run clean (this round's changes are scoped entirely to
  `apps/web/src/lib/editor/` and `apps/web/scripts/`, so a full `apps/web` run is the right-sized
  re-verification rather than repeating the full isolated-Postgres monorepo run for an untouched
  set of packages).

## What command to run against production

**Do not run this yourself — the orchestrator holds the production credential.**

```bash
# 1. Dry run first. Sanity-check the reported count against the census's 3,003.
cd apps/web && bun run backfill:content-mode

# 2. Apply, with the ids log kept somewhere durable. The file is written
#    incrementally as each batch commits, not just once at the end.
bun run backfill:content-mode -- --apply --out mislabelled-content-mode-backfill-<date>.json

# Revert path, if ever needed — flips back only pages still at the exact
# revision the apply run left them at (an edit since is left alone):
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

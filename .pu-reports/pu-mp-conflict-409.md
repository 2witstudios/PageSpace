# PR 1 — Stop discarding local edits on 409

Board: Multiplayer Documents (Yjs CRDT), Phase A, task `jc5su9gmeohiyo3ulzu7o143`.
Client-side only. No server code touched; the 409 contract in
`apps/web/src/app/api/pages/[pageId]/route.ts` is unchanged.

## Why this PR touches four files outside the document view

A reviewer opening this diff sees `CanvasPageView`, `CodePageView`, `SheetView` and
`TaskListDescription` changed in a PR titled "409 conflict fix". That is not scope creep — it is a
dependency, and omitting it would ship a worse bug than the one being fixed.

`useDocument` has **five** production consumers, and every one of them writes through the same
`saveWithDebounce` / `forceSave` this PR now guards:

| Consumer | File |
|---|---|
| Document | `page-views/document/DocumentView.tsx:58` |
| Code | `page-views/code/CodePageView.tsx:95` |
| Canvas | `page-views/canvas/CanvasPageView.tsx:88` |
| Task list | `page-views/task-list/TaskListDescription.tsx:33` |
| Sheet | `page-views/sheet/hooks/useSheetPersistence.ts:32` (rendered by `SheetView.tsx`) |

The conflict guard lives in the **hook**, so all five stop autosaving the moment a conflict is
parked. The resolution UI originally lived only in `DocumentView`. That asymmetry means a 409 on a
Canvas or Sheet page would park a conflict, silently block every subsequent save, flash one toast,
and leave the user editing a document that never saves again — with nothing on screen to explain it
and no way to clear it. Edits would survive in memory until reload, then vanish. Strictly worse than
the original bug, which at least lost the buffer once and visibly.

So the guard and its release valve have to sit at the same altitude. `DocumentConflictGate`
(`page-views/document/DocumentConflictGate.tsx`) renders `null` until a conflict exists for its
`pageId`, which lets a view mount it unconditionally in one line. Each of the four extra files
gains exactly one line plus an import. Extracting the gate rather than copying the banner four
times keeps the four views free of conflict logic, and a CRDT deletes all five call sites equally.

**Mutation-checked (M13):** deleting the `if (!conflict) return null;` early return from the gate
turns both `DocumentConflictGate` tests red — the "renders nothing so views can mount it
unconditionally" case and the "surfaces the resolve UI" case. That is the assertion holding the
whole arrangement up: without it, mounting the gate in four unrelated views would render a banner
on every page.

## The bug

`useDocument.ts`'s 409 handler refetched the server's copy and wrote it straight over
`documents.get(pageId).content`, cleared `isDirty`, cleared `useDirtyStore`, and logged the
user's lost text to `console.warn`. The toast said "your local copy has been updated", which
described a data loss as a sync. An existing test asserted that behaviour, so it was pinned.

## What changed

**New pure module — `apps/web/src/lib/documents/conflict-resolution.ts`.** No zustand, no
sonner, no fetch; `detectedAt` is injected rather than read from the clock. Three functions:

- `decideConflictOutcome({ conflictBody, remotePage, detectedAt })` → `conflict` or `error`. A
  conflict is only offered when we have both the server's content (to show) and a revision (so
  the retry can't 409 on the same collision). The revision falls back from the refetched page to
  `currentRevision` in the 409 body. If neither is available, or the refetch failed, it returns
  an error — and the local buffer is still left alone.
- `planConflictResolution(choice, { localContent, conflict })` → `keep-mine` gives
  `{ action: 'save-local', contentToSave, expectedRevision: remoteRevision }`; `use-theirs`
  gives `{ action: 'adopt-remote', contentToAdopt, revision }`.
- `canScheduleSave({ hasPendingConflict })` — the autosave predicate.

**Store — `useDocumentManagerStore`** gains `conflicts: Map<pageId, DocumentConflict>` with
`setConflict` / `clearConflict`. It is a separate slot: nothing about a conflict touches
`documents`. `clearDocument` and `clearAllDocuments` clear it too.

**Hook — `useDocument.ts`.** On 409 the handler now parses the 409 body, refetches the server
page, and hands both to `decideConflictOutcome`. `content`, `isDirty` and `useDirtyStore` are
never written on this path. It also cancels any debounce that was queued *before* the conflict
was detected — otherwise that one timer fires, 409s again, and loops.

`saveWithDebounce` consults `canScheduleSave` twice: at schedule time and again inside the
timeout, because a conflict can be detected during the 1000 ms window. `forceSave` consults it
and returns `false`. So neither typing nor Cmd-S can re-fire a PATCH while a conflict is parked.

`saveDocument` takes an optional `{ expectedRevision }` override, so the keep-mine retry can
compare-and-swap against the revision we observed instead of the stale stored one.

`resolveConflict(choice)` applies the plan: `use-theirs` adopts locally and sends no PATCH (the
server already holds that content); `keep-mine` clears the conflict first — so the save isn't
blocked by its own guard — and re-saves. **If a third party saved between detection and the
click, that retry 409s again and re-parks a fresh conflict with the newer remote content.** The
user's text is still not replaced, and they get a new, accurate choice rather than a generic
error. That path has its own test.

**UI — `DocumentConflictBanner.tsx`**, rendered by `DocumentView` above the editor whenever a
conflict is parked. Persistent: no timeout, no dismiss. It has "Keep mine" and "Use theirs", and
a "View their version" disclosure that renders the parked `remoteContent` read-only —
DOMPurify-sanitized for `html` mode, plain `<pre>` for `markdown`. The existing `useEditingStore`
registration at `DocumentView.tsx` is untouched.

## The page-history reassurance: it does NOT hold

The original brief asked me to tell the user the discarded version stays recoverable from page
history, after verifying it. The data-layer half is true and I confirmed it:
`applyPageMutation` calls `createPageVersion` unconditionally inside the mutation transaction
(`page-mutation-service.ts`), with the post-mutation content at the new revision, and there is
no early return that skips it on a successful mutation. So the other person's revision genuinely
is persisted.

The user-facing half is false, and the orchestrator independently confirmed it mid-task:
`apps/web/src/app/api/pages/[pageId]/history/route.ts` is GET-only, there is no restore endpoint,
no UI reads page history, and the rows expire after 30 days. A user cannot get that content back.

So the copy is not in the product. The banner says plainly that Keep mine replaces their version
and Use theirs discards your unsaved changes, and the "View their version" panel exists precisely
so the choice is informed instead of resting on a promise we can't keep. There is a test
asserting the banner contains neither "recoverable" nor "history".

## Mutation-check evidence

Every mutation below was applied to the source, the relevant suite was run, and the source was
restored. All ten went red. None touch `packages/*`, so the `dist` rebuild caveat does not apply
here — every mutated file is compiled from source by the web test run.

| # | Mutation | Test that went red |
|---|---|---|
| M1 | 409 handler overwrites the local buffer with remote content again (restores the original bug) | `should preserve the local buffer and park the server copy` + the re-409 test |
| M2 | `saveWithDebounce` stops consulting the guard | `given a pending conflict, saveWithDebounce should not fire a PATCH` |
| M3 | `forceSave` stops consulting the guard | `given a pending conflict, forceSave should not fire a PATCH` |
| M4 | keep-mine plans `expectedRevision: 0` instead of `remoteRevision` | pure `planConflictResolution` test + `keep-mine … against the remote revision` |
| M5 | use-theirs plans `save-local` instead of `adopt-remote` | pure test + `use-theirs … send no PATCH` |
| M6 | failed refetch parks a bogus conflict instead of erroring | `given the refetch failed, should return an error` |
| M7 | 409 no longer cancels the queued debounce | `should cancel the pending debounce so the autosave loop cannot re-fire` |
| M8 | keep-mine clears the conflict after the save regardless of a repeat 409 | `keep-mine that 409s again … re-park the fresh conflict` |
| M9 | banner renders remote content unsanitized | `given remote content carrying a script, should render it sanitized` |
| M10 | banner re-adds the false history reassurance | `should not promise the discarded version is recoverable` |

Note on M2/M3: `canScheduleSave` is a one-line predicate, and its own unit test (`!x`) is a
tautology that no mutation could meaningfully break. The risk it exists to cover is whether the
two call sites actually consult it, so that is where the mutation-check is aimed.

## Gates

- `bun run typecheck` (monorepo root) — 17/17 tasks successful.
- `bun run lint` — 15/15 tasks successful; the remaining warnings are pre-existing and in
  unrelated files.
- `bun run --filter web test -- src/lib/documents src/hooks/__tests__/useDocument.test.ts
  src/components/layout/middle-content/page-views/document` — 35 tests, 3 files, all passing.

Worktree setup done before gates meant anything: `bun install`, then `@pagespace/db` and
`@pagespace/lib` dist builds (`apps/web` imports lib from dist).

## Round 2 — review response (CodeRabbit + a 4-angle cleanup pass)

### Absent vs empty content — fixed at the root, both directions

CodeRabbit caught `remotePage.content ?? ''`: an ABSENT content field became an empty remote
document, so "Use theirs" would replace the user's text with nothing — data loss through the exact
door this PR closes. A sweep for the same question asked elsewhere found the mirror image in
`resolveConflict`: `state.documents.get(pageId)?.content ?? ''` would let "Keep mine" save an
EMPTY document over the other person's work if the local record were missing.

`?? ''` cannot express the distinction, and it was now being asked twice, so the fix is a single
narrowing primitive rather than two remembered guards:

```ts
export type ContentRead = { present: true; content: string } | { present: false };
export function readContent(content: string | null | undefined): ContentRead
```

`undefined` → absent, `null` → an empty document (unchanged, still offerable). The remote side
returns an `error` outcome; the local side refuses to resolve, leaves the conflict parked, and
says so. Mutation M11 (delete the `undefined` branch) turns all three levels red at once.

### The regression I introduced, and fixed

The altitude review found it and it is the most important item in this round. `useDocument` has
**five** production consumers — `DocumentView`, `CodePageView`, `CanvasPageView`,
`TaskListDescription`, `useSheetPersistence`/`SheetView` — and all five route writes through the
guarded `saveWithDebounce`/`forceSave`. But the banner was rendered only by `DocumentView`. On the
other four surfaces a 409 would park a conflict, pause autosave, and offer **no way to resolve
it** — saving silently dead for the rest of the session, with edits surviving in memory only until
reload. That is worse than the bug this PR fixes.

Fix: `DocumentConflictGate` — renders nothing until a conflict exists for its `pageId`, so a view
mounts it unconditionally in one line. All five views now do. `isResolvingConflict` moved into
`useDocument` so the gate is self-contained (previously local state in `DocumentView`).

### Other review findings applied

- `DOMPurify.sanitize` with default config replaced by the app's shared `sanitizeHtmlAllowlist`
  — the banner was the only `dangerouslySetInnerHTML` site in `apps/web` not using it, and the
  default profile keeps `style`/`form`/arbitrary attributes the allowlist strips. Caveat: the
  allowlist has no `img`, so images in the other version show as absent in the preview pane. An
  acceptable trade for one consistent sanitization policy.
- Hand-rolled disclosure replaced with the repo's Radix `Collapsible` (correct trigger/content
  ARIA association, which the hand-rolled `aria-expanded` lacked).
- Sanitization is now deferred until the disclosure is actually opened — it was running eagerly on
  the frame the 409 landed, mid-typing, for a pane most users never open.
- `contentMode` prop became `previewMode: 'rich' | 'plain'`, so code/canvas/sheet can show their
  JSON verbatim rather than through an HTML renderer.
- Dropped a dead `export type { DocumentConflict }` re-export from the store; made `resolveConflict`
  use one `state` handle consistently.

### Review findings deliberately NOT applied

- **Inline `canScheduleSave` / `planConflictResolution` away** (raised by three of four angles).
  Both are named in the task spec as required exports of the pure module. `canScheduleSave` is
  genuinely a tautology in isolation — which is why its mutation-checks are aimed at the two call
  sites, not at the predicate. Left as specified rather than quietly redesigning the brief.
- **Move `conflicts` onto `DocumentState`** so it resets with `upsertDocument`. Rejected on
  inspection: clearing a conflict on remount would silently resume autosave against the freshly
  fetched revision, overwriting the other person's text with no prompt — "Keep mine" by default.
  Keeping the conflict parked is the protective behaviour. (`clearDocument` clears both maps and
  has no production callers today; that is harmless defensive code.)
- **Park a conflict from the socket handler** (`DocumentView`'s `handleContentUpdate` drops remote
  changes while dirty). Correct that the machinery generalizes, but it is a behaviour change beyond
  the 409 write path this task scopes.
- **Route the conflict refetch through SWR** (CodeRabbit). Rejected and answered on the PR thread.
  `CLAUDE.md` requires editors to register with `useEditingStore` specifically to prevent SWR
  clobbering. Also the premise is factually wrong: `PagePaneView.tsx:66` keys on
  `encodeURIComponent(pageId)` while `WorkflowForm.tsx:68` keys on the raw id — different cache
  entries, so there is no single "shared key". And `PagePaneView` already holds a live
  `useSWR<TreePage>` on that key while rendering `DocumentView` beneath it, passing down only
  `id`/`driveId`; no content crosses today, which is exactly why nothing clobbers.

### Round 2 mutation checks

| # | Mutation | Test that went red |
|---|---|---|
| M11 | `readContent` conflates absent with empty (the bug, at its root) | primitive + remote-decision + local-guard tests, all three |
| M12 | local side falls back to `''` again | `given no local document record, should refuse to resolve` |
| M13 | gate renders the banner with no conflict parked | both `DocumentConflictGate` tests |
| M14 | banner renders remote content unsanitized | `should render it sanitized` |

### Round 2 gates

`bunx tsc --noEmit` in `apps/web` exits 0; `bun run typecheck` 17/17; `bun run lint` 15/15.
Tests across `src/lib/documents`, the hook, and all of `page-views`: **424 passed, 1 file failed** —
`useTaskSubTasks.integration.test.tsx`, which needs a migrated Postgres this worktree does not have
and prints its own opt-out instructions. Unrelated to this change.

Twice during this work `bun run typecheck` exited non-zero with a flood of TS6053 `.next/types not
found` and **no diagnostics**, then passed on an immediate rerun. It looks like `web#typecheck`
racing `web#build` in the same turbo graph. Worth knowing before someone bisects a phantom CI flake.

## Round 3 — the resolution-save race, and the Gate's shape

### The race (CodeRabbit, accepted — real)

`resolveConflict` used to call `clearConflict` **before** awaiting the retry PATCH, with the
comment "Clear first so the save is not blocked by its own conflict guard". Working around my own
safety mechanism was the tell. For the entire duration of that request `hasPendingConflict()` was
false, so the guards in `saveWithDebounce` and `forceSave` were open. A keystroke in that window
fired a second PATCH carrying the **stale** stored revision, which 409'd and parked a phantom
conflict — a conflict banner for a save that actually succeeded, intermittently. `isResolvingConflict`
does not close those guards; it is spinner state.

Fixed without dodging the guard:

- The conflict stays **parked** for the whole retry, so the autosave guards stay closed.
- `saveDocument` gained the guard itself — the deepest layer — with an explicit per-call
  `resolvingConflict: true` opt-in for the resolution path. An option on the call, not a mutation
  of shared state. This also covers the one direct caller outside the hook
  (`PageSetupButton.tsx:79`), which already handles a `false` return by telling the user to save
  first — so a content-mode conversion can no longer be attempted on top of an unresolved conflict.
- The conflict is cleared **only after the retry succeeds**. A repeat 409 leaves the fresher
  snapshot `saveDocument` just parked; any other failure leaves the banner up to retry. This also
  closes a flaw I had raised against myself in review (a failed keep-mine used to drop the conflict
  and let autosave resume against a stale revision).

### The Gate no longer opens a second `useDocument`

Verified both consequences the design note predicted, then removed the cause rather than patching it.

`changeGroupId` is real: `useDocumentSaving` mints `sessionId` per hook instance and sends it as
`changeGroupId`; `applyPageMutation` resolves it at `page-mutation-service.ts:100` and threads it
into **both** `createPageVersion` (`:241`) and `logActivityWithTx`. A Gate-owned instance would put
the resolution save in its own change group — splitting version and activity grouping at exactly
the moment a user resolved a conflict. `isResolvingConflict` would likewise have been two
independent booleans for one operation.

`DocumentConflictGate` now takes `conflict` / `onResolve` / `isResolving` as **props** from the
view's existing `useDocument` instance. There is one hook instance per page again, the change group
is the editing session's, and the "render nothing until a conflict exists" guarantee still lives in
one place. `useSheetPersistence` re-exports the three fields so `SheetView` can pass them through.
The reasoning is recorded in the component's own docblock so the second instance is not
reintroduced later.

### Round 3 mutation checks

| # | Mutation | Test that went red |
|---|---|---|
| M15 | restore the race — clear the conflict *before* the awaited retry | `given a resolution save in flight, should let neither typing nor forceSave issue a PATCH` (+ the failed-resolution test) |
| M16 | remove `saveDocument`'s parked-conflict guard | `a direct saveDocument without the resolution opt-in should not PATCH` |
| M17 | clear the conflict regardless of whether the retry succeeded | the repeat-409 re-park test + the failed-resolution test |
| M13′ | delete the Gate's `if (!conflict) return null` (re-run after the props rewrite) | `should render nothing so views can mount it unconditionally` |

### Round 3 gates

`bunx tsc --noEmit` exits 0; `bun run lint` 15/15; `src/lib/documents` + the hook + all of
`page-views`: **428 passed, 6 skipped**, one file failing (`useTaskSubTasks.integration.test.tsx`,
needs a Postgres this worktree lacks and prints its own opt-out).

### Note on review signal

Two of the CodeRabbit findings on this PR were real defects (absent-content coercion, and this
race), one was a correct factual catch (the changelog claim), and one was rejected on verified
grounds (SWR). Worth weighting accordingly rather than treating the bot as noise.

## Round 4 — two consequences of the round-3 fix

Both accepted; both are follow-on effects of closing the guard properly, which is normal for a
change of this shape.

### A. Edits made during the retry were stranded

With the guard correctly closed for the whole retry, `saveWithDebounce` returns early **without
creating a timeout**. So text typed while the retry was in flight became dirty with nothing
scheduled for it, and clearing the conflict on success scheduled nothing either — it sat unsaved
until the next keystroke, blur or manual save.

After a successful retry, if the document is still dirty, `resolveConflict` now schedules a save
for the current content (`saveWithDebounce` added to its deps). Note the document IS still dirty in
exactly this case: `saveDocument` only calls `markAsSaved` when the saved content still matches the
buffer, which a mid-retry edit makes false.

### B. Two views on one page could both resolve

Round 3 moved the Gate to props but left `isResolvingConflict` as per-instance `useState` — so I
had only half-addressed the earlier design note. With the centre panel and an agent pane
(`PagePaneView`) both showing a page — a combination we know occurs — each held its own boolean:
one banner's buttons disabled, the other's live. Two clicks meant two PATCHes with the same
`expectedRevision`; the server takes one and 409s the other, parking a spurious conflict on the
conflict that was just resolved.

Fixed at the root, with no new lock abstraction: `resolvingConflicts: Set<pageId>` on
`useDocumentManagerStore`. One flag per page, shared by every mount. `resolveConflict` returns
early if a resolution is already in flight (the actual serialization), and every Gate's buttons
disable together (the UI consequence). Cleared in `clearDocument`/`clearAllDocuments` alongside
`conflicts`.

### A flaky test I wrote and then removed

My first version of the round-4 reschedule test asserted the second PATCH actually fired, which
depended on the real 1000 ms debounce landing inside a `waitFor` window — it passed, then failed 3
runs in a row, then passed. Two separate causes: a `waitFor` timeout equal to vitest's default 5 s
test timeout (so the test died before `waitFor` could report), and genuine timing sensitivity after
that was raised.

It now asserts the **scheduling** instead — after resolution the document is still dirty AND
`saveTimeout` is defined — which is precisely what Thread A said was missing ("nothing ever
schedules it") and carries no timing dependence. Verified stable across 5 consecutive runs. The
existing debounce tests already cover that a scheduled timeout produces a PATCH.

### Round 4 mutation checks

| # | Mutation | Test that went red |
|---|---|---|
| M18 | drop the reschedule of edits made during the retry | `given an edit made while the retry is in flight, should schedule it once the conflict clears` |
| M19 | drop the serialization guard so both banners can resolve | `given two views on the same page, should let only one resolution PATCH go out` |
| M20 | make the resolving flag per-instance again (invisible to other views) | same two-views test |

### Round 4 gates

`bunx tsc --noEmit` exits 0; `bun run lint` 15/15; `src/lib/documents` + the hook + all of
`page-views`: **430 passed, 6 skipped**, with the same single Postgres-dependent integration file
failing for want of a database.

## Deliberately not done

- **No Yjs, CRDT, or collab code.** `RichEditor.tsx`'s extension list is untouched. Phases B+.
- **No server changes.** The 409 response already returns `currentRevision` / `expectedRevision`
  and is correct as-is.
- **No page-history UI or restore endpoint.** Out of scope, and explicitly ruled out by the
  orchestrator. It is the obvious follow-on to the finding above, but it is not this PR's call.
- **No three-way merge.** Keep mine / Use theirs is a whole-document choice. Character-level
  merge is the point of the CRDT phases; building a bespoke merge here would be work thrown away.
- **No conflict handling for the remote-update path** (`DocumentView.tsx`'s socket handler drops
  remote changes while you are dirty). That is a real adjacent gap, but it is a different
  code path from the 409 write path this task scopes, and silently widening scope into it would
  make the diff harder to review. Flagging it, not fixing it.
- **No coverage-threshold glob** added for `src/lib/documents/*.ts`. The house pattern gates new
  pure modules at 100% branch; I did not add the entry because I could not verify the exact
  figure under the full `turbo run test:coverage` invocation without a whole-suite run, and a
  wrong entry breaks CI for everyone. Cheap to add later with that number in hand.

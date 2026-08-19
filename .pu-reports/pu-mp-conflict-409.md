# PR 1 — Stop discarding local edits on 409

Board: Multiplayer Documents (Yjs CRDT), Phase A, task `jc5su9gmeohiyo3ulzu7o143`.
Client-side only. No server code touched; the 409 contract in
`apps/web/src/app/api/pages/[pageId]/route.ts` is unchanged.

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

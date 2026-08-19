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

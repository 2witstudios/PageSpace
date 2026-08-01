# Review: pu/header-for-agents-page (PR #2300)

Self-review of `AgentsListHeader`, `useSpawnSession`, `DrivePickerDialog` (new)
and `AgentsSurface.tsx`/`AgentsSidebar.tsx` (modified). No PageSpace board is
connected to this repo's own task tracking (the global `pagespace` credential
present in this environment belongs to an unrelated project), so findings are
recorded here per the review skill's fallback.

## Findings

- [x] BLOCKER · `AgentsListHeader.tsx` · "New Session" rendered unconditionally for every user, but session spawning is admin-only everywhere else in the console (`AgentsSidebar`'s `canSpawn = isAdmin && !authLoading` hides its entire spawn UI; `GET /api/agent-sessions` 403s non-admins). A non-admin viewing the Agents page would see and could click a button the rest of the app deliberately hides from them. · What correct looks like: gate the button behind the same `isAdmin` check the sidebar uses. — fixed in b2f69cee6
- [x] MAJOR · `AgentsListHeader.tsx` · "New Agent" on the global (driveless) page called `router.push()` then `openQuickCreate(null)` in the same synchronous tick. `QuickCreatePalette` resolves its own `driveId` from `useParams()`, which only updates once the client-side navigation actually lands — a fast user (or slow route transition) could hit "Create" while `driveId` was still `undefined`, silently no-opping with no error shown. · What correct looks like: wait for the component's own `driveId` prop (sourced from the same route) to match the picked drive before opening Quick Create. — fixed in b2f69cee6
- [x] MINOR · `apps/web/src/components/agents/` · The three new files (`AgentsListHeader.tsx`, `DrivePickerDialog.tsx`, `useSpawnSession.tsx`) shipped with zero dedicated tests, in a codebase with strong existing coverage for this exact console (`AgentsSidebar.test.tsx` alone has 57 tests). · What correct looks like: a test file covering the header's own branching (admin gate, drive-scoped vs global CTA behavior, drive-picker flow). — fixed in b2f69cee6 (`AgentsListHeader.test.tsx`, 7 tests)

## Not flagged (considered and dismissed)

- OWASP Top 10: not applicable — no new API routes, no new data storage, no new auth/crypto logic; every mutating action (`POST /api/drives`, `POST /api/agent-sessions`, `POST /api/pages`) already existed and is reused via its existing client caller.
- `useSpawnSession` returning a JSX element from a hook (`paletteElement`) is an unconventional but established, intentional pattern here (headless-dialog-via-hook), matching the minimal-diff extraction goal; not worth a bigger refactor for this PR's scope.
- No loading-state guard on `DrivePickerDialog`'s drive list — matches the existing codebase convention (`AgentsPastConversationsList.tsx` reads `useDriveStore().drives` the same unguarded way); not a regression introduced by this PR.

## Verdict

0 blockers / 0 majors / 0 minors open ; 3 fixed (of 3 found)

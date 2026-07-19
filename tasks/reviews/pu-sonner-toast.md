# Review: pu/sonner-toast (PR #2114)

fix(toast): replace console.log useToast stub with sonner

## Scope

18 files: deletes `apps/web/src/hooks/useToast.ts` (console.log-only stub since
2025-12-22), migrates its 14 real consumers to `sonner`'s `toast.success`/`toast.error`,
updates 2 tests that mocked the stub. From 2026-07-17 solo-tells audit cheap-fix #2.

## Churn

Touched files have moderate, unremarkable history (last non-trivial change on
DriveMembers.tsx/RoleEditor.tsx was #1641, drive-wide permissions — 2+ releases ago).
No hotspot/fragile-file risk.

## Findings

- [x] MINOR · PR description · CodeRabbit's automated "Linked Issues" / "Out of Scope"
  pre-merge warnings are false positives — they mis-parsed "cheap-fix #2" (an audit
  fix-list item number) as a reference to GitHub issue #2 ("Upload files", already
  merged, unrelated). `closingIssuesReferences` on the PR is empty; no real linkage
  exists. — fixed in PR description edit (see below).
- [x] NIT · CodeRabbit's "Docstring Coverage 10%" pre-merge warning is not actionable —
  conflicts with this repo's explicit CLAUDE.md convention ("Default to writing no
  comments... only add one when the WHY is non-obvious"). None of the touched code has
  non-obvious WHY requiring a docstring; toast call sites are self-explanatory. No
  change needed.

No correctness, security, or test-coverage defects found:
- All 34 `toast({title, description, variant})` → `toast.success/error(description)`
  conversions verified against the original diff: message text, dynamic
  `error instanceof Error ? error.message : fallback` logic, and `result.message ||
  fallback` logic all preserved verbatim.
- `useCallback` dependency arrays correctly drop `toast` (now a stable top-level
  import, not a per-render hook value) in `DriveMembers.tsx`, `DriveAISettings.tsx`,
  `VersionHistoryPanel.tsx`, `SidebarActivityTab.tsx` — no stale-closure risk
  introduced, no missing-dep lint warnings.
- OWASP: no new attack surface. sonner renders toast content as text (no
  `dangerouslySetInnerHTML`), same as the deleted stub. Dynamic message content
  (`role.name`, `error.message`) was already flowing into user-facing toast text
  pre-migration from the same sources — this PR doesn't change what data reaches the
  DOM or how it's rendered, only which library renders it.
- Dead code: `useToast.ts` fully deleted; confirmed zero remaining `useToast(` call
  sites or `hooks/useToast` imports repo-wide (the only other `useToast*` hits are the
  unrelated `useToastPreferences` hook).
- Test coverage: 2 of 14 consumers had pre-existing test coverage
  (`DriveMembers.test.tsx`, `invite/page.test.tsx`) — both updated correctly to mock
  `sonner` and assert on the new single-string call signature, matching the
  `vi.mock('sonner', ...)` pattern already established in
  `settings/account/__tests__/page.test.tsx`. The other 12 consumers have no test
  coverage, but that's a pre-existing gap this refactor doesn't need to close (no new
  logic introduced — behavior-preserving migration only).

## Verdict

0 blockers / 0 majors / 2 minor-or-nit (both non-actionable / already addressed) —
merge-ready pending green CI.

# Review: pu/escape-like-centralize (PR #2178)

Reviewer: Claude (aidd-review skill, self-review pass during ralph-loop convergence)
Date: 2026-07-20
Scope reviewed: `git diff master...pu/escape-like-centralize`

## Summary

Pure mechanical consolidation of 4 duplicate `escapeLikePattern` implementations
(tasks, search, mentions/search, pages/[pageId]/tasks/query-spec) plus one inline
duplicate (admin audit-logs) into a single exported+tested helper at
`packages/lib/src/db/like-pattern.ts`. Diff reviewed line-by-line against every
touched call site; all 5 sites correctly import the shared helper, the local
definitions are fully deleted, and the `ESCAPE '\\'` raw-SQL clause in
`apps/web/src/app/api/tasks/route.ts` is preserved unchanged. Tests pass:
packages/lib (378 files / 8616 tests), apps/web (998 files / 14977 tests, 3
pre-existing unrelated failures — DB-role integration tests needing a live
Postgres container, plus one unrelated midnight-boundary date test), apps/admin
audit-logs suite (7/7). Repo-wide typecheck and eslint clean. No hotspot files
touched (aidd-churn: none of the 7 touched files appear in the top-20 list).

**Verdict for PR #2178 as scoped: 0 blockers / 0 majors / 0 minors / 0 nits.**
Ready to merge on its own defined scope.

## Findings

### Out-of-scope (NOT fixed in this PR — filed here for follow-up)

While digging for "any missed duplicate copies of this pattern elsewhere in the
repo" (per review instructions), found 5 **additional** call sites that build an
ILIKE/`ilike()` pattern from raw, **unescaped** user-supplied search input — the
same defect class this PR consolidates a fix for, but these sites never had any
escaping to begin with (not duplicates of `escapeLikePattern`, so they weren't in
the original task's confirmed-call-site list, and expanding this PR's scope to
touch 5 more files would violate the explicit "do not touch anything else"
scope constraint given for this PR). Severity is LOW: all interpolations go
through Drizzle's parameterized `sql` tag / `ilike()` helper, so there is **no
SQL injection** — the only effect of an unescaped `%`/`_` in the search term is
over-broad matching within data the caller is already authorized to query (a
precision/correctness issue, not an access-control bypass).

- [ ] MINOR · `apps/web/src/app/api/search/multi-drive/route.ts:109,112` · `searchPattern = \`%${searchQuery}%\`` built from raw `searchQuery` with no escaping before the ILIKE branch (the sibling regex branch at line 108 IS escaped) · should call `escapeLikePattern(searchQuery)` before wrapping in `%...%`
- [ ] MINOR · `apps/web/src/app/api/users/search/route.ts:55` · `searchPattern = \`%${query}%\`` built from raw `query` with no escaping, used in `ilike(userProfiles.username/displayName, searchPattern)` · should escape `query` first
- [ ] MINOR · `apps/web/src/lib/ai/tools/search-tools.ts:544` · same unescaped pattern as multi-drive/route.ts (likely a copy of it — AI tool variant of the same search) · should escape `searchQuery` first
- [ ] MINOR · `apps/admin/src/app/api/admin/audit-logs/export/route.ts:139-142` · `ILIKE ${'%' + search + '%'}` built from raw `search` with no escaping — the export variant of the audit-logs route fixed in this PR · should escape `search` first (note: this route already imports `@pagespace/lib` subpaths, so `@pagespace/lib/db/like-pattern` is trivially importable)
- [ ] MINOR · `apps/admin/src/app/api/admin/contact/route.ts:34-37` · `ilike(contactSubmissions.*, \`%${searchTerm}%\`)` built from raw `searchTerm` with no escaping · should escape `searchTerm` first

**Recommendation:** file a fast-follow task (same shape as `an995k8yse0phctrvwfqipse`)
to sweep these 5 sites using the now-available `@pagespace/lib/db/like-pattern`
helper. Not a blocker for PR #2178.

### Checked and clear (no finding)

- OWASP Top 10 pass over the diff: no injection risk introduced (all query
  values remain parameterized through Drizzle), no auth/authz logic touched,
  no secrets, no new external inputs, no XSS surface (server-side DB query
  helper only).
- `apps/admin/src/app/api/admin/users/list-params.ts`'s ILIKE-adjacent comment
  is a red herring — that route deliberately searches in Node, not SQL,
  because `users.name`/`users.email` are AES-256-GCM ciphertext at rest; not
  related to this pattern.
- No stray/orphaned files, no dead code, no leftover `TODO`/`FIXME` from this
  change.
- Test quality: the two new minimal regression tests (`search/route.test.ts`,
  addition to `mentions/search/__tests__/route.test.ts`) use `vi.spyOn` on the
  real (unmocked) `@pagespace/db/operators` module to observe the actual
  `ilike()` call arguments rather than asserting against a mock's stub return —
  this exercises the real escaping code path end-to-end through the route
  handler, not just the unit in isolation. Confirmed correct escaped-pattern
  assertions (`'%50\\%%'`, `'%off%'`) match `escapeLikePattern`'s actual output.
- Mock-heavy test style in the two new test files matches 100% of existing
  precedent in the same directories (`db.select` chain mocking is the
  established pattern throughout apps/web's route tests); not a new smell.

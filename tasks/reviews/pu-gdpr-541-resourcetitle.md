# Review: PR #1883 — fix(gdpr): scrub resourceTitle PII in account-erasure anonymization (#541)

Branch: `pu/gdpr-541-resourcetitle` · Base: `master`
Reviewer: Claude (self-review via `/aidd-review`, no human/bot reviewer feedback available — Codex and
CodeRabbit both hit account rate limits on this PR at the time of review)

## Scope

- `packages/lib/src/repositories/activity-log-repository.ts` — `anonymizeForUser` now also nulls
  `resourceTitle`.
- `packages/lib/src/repositories/__tests__/activity-log-repository.test.ts` — updated assertion.
- `packages/lib/src/monitoring/__tests__/anonymize-resource-title.test.ts` (new) — real
  `logActivity` + real `anonymizeForUser` round-trip against a fake in-memory table; confirms
  `resourceTitle` is nulled and the hash chain still validates.
- `apps/processor/src/workers/__tests__/account-erasure-worker.test.ts` (new) — worker-level test
  confirming `log-account-deletion` runs before `anonymize-activity-logs` against the same userId.

## Checks performed

- `npx aidd churn --json`: none of the touched files appear in the top-20 hotspot list (all are small,
  low-churn) — no elevated risk from file size/complexity/churn.
- OWASP Top 10 pass: no injection (Drizzle ORM `.set`/`.where(eq(...))`, no raw SQL), no access-control
  change, no crypto weakening (hash-chain fields unaffected — verified by test), no logging/monitoring
  regression (this *is* the audit-log system, and the fix strictly removes PII while behavior is
  otherwise preserved).
- `bunx eslint` on all four touched files: clean (test files are excluded from lint by
  `packages/lib`'s eslint config, by existing project convention — not specific to this PR).
- `bunx tsc --noEmit` in both `packages/lib` and `apps/processor`: clean.
- `bunx vitest run` in both packages: full suites green (packages/lib: 281 files / 6280+ tests;
  apps/processor: new test passes; 2 pre-existing unrelated failures in `content-detector`/
  `processing-pipeline` tests due to a magika ML-model-loading issue in this environment, confirmed
  untouched by this diff).
- Manually confirmed (via `git stash` of the fix) that the new `anonymize-resource-title.test.ts` test
  fails without the fix and passes with it — a real regression test, not a tautology.
- Confirmed no stray files, no dead code, no `any` types, no TODO/FIXME added.

## Findings

- [x] MINOR · `packages/lib/src/repositories/__tests__/activity-log-repository.test.ts:12-18` · the
  mocked `activityLogs` schema stub had an unused `resourceTitle: 'resourceTitle'` entry — the real
  code sets `resourceTitle: null` as a literal object property in `.set({...})`, it never dereferences
  `activityLogs.resourceTitle` as a column reference (only `activityLogs.userId` is referenced, in the
  `.where(eq(...))` clause) · what correct looks like: schema stub only includes keys actually
  referenced by the code under test — fixed in 14e8700b2 (verified: removing it left all 5 tests green).
- [x] NIT · `apps/processor/src/workers/__tests__/account-erasure-worker.test.ts` docblock · framed
  "every collaborator is mocked" as matching "this repo's convention," which overstated it as a
  stylistic choice rather than a discovered hard constraint (Vitest's mock registry cannot intercept
  `@pagespace/db/db` through `@pagespace/lib`'s compiled dist output when imported cross-package —
  confirmed empirically: attempting a partial mock there hit a live Postgres connection) · what correct
  looks like: comment states the actual technical reason so a future reader doesn't waste time
  re-attempting the cross-package partial-mock approach — fixed in 14e8700b2.

## Verdict

0 blockers / 0 majors / 2 minor-or-nit findings, both fixed in commit 14e8700b2. No unresolved review
threads exist on the PR (Codex and CodeRabbit both hit rate limits and posted no substantive findings).
Mergeability: MERGEABLE / CLEAN. All CI checks green as of this review. Recommend merge once a human
or bot reviewer has had a chance to look, per the `/loop`'s own convergence-sweep policy.

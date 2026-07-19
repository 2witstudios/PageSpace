# Review: pu/bounded-query-primitive (PR #2127)

feat(db): bounded-query primitive — Phase 1 of task board crash-prevention epic

## Scope

4 files: new `packages/lib/src/db/bounded-query.ts` (pure, no I/O) + its test
`packages/lib/src/db/__tests__/bounded-query.test.ts`; `packages/lib/package.json`
(new `./db/bounded-query` exports entry); `apps/web/src/lib/utils/query-params.ts`
reduced to a re-export of the relocated `parseBoundedIntParam`. Phase 1 of 8 for
the "Task Board Query & Reorder Safety" epic (PageSpace page `j44e35jwzlhr54fbmruk3k4i`),
triggered by the 2026-07-18 Postgres OOM crash (unbounded `taskItems.findMany`,
5 joined relations, no limit).

## Churn

New file, no prior history. `query-params.ts` had no dedicated test file before
this change (confirmed via search) — no coverage regression from reducing it to
a re-export.

## Design validation

Confirmed via grep across all ~15 existing `parseBoundedIntParam` call sites that
keeping the original flexible `{ defaultValue, min?, max? }` signature (rather than
hardcoding `min: 1`) is necessary, not redundant: e.g.
`apps/web/src/app/api/ai/page-agents/[agentId]/conversations/route.ts` uses
`min: 0` for a 0-indexed `page` param. `resolveBoundedLimit` layers a
stricter, harder-to-misuse policy (`min` defaults to `1`) on top for the
new bounded-list-query use case, rather than replacing the generic parser.

## Findings

No correctness, security, or test-coverage defects found:
- OWASP: no new attack surface — pure arithmetic clamping, no I/O, no user input
  reaches a sink directly (callers still own their own `db.query` calls).
- Dead code: none. Relocated `ParseBoundedIntParamOptions`/`parseBoundedIntParam`
  confirmed to have zero remaining references at the old definition site; only
  the function (not the type) was ever imported by consumers, so no call site
  needed updating beyond the re-export.
- Test coverage: 100% line/branch/function on the new module (`vitest --coverage`),
  15 tests covering every branch of both `parseBoundedIntParam` (min/max present
  vs. defaulted, null/empty/non-numeric rawValue, in-range passthrough) and
  `resolveBoundedLimit` (omitted limit, clamp-to-max, clamp-to-1 for 0/negative/
  non-numeric, in-range passthrough, explicit `min` override). Full
  `packages/lib` suite (367 files / 8497 tests) green; global coverage
  95.05/95/88.62/95.05, above the 85/94/88/85 gate.
- Lint: clean on both touched source files (`eslint` in `packages/lib` and
  `apps/web`).
- Typecheck: root `bun run typecheck` (turbo, full graph) — 16/16 tasks green.
- No TODO/FIXME or stub logic left in scope.

## Verdict

0 blockers / 0 majors / 0 minor / 0 nit — merge-ready pending final green CI.

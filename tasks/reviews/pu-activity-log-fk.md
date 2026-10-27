# Code Review — `pu/activity-log-fk` (PR #2240)

Reviewed 2026-07-27 against `master` (branch 0 commits behind, zero conflicts). 2 commits;
~20 added / 12 removed lines of non-test source across 3 files, plus 4 test files. No schema,
migration, or dependency changes.

Scope: two stacked defects that silently dropped the audit trail for every Global Assistant message
edit/delete — (1) the global route wrote a `conversations` id into `activity_logs.pageId`, guaranteeing
an FK violation; (2) `logActivity`'s FK-retry fallback read pg fields off the top level of a Drizzle
wrapper error, so it never fired in production.

Gates run locally, all green:
- `bun run typecheck` ✅ 16/16 · `bun run lint` ✅ 14/14 · `bun x knip` ✅ (no new findings)
- `bun run test:unit` (with test DB, `TZ=UTC`) — lib **9230 pass / 0 fail**, web **15704 pass / 0 fail**, exit 0
- Post-review addition: `activity-logger-fk-retry.integration.test.ts` provokes a real 23503 against
  real Postgres so the retry is proven end to end rather than against a hand-built error. Verified as a
  true regression test — restoring the old guard drops the audit row (`expected undefined to be defined`).
- `activity-log-errors.ts` at **100% branch coverage** (v8)
- CI: all checks green on the head commit

Churn cross-reference (`npx aidd churn`): none of the touched files are hotspots. The adjacent
`apps/web/src/app/api/ai/global/[id]/messages/route.ts` ranks #2 repo-wide but is a *different* file,
owned by PR #2241 — no overlap with this diff.

## Verified clean (no finding)

- **A01 Broken Access Control** — the new `pageId: null` + `driveId: null` rows land in the existing
  user-level branch of `api/activities/[activityId]/route.ts:64-86` (`activity.userId !== userId` → 403).
  Owner-accessible, everyone else denied; fail-closed. `integrations/providers/install/route.ts:57`
  already emits this exact shape, so it is an established representation, not a new one.
- **A08 Data Integrity** — hash chain, advisory lock and `prepareActivityInsert` untouched. `chainSeq`
  is `bigserial`, so failed inserts permanently burned sequence values; `hash-chain-verifier.ts` uses
  `chainSeq` only for `orderBy`, never for contiguity, so the gaps are cosmetic and this fix reduces them.
- **A09 Logging/Monitoring Failures** — this is the defect class being fixed; strict improvement.
- A02/A03/A04/A05/A06/A07/A10 — no crypto, SQL-string, dependency, auth or outbound-request surface touched.
- **Newly-live path** — the retry branch was dead in production until this fix. Verified re-entrant:
  `insertActivityLog` rebuilds `values` per attempt inside its own transaction, so the failed first
  attempt rolls back fully and the retry chains off the last committed row.
- **Downstream consumers** — `pickConversationTable` keys off `conversationType === 'global'` before
  `hasPageId`; `planMessageRollback` never reads `pageId`; `broadcastActivityEvent` derives channels
  from truthy `driveId`/`pageId` so a user-level row is a graceful no-op, not an error.
- **Scope correctness** — `pageId: agentId` in the page-agents route is correct (agents *are* pages;
  validated via `canPrincipalEditPage(auth, agentId)`). The global route was genuinely the only offender.
- No stray files, no dead code, no TODO/FIXME markers, tests colocated.

## Findings

- [ ] **nit** · `packages/lib/src/monitoring/activity-log-errors.ts:9-20` · Module constants use
  ALL_CAPS (`FK_VIOLATION_CODE`, `PAGE_ID_CONSTRAINT`, `MAX_CAUSE_DEPTH`), which /aidd-javascript
  NamingConstraints explicitly discourages · Correct per the skill would be camelCase; correct per the
  consuming module is ALL_CAPS (`ACTIVITY_CHAIN_LOCK_KEY` in `activity-logger.ts`). Recommend keeping
  for local consistency and settling this repo-wide rather than in this PR.
- [ ] **nit** · `packages/lib/src/monitoring/__tests__/activity-log-errors.test.ts` · Uses vitest
  `it`/`expect` rather than the Riteway `assert({ given, should, actual, expected })` form /aidd-tdd
  mandates · The sibling `activity-logger.test.ts` is 100% `it`/`expect`, and PR #781 is consolidating
  riteway helpers repo-wide. Recommend deferring to that migration rather than mixing two styles in one
  directory. (The `page-mutation-plan.test.ts` addition *does* use `assert`, matching its file.)
- [ ] **nit** · `packages/lib/src/monitoring/activity-log-errors.ts:52-63` · Manual `for` loop where
  /aidd-javascript favors composition · A bounded linked-list walk with early exit; the functional
  alternative (recursion with a default `depth` parameter) leaks an implementation parameter into the
  public signature. Recommend keeping the loop.
- [ ] **info** · `packages/lib/src/monitoring/activity-log-errors.ts:52` · The extracted predicate drops
  the `error instanceof Error` precondition the old inline guard carried · Strictly widening: a non-Error
  object bearing `code`/`constraint` now matches. Worst case is one benign retry without `pageId`; the
  behaviour is pinned by an explicit test. No change recommended.
- [ ] **info** · `packages/lib/src/monitoring/activity-logger.ts:~601` · `logActivityWithTx` has no FK
  retry at all, so the page-deleted-mid-log race remains unhandled on the transactional path · Correct
  would be the same predicate applied there, but it needs different handling (a failed insert aborts the
  caller's transaction, so it cannot simply be retried in place). Out of scope; flagged in the PR body.

**Verdict:** 0 blockers / 0 majors / 3 nits / 2 informational; 0 requiring change before merge.
The diff is minimal, root-cause-correct at both layers, and verified end-to-end through the
authorization, rollback, and realtime consumers. Merge-ready.

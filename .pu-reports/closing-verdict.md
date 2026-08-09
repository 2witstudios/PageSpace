# Closing verdict — the node-tree cutover at `602cbc395`

**Auditor only.** Nothing implemented, nothing fixed, nothing merged, no PR opened, no board task
touched. Working tree was clean before this file and is clean after it.

**Audited:** `pu/closing-verdict` @ `602cbc395` (`merge(backfill): dismissed threads stay dismissed,
and the script runs again`), which is `pu/workspace-node-model`'s content. Merge-base with `master`
is `968e7be76`; `master` is at `f97118a78`. The diff is **238 files, +73,537 / −18,265**.

**Method.** Every claim below was produced by running something. Runtime probes were written into
`.pu-probe/`, run, and deleted. Two throwaway databases (`pagespace_cv`, `pagespace_cv2`) were
created on the shared test container, migrated to **0255 only**, seeded, and dropped afterwards; no
other agent's database was touched. Mutations were applied to the shipped source, the suite re-run,
and the file restored byte-for-byte.

---

# 1. THE RE-TEST TABLE — every open finding from all five audits

## `pu-rev-phase1.md` — Phase 1 + 2 review of record (12 findings)

| # | Claim | Today | Evidence |
|---|---|---|---|
| 1 | **HIGH** `applyNodeWrite` prescribes drop-then-put; the self-FK cascade eats a reparented subtree | **FIXED** | `workspace-node-algebra.ts:160` is now `removeNodes(upsertNodes(nodes, put), drop)` — put, then drop — with the cascade argued at `:140-156`. The persisted side deletes first and rescues the survivors (`workspace-node-write.ts:142-161`), which `workspace-node-write.test.ts`'s THE CASCADE pins |
| 2 | **HIGH** `create` accepts an empty `nodeId` and a blank `targetId`; both persist and make the workspace unreadable | **FIXED** | Probed: `create({nodeId:''})` → `invalid_id`; `create({target:{chat,''}})` and `'   '` → `invalid_target`; `validateTree` answers `blank_id` for both an empty node id and an empty target id. **M25's uncovered split path is covered**: `open(blank chat id)` through `splitInto` → `invalid_target` |
| 3 | **MED-HIGH** `validateTree` skips fraction finiteness on the parked group | **FIXED / no longer applicable** | The parked group is gone, and the finiteness sweep was hoisted out of the group loop entirely (`workspace-node-validate.ts:424-432`), ahead of the sum, with the NaN-comparison argument in the comment |
| 4 | **MED** one-conversation-one-node lives only in the DB; the guard cannot see across workspaces | **FIXED (within-set); cross-workspace half closed at the write path** | `validateTree` now has `duplicate_chat_target` (`:525-536`, probed). The global half is a pre-flight + a by-**constraint-name** backstop in `workspace-node-runtime.ts:440-460`, `:511-516`, answered as 409 + rebase body — `sanity-verdict-1.md` finding 2, closed |
| 5 | **MED** `validateTree` is O(n²) — **217 ms** at `MAX_NODES` on the serializing write path | **MEASURED at 45.1 ms** | Probed: 2048 flat nodes → `{ok:true}` in **45.1 ms**. Still super-linear; no longer the number the finding was written about. Not blocking |
| 6 | **MED** the "byte-identical round trip" the modules promise is false — key order differs | **RESOLVED AS DOCUMENTED** | Key order still differs (probed: `…target,fraction` vs `…fraction,target`; `JSON.stringify` equal = **false**, deep-equal = **true**). But the claim was **weakened to deep equality** (`workspace-node.ts:105-109`: *"Key ORDER is not part of that agreement"*), and the change test is `sameNode` (`workspace-node-write.ts:94-106`), not `JSON.stringify`. The predicted failure cannot occur |
| 7 | **LOW-MED** at exactly `MAX_NODES`, an eviction that nets zero growth is refused | **STILL LIVE** | Probed on a 2048-node workspace: evict path → `max_nodes_exceeded: 2049 nodes; the cap is 2048`; split path → `2050` |
| 8 | **LOW** `openConversation` refuses a parked target; `replaceConversation` un-parks one | **NO LONGER APPLICABLE** | There is no parked state |
| 9 | **LOW** a detached pane keeps a stale `fraction` | **NO LONGER APPLICABLE** | Same |
| 10 | **LOW** the composite self-FK's name is truncated by Postgres | **STILL LIVE, documented** | Live DB: `agent_workspace_nodes_rootId_parentId_agent_workspace_nodes_roo`. The schema now names the truncation and the consequence at `agent-workspace-nodes.ts:203-206` rather than pinning `.name()` |
| 11 | **LOW** `put` carries no ordering guarantee; a row-at-a-time writer would violate the FK | **FIXED** | `NodeWrite`'s docblock now states it in as many words (`workspace-node-algebra.ts:80-86`) |
| 12 | **LOW** `validateTree` spends the cast `descendantsOf` refuses to | **FIXED** | `workspace-node-validate.ts:362` uses the `shift()`-until-`undefined` idiom |

## `final-verdict.md` — DO NOT SHIP, 10 findings

| # | Claim | Today | Evidence |
|---|---|---|---|
| 1 | **BLOCKER** branch does not typecheck or lint (3 × TS2339) | **FIXED** | `bun run typecheck` **exit 0, 17/17**; `bunx tsc --noEmit` run directly in `apps/web` against a completed build: **exit 0, zero errors**; `bun run lint` **15/15** |
| 2 | **HIGH** the unhandled `conflict` commits the ghost and reports success | **FIXED** | The chat-index conflict now **throws** `NodeWriteConflicted` inside the transaction (`workspace-node-runtime.ts:455`, with the postmortem in the comment) and is re-formed **outside** the rollback (`:484-486`); `admitConversationNode` handles `conflict` explicitly (`agent-workspaces-runtime.ts:307`). The four tests that encoded the right answer run green against a live database (`agent-workspaces-runtime.integration.test.ts`, 19 tests) |
| 3 | **HIGH** `listSessionConversationsBulk` throws `id is ambiguous` on every call | **FIXED** | Both columns explicitly aliased (`agent-workspaces-runtime.ts:929-930`); `session-discovery-symmetry.integration.test.ts` green against a real DB |
| 4 | **MED** four stale test files, 9 web failures | **FIXED** | `web test -- src/lib/agent-workspaces` → **200 passed / 17 files**, including all six integration files |
| 5 | **MED** the backfill puts dismissed and history-deleted threads back **on screen** | **FIXED — verified against a real pre-0256 database** | Seeded `ws02` (live pane → dismissed thread) and `ws03` (live pane → history-deleted thread). After `--apply`, neither thread has a node and neither pane was materialised; the census reports `panes 2→1 (1 not a member)` for each. **Mutation-checked**: neutering `partitionPanesByMembership` turns **13 named tests red** |
| 6 | **MED** a SKIPPED workspace is invisible and its threads re-claimable | **MOSTLY FIXED** | (a) The false "left on the old tables, which still work" docblock is corrected (`workspace-node-backfill.ts:70-77`). (b) There is now a **zero-skip exit gate**: measured **exit 1** with one `blank_id` workspace, **exit 0** after repair; mutation-checked (dropping `skipped === 0` from `runIsClean` turns *FAILS THE RUN* red). (c) The legacy verb route that made a skip client-reachable is deleted. **The `home === null` re-claim path is unchanged** and is now correct by the model — a thread whose node is gone is a member of nothing |
| 7 | **LOW** client and server apply `put`/`drop` in opposite orders, under a comment denying it | **STILL LIVE** | Reproduced. See new finding 4 |
| 8 | **LOW** headline totals count workspaces that were never written | **FIXED** | Measured: a run whose only extra workspace is a `blank_id` skip reports identical `membersIn/paneNodesOut/nodesOut/seatedOut` to the run without it, and names the skipped workspace in its own `NOT WRITTEN` section. Mutation-checked (`recordNotWritten` folding into the headline → 3 tests red) |
| 9 | **LOW** the lone-member share rule is untested | **STILL LIVE** | Mutation re-run today: `shares.length < 2` → `< 1` leaves **610 / 610 lib tests green** |
| 10 | **LOW** two root-minting conventions | **STILL LIVE** | `rootSeedFor` mints `id === workspaceId` (`workspace-node-commands.ts:181`); the backfill mints `${workspaceId}::root` (`workspace-node-backfill.ts:761`) |

## `sanity-verdict-1.md` — DRIFT FOUND

| # | Claim | Today | Evidence |
|---|---|---|---|
| 1 | re-parenting hazard: no violations | **RE-CONFIRMED CLEAN** | See §2.6 |
| 2 | **HIGH** cross-workspace bind surfaces as a 502 | **FIXED** | 409 + rebase body (`nodes/route.ts`), delivered by the `pu-fix-xws` cluster; the conflict channel is probed in §2 |
| 3 | **MED** a completed changelog leaf with no code | **FIXED** | `CHANGELOG.md` carries `Fixed`/`Changed`/`Added` entries, including *"Closing the last pane no longer ends your session"* and *"Closing a thread takes it out of the session"* |
| 4 | the cascade is correct and covered | **RE-CONFIRMED** | Mechanism unchanged; `THE CASCADE` tests present |
| 5 | **LOW** the backfill cluster has no committed report | **CLOSED** | `.pu-reports/` now holds 17 files, two of which take the backfill as their subject: `pu-fix-backfill-highs.md` (the derivation's three findings, a rehearsal against a real pre-0256 database, 10 mutations) and `final-verdict.md` Part A (the 18-workspace census) |
| 6 | **LOW** the epic page duplicates its own spec | **NOT RE-TESTED** | A PageSpace page, not code. Outside this brief; `sanity-verdict-2.md` finding 6 remains the record |

## `sanity-verdict-2.md` — DRIFT FOUND, 12 findings

| # | Claim | Today | Evidence |
|---|---|---|---|
| 1 | **HIGH** the operator's census prints `NaN`; `scripts/` is in no typecheck project | **FIXED** | `tsc` over `backfill-agent-workspace-nodes.ts` + `lib/backfill-census.ts` + `lib/legacy-workspace-layout.ts` against the repo's own options: **the only error is the expected `import.meta.main` TS2339**, the same bun-ism all five backfill scripts carry. The real run prints numbers (census below). The census logic is now a pure, importable module with 19 tests, run by CI (`ci.yml:135`) |
| 2 | **HIGH** dismissed / history-deleted threads come back on the grid | **FIXED** | final-verdict #5 above |
| 3 | **MED-HIGH** a skipped workspace goes dark; the skip is client-reachable | **(a) FIXED (b) unchanged, by design (c) unreachable** | final-verdict #6 above. (c) verified: `apps/web/src/app/api/agent-workspaces/[workspaceId]/` holds `conversations`, `diff`, `files`, `git-blob`, `nodes`, `shells`, `route.ts` — **no `workspace/` and no `workspace/verbs/`** |
| 4 | **MED** three structures, four superseded tables, a live authenticated writer | **FIXED** | Verified in a migrated database: **4 tables** (`agent_workspaces`, `agent_workspace_shells`, `agent_workspace_nodes`, `agent_workspace_node_revs`). `workspace-layout-verbs.ts`, `contract.ts`, `workspace-layout-wire.ts`, `workspace-layout-store.ts`, `workspace-layout-runtime.ts` are all **gone**; `git grep` finds **zero** tracked source importing any of them (every remaining mention is a comment naming what was deleted). `conversations.workspaceId` / `closedInWorkspaceAt` are gone from the schema and from the live table. The one legacy artefact left is `scripts/lib/legacy-workspace-layout.ts` — 91 lines the migration declares for itself, with a header saying to delete it with the script |
| 5 | **MED** totals count workspaces never written | **FIXED** | final-verdict #8 |
| 6 | **MED** the epic page states the superseded model seven times | **NOT RE-TESTED** | Board artefact, outside this brief |
| 7 | **LOW** `put`/`drop` order divergence + a comment denying it | **STILL LIVE** | New finding 4 |
| 8 | **LOW** lone-member share rule unpinned | **STILL LIVE** | final-verdict #9 |
| 9 | **LOW** three root-minting conventions | **STILL LIVE** (two in production paths) | final-verdict #10; `admit`'s `newRootId` branch is reachable when handed an empty set (probed: `admit([]) → put:[root r1, pane n1]`) but unreachable through `commitUnderLock`, whose `seed` defaults to true |
| 10 | **LOW** `bound_elsewhere` is dead code and its docblock asserts the opposite | **STILL LIVE** | New finding 5 |
| 11 | **LOW** the backfill cluster still has no committed report | **CLOSED** | sanity-verdict-1 #5 above |
| 12 | **LOW** residual `detached` vocabulary in shipped client comments | **STILL LIVE**, and there is a third | New finding 6 |

## `sanity-2026-08-08-23.md` — DRIFT FOUND (the scheduled run)

| # | Claim | Today | Evidence |
|---|---|---|---|
| 1 | **the epic tip does not compile** (3 × TS2339 in `agent-workspaces-runtime.ts`) | **FIXED** | Monorepo typecheck 17/17; `tsc --noEmit` in `apps/web` exit 0 |
| 2 | re-parenting hazard: no violations | **RE-CONFIRMED** | §2.6 |
| 3 | board reads 100% over a red PR; 3b a leaf named for an unshipped identifier | **NOT RE-TESTED** | Board artefacts, outside this brief |
| 4 | scope-reduction scan clean | **RE-CONFIRMED** | §2.7 |
| 5 | worktrees reaped mid-audit | n/a | Operational |
| 6 | report coverage gaps | **CLOSED** | sanity-verdict-1 #5 |

## `audit-simplicity.md` — the premise audit

| # | Claim | Today |
|---|---|---|
| 1 | **CRITICAL** the branch has THREE structures | **FIXED** — §2.4 / sv2 #4 |
| 2 | **HIGH** the self-FK cascade is redundant and caused the data-loss bug | **NOT DONE, deliberately sequenced.** The cascade is still on the composite self-FK and `persistedWrite`'s rescue still exists to defend against it. This was step 3 of that audit's own order, after step 2 (delete the old model), which is what this branch did. Not drift; an open follow-up with a named cost |
| 3 | assumptions inherited rather than required (`node_revs` as its own table; `WireWorkspaceNode = WorkspaceNode & {rootId?}`; `workspace-node-chat-binding.ts`) | **ALL STILL PRESENT**, all argued in place. Follow-ups |
| 4 | separation of concerns — extract `workspace_sandboxes` | **NOT DONE**, argued and costed in `pu-one-removal.md` §4 |
| 5 | **ORDERING** `FRACTION_EPSILON`/`readFraction` imported by the new model from the old | **FIXED** — `packages/lib/src/agent-workspaces/workspace-fractions.ts` (227 lines), with its own 21-case suite |

---

# 2. WHAT I PROBED, AND WHAT CAUGHT IT

Every row constructed at runtime, not read for.

### 2.1 A parentless non-root node

| path | mechanism | answer |
|---|---|---|
| `nodeFromRow(pane, parentId: null)` | **row parse** | REFUSED — `expected string, received null` at `["parentId"]` |
| `nodeFromRow(split, parentId: null)` | **row parse** | REFUSED |
| `nodesFromRows([goodRoot, badPane], 'W')` | **row parse** | REFUSED — the **whole set**, not filtered (a good set of the same shape parses) |
| `create({parentId: null})` | **algebra** | `unknown_parent` — *no node "null" to create "pc" in* |
| `move({parentId: null})` | **algebra** | `unknown_parent` |
| wire `put:[{pane, parentId: null}]` | **wire schema** | REFUSED — `put.0.parentId: expected string, received null` |
| `validateTree(forged parentless pane)` | **validator** | `null_parent` |
| `decideNodeWrite(forged parentless pane)` | **validator via the write path** | `{status:'invalid', code:'null_parent'}` |
| wire `parentId: "   "` (survives `min(1)`) | wire ACCEPTS; **validator** catches | `dangling_parent` — correct: it resolves to nothing |
| **`INSERT` a parentless pane row straight into Postgres** | **NOTHING** — the table takes it | `INSERT 0 1` |

**Named, because the brief asks for a path where none catches:** the **database** does not refuse a
parentless non-root row. The converse CHECK (`nodeType = 'root' OR parentId IS NOT NULL`) is
deliberately absent and the schema says so at `agent-workspace-nodes.ts:197-202`. The consequence is
contained and correct, and I measured it: after that one hand-written INSERT, reading `ws06` back
through the production path **threw** and the workspace became unreadable — which is exactly what
`nodesFromRows`' reject-don't-filter rule promises. Every other seeded workspace round-tripped
`{ok:true}`. This is a documented layer boundary, not an unguarded path; a *writer* cannot reach it.

### 2.2 A second removal path — searched for, not found

* **One** `db.delete(agentWorkspaceNodes)` in tracked production source
  (`workspace-node-store.ts:332`), driven by `decision.persist.drop`.
* **One** removal in the model: `destroy`. Probed — `destroy(root)` → `drop:[R,pa,pb]`,
  `destroy(pane)` → `drop:[pa]` with the sibling reseated. `closePane(root)` → `root_immutable`
  (*"closing a pane is not ending the session"*) — a command asserting its own subject, not a second
  mechanism. `expel` of a thread the workspace does not hold → `not_a_member`.
* **One** session-ending path: `endSession` → `endAgentSession` (stamps) then `destroyWorkspaceTree`
  → `commitUnderLock(seed:false, destroy(rootOf(nodes).id))`. `endAgentSession`'s only caller is
  `endSession`. No `DELETE` route touches nodes.
* **The one thing that removes nodes without going through `destroy`** is referential: deleting a
  `drives` row cascades `agent_workspaces` → `agent_workspace_nodes`. Four call sites
  (`account-repository.ts:88,137`, `api/trash/drives/[driveId]/route.ts:63`,
  `api/account/handle-drive/route.ts:120`). That removes the *workspace*, not a node inside a living
  one, and the sprite-reclaim AFTER-DELETE trigger covers the compute. Not a second removal of the
  kind this epic was about — recorded so a future audit does not have to re-derive it.

### 2.3 A chat bound in two workspaces

| path | mechanism | answer |
|---|---|---|
| two panes on one chat, same set | **validator** | `duplicate_chat_target` |
| `bind` a second pane to a shown chat | **algebra** | `target_already_shown` |
| `decideNodeWrite` with both | **validator** | `{status:'invalid', code:'duplicate_chat_target'}` |
| raw `INSERT` in a **different** workspace | **database** | `duplicate key … agent_workspace_nodes_chat_target_idx` |
| raw `INSERT` in the **same** workspace | **database** | same |
| the runtime write path | **pre-flight + by-name backstop** | `readChatTargetHolders` → **throws** `NodeWriteConflicted` inside the transaction (`workspace-node-runtime.ts:455`); the index violation is caught **by constraint name** at `:511-516` and answered `conflict` / 409 + a fresh snapshot |

**No unguarded path.** The cross-workspace case is invisible to the validator *by construction* (its
input is one workspace) and the code says so at `workspace-node-validate.ts:483-505`.

### 2.4 A pane given a child, and a cycle

| path | mechanism | answer |
|---|---|---|
| `create` under a pane | **algebra** | `not_a_container` |
| `move` under a pane | **algebra** | `not_a_container` |
| `validateTree` | **validator** | `pane_has_children` |
| `decideNodeWrite` | **validator** | `invalid / pane_has_children` |
| raw `INSERT` of a child under a pane | **NOTHING** — the table takes it | as §2.1: caught on read |
| `validateTree` on a disjoint 2-cycle | **validator** | `cycle` — *node "s1" is its own ancestor* |
| self-parent | **validator** | `cycle` |
| `move(container into its own child)` | **algebra** | `parent_in_subtree` |
| `decideNodeWrite` with a cyclic `put` | **validator** | `invalid / cycle` |
| raw `INSERT` of a 2-cycle | **NOTHING** | as above |

### 2.5 The root

`move(root)` → `root_immutable` (*"the workspace has no outside"*); `bind(root)` → `root_immutable`;
`destroy(root)` → accepted, and it is the whole correction.

### 2.6 The re-parenting hazard

Swept the **106** changed non-test `.ts`/`.tsx` files. One fallback operator on a `parentId`
assignment: `workspace-node-placement.ts` `command.parentId ?? root?.id` — the documented `arrange`
default, root found by `rootOf` (by type), a rootless workspace refusing `no_root`, and the moved ids
filtered to `childrenOf`. Every other site is a read, a comparison, `parentId: null` on a root, or
the collapse promotion (a success path putting a survivor where its container was).
`useAgentWorkspaceStore`'s old `root?.id ?? ''` sentinel no longer exists. **0 violations.**

### 2.7 Scope reduction

Over the same 106 files: `TODO`/`FIXME`/`XXX`/`HACK` **0**; `@ts-ignore`/`@ts-expect-error` **0**;
`.skip(`/`it.todo` **0**; "for now"/"out of scope" **0**; empty `catch {}` **0**; ` as any` 2 hits,
both the English words *"as any other"* in prose; `eslint-disable` 2, both
`react-hooks/exhaustive-deps` and **both present verbatim on `master`**; `as unknown as` 4, none in
this epic's surface.

---

# 3. NEW FINDINGS — most severe first

## FINDING 1 — **BLOCKER**: migration `0256`'s pre-flight refuses on a **correctly migrated** database, so the cutover cannot complete

`packages/db/drizzle/0256_dapper_groot.sql:65-80`

The `DO` block counts, as evidence that the backfill has not run:

```sql
SELECT count(*) INTO orphan_threads FROM conversations c
 WHERE c."workspaceId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM agent_workspace_nodes n
                    WHERE n."targetKind" = 'chat' AND n."targetId" = c.id);
```

**Three categories of row satisfy that predicate on a database the backfill has just migrated
perfectly**, because the derivation is *supposed* to leave them without a node:

1. **A dismissed thread** — `closedInWorkspaceAt` stamped. Excluded from the membership load
   (`scripts/backfill-agent-workspace-nodes.ts:277`) and, since the finding-5 fix, from the pane load
   too (`:523`). Its `workspaceId` is never cleared.
2. **A history-deleted thread** — `isActive = false`. Same.
3. **Anything belonging to an ENDED workspace** — the run only scans `endedAt IS NULL`
   (`:373`), by design. Its threads *and* its pane rows are left behind, so it also trips the
   `orphan_panes` half.

All three are ordinary production data. The check was added by `74cfc470b` (*"make 0256's pre-flight
checks refuse instead of advise"*), before the backfill learned to drop non-member panes, and was
never revisited against what the derivation actually emits.

### Measured, end to end

`pagespace_cv`: fresh database, **0255 only**, seeded with eight realistic workspaces including a
live pane bound to a dismissed thread, a live pane bound to a history-deleted thread, a pane on a
hard-deleted thread, cross-workspace pane contention, shells, and an ended session.

```
before the backfill:  ERROR: Node backfill has not run on this database:
                             12 pane row(s) and 11 thread(s) have no node.       ← correct refusal

$ bun scripts/backfill-agent-workspace-nodes.ts --apply
✅ clean — every scanned workspace is accounted for, and 0256 may be applied      ← the script's own gate

after the backfill:   ERROR: Node backfill has not run on this database:
                             1 pane row(s) and 3 thread(s) have no node.          ← the SAME refusal
```

The four rows, named:

```
 pane | workspaceId
------+-------------
 p07  | ws07          ← an ENDED workspace's pane row

    thread    | workspaceId | isActive | closedInWorkspaceAt
--------------+-------------+----------+---------------------
 c02dismissed | ws02        | t        | 2026-02-01 00:00:00   ← dismissed: no node BY DESIGN
 c03deleted   | ws03        | f        |                       ← history-deleted: no node BY DESIGN
 c07          | ws07        | t        |                       ← an ENDED workspace's thread
```

And through the **real migrator**, on `pagespace_cv2` (same corpus, backfill applied, exit 0):

```
$ bun run --filter '@pagespace/db' db:migrate
  Applying: cacc0697... (1786285111169)
  cause: error: Node backfill has not run on this database: 1 pane row(s) and 3 thread(s) have no node.
Exited with code 1
        drizzle.__drizzle_migrations = 256 rows      ← still at 0255; agent_workspace_panes still present
```

**Failure scenario.** The operator follows the script's own procedure to the letter: deploy 0255, run
the backfill dry (exit 0), run `--apply` (exit 0, *"0256 may be applied"*), deploy the app image, then
deploy the migration. The migration aborts. It fails **closed** — per-migration transactions mean
0256 is simply not applied and nothing is lost — but the cutover cannot complete, and the error's own
remedy (*"Run scripts/backfill-agent-workspace-nodes.ts, verify both counts are 0, then re-apply"*)
is unsatisfiable: re-running the backfill writes nothing and the counts never reach 0. The only way
through is hand-written UPDATEs and DELETEs against production rows that the migration is about to
drop anyway — undocumented, and exactly the "a human who is not in the room" the block was written
to replace.

CI does not see this: its `db:migrate` runs against an empty `pagespace_test`, where both counts are
genuinely 0. Only a database with history breaks, which is every database that matters.

**What would have to change.** The two predicates must be the derivation's, not a proxy for it —
panes scoped to live workspaces, threads scoped to live workspaces **and** `isActive` **and**
`closedInWorkspaceAt IS NULL`. Measured against the same migrated corpus, that pair returns
`0` and `0`. (`CLAUDE.md` forbids hand-editing `packages/db/drizzle/`; `0256` already carries a
documented, argued exception for precisely this block, so the precedent for the fix is in the file.)

## FINDING 2 — **HIGH**: the tenant export carries no membership, and the repo's own ratchet is red in CI

`scripts/lib/tenant-export-columns.ts:302-327` · `scripts/lib/migration-types.ts:133-148` ·
`.github/workflows/ci.yml:131-135`

`agent_workspace_nodes` and `agent_workspace_node_revs` appear in neither `TENANT_EXPORT_COLUMNS`,
`TABLE_IMPORT_ORDER`, nor `TENANT_EXPORT_EXCLUDED_TABLES`. The branch's own guard says so and fails:

```
$ cd scripts && bunx vitest run
 × tenant export column registry > records a carry-or-exclude decision for every table …
   - Array []
   + Array [ "agent_workspace_node_revs", "agent_workspace_nodes" ]
 Test Files  1 failed | 14 passed | 1 skipped (16)
      Tests  1 failed | 291 passed | 14 skipped (306)
```

Two things make this the branch's problem rather than an inherited one.

**It is caused by this branch.** `master` has no `agent-workspace-nodes.ts` at all, so the guard —
which derives its FK closure from the live schema — passes there. This branch creates the tables and
does not register them.

**It is a red CI check.** `ci.yml:135` runs `cd scripts && bunx vitest run` unconditionally inside the
unit-test job. There is no path filter and no `continue-on-error`.

**Failure scenario.** A cloud → dedicated-tenant migration exports a user's bundle. Post-cutover a
conversation is in a workspace exactly when a node binds it, and no node travels. The migrated tenant
opens every session empty, with every thread present but reachable only through past-conversation
history — the ghost this epic exists to delete, arriving through the export path instead of the write
path. Before this branch the equivalent loss was column widths (`agent_workspace_panes` was excluded,
and `conversations.workspaceId` carried membership); now it is membership itself.

The module is honest about it — the note at `:309-327` says *"UNDECIDED, and the table guard below is
red because of it"* and argues why the decision is real work rather than a registry line. I agree with
the reasoning and with refusing to write an exclusion nobody believes. It still leaves the cutover
branch shipping a red required-ish check and a tenant migration that silently drops membership, and
the decision is now blocking rather than deferrable, because the fallback column it used to ride on is
being dropped in the same PR.

## FINDING 3 — **LOW**: `0256`'s header states, in the file an operator reads before an irreversible act, that the backfill script is deleted

`packages/db/drizzle/0256_dapper_groot.sql:30-32`

> *"(`scripts/backfill-agent-workspace-nodes.ts` at migration 0255, **now deleted with the tables it
> read**)"*

The script exists, runs, and is step 3 of the procedure this same migration's step 5 depends on.
`pu-fix-backfill-highs.md` §8 recorded the discrepancy and left it, correctly citing `CLAUDE.md`'s
rule against editing generated SQL. Recorded again here because the sentence is inside the block that
tells an operator what to do, and it tells them the tool does not exist.

## FINDING 4 — **LOW (carried, third audit)**: the client and the server apply `put`/`drop` in opposite orders, and the server's comment says they do not

`packages/lib/src/agent-workspaces/workspace-node-algebra.ts:160` ·
`packages/lib/src/agent-workspaces/workspace-node-write.ts:190-191`

`applyNodeWrite` is `removeNodes(upsertNodes(nodes, put), drop)` — **put, then drop**, and the
docblock above it argues at length why that order is the safe one. `decideNodeWrite` computes
`upsertNodes(removeNodes(nodes, drop), incoming)` — **drop, then upsert** — under:

> *"Drop first, then upsert — a node is never in both, and this is `applyNodeWrite`'s order, so the
> tree judged here is exactly the tree the algebra would have produced."*

Driven with one id in both arrays:

```
client  applyNodeWrite  -> ["R","pb"]          (pa removed)
server  decideNodeWrite -> ["R","pb","pa"]     (pa kept)
```

The algebra emits no overlapping write, so the shipped client cannot produce one. The comment is the
dangerous half: `validateTree`'s own docblock anticipates *"a client that assembled its own nodes
never goes through the algebra's operations at all"*, and this comment tells the next maintainer the
two orders are interchangeable. One line of prose, unchanged across three audits.

## FINDING 5 — **LOW (carried)**: `bound_elsewhere` is an unreachable union member whose comment points at a live mechanism

`apps/web/src/lib/agent-workspaces/workspace-node-runtime.ts:168-172` ·
`apps/web/src/lib/agent-workspaces/agent-workspaces-runtime.ts:297`

`NodeWriteRefusal` still names `'bound_elsewhere'`, and `git grep` over `apps/web/src` and
`packages/lib/src` finds **no construction site** — only the declaration and consumer branches.
`agent-workspaces-runtime.ts:297` (`if (result.code === 'bound_elsewhere')`) can never be taken; the
live path is `:307`, which maps `status: 'conflict'` onto the *outcome* of the same name. The type's
comment says the opposite of what the code does:

> *"`bound_elsewhere` is the one code no layer can produce: it comes from the table's global
> chat-target index, and only the database is in a position to know."*

The index path answers `conflict`. A dead union member with a comment pointing at a live mechanism is
how the previous one of these survived a whole phase.

## FINDING 6 — **LOW (carried, and one more)**: comments describing states the model cannot spell

* `apps/web/src/stores/agent-workspace/workspace-tree-view.ts:7` — *"…a detached node, a target with
  no resolved title, an empty grid…"*
* `apps/web/src/components/agents/panes/SessionPanes.tsx:42` — *"The workspace's whole flat list —
  attached and detached."*
* **New:** `apps/web/src/lib/repositories/conversation-repository.ts:717-719` — *"Closing is now a
  `move` of the thread's node to no parent and reopening is a `move` back"*. That is the interim cut
  the one-removal correction deleted; closing is a `destroy`, as
  `close-conversation-in-workspace.ts:1-14` states at length.

Every other occurrence of the word in this domain is deliberate history. These three read as current
fact.

## FINDING 7 — **LOW (carried)**: at exactly `MAX_NODES`, an eviction that nets zero growth is refused

`workspace-node-commands.ts` — the eviction path creates before it destroys, so the transient tree is
one node over. Probed on a workspace holding 2047 bound panes: `max_nodes_exceeded: 2049 nodes; the
cap is 2048`. Reachable only by deliberately filling a workspace, and the message states a node count
the requested write does not produce.

## FINDING 8 — **LOW (carried)**: the lone-member share rule is load-bearing, argued at length, and unpinned

`packages/lib/src/agent-workspaces/workspace-node-backfill.ts:427`

`if (shares.length < 2) return shares.map(() => null);` weakened to `< 1` leaves
**610 passed / 610, exit 0**. Fourth audit to say so, on the module that runs once against real data.
Every *other* rule in that module I mutated today is genuinely pinned (13 tests for the membership
predicate, 1 each for the two terms of the exit gate, 3 for the census separation).

## FINDING 9 — **LOW (carried)**: two root-minting conventions, and two stale schema comments

`workspace-node-commands.ts:181` mints `id === workspaceId`; `workspace-node-backfill.ts:761` mints
`${workspaceId}::root`. Harmless — `rootOf` finds by type — but an operator reading rows finds two
conventions for one concept depending on whether the workspace predates the cutover, and the seeded
corpus above shows both would coexist. Adjacent: `scripts/lib/migration-types.ts:131` still explains
its ordering with *"`conversations.workspaceId` FKs here"*, a column `0256` drops.

---

# 4. THE CENSUS — verbatim

`pagespace_cv`, migrated to **0255 only**, seeded with eight workspaces: two production-shaped grids,
**a live pane bound to a dismissed thread** (`ws02`), **a live pane bound to a history-deleted
thread** (`ws03`), a pane on a hard-deleted thread (`ws04`), a terminal pane plus an unplaced shell
(`ws05`), cross-workspace pane contention between `ws01` and `ws06`, an **ENDED** session (`ws07`),
and a membership-only workspace with no pane rows (`ws08`).

```
🌳 agent workspace node backfill — DRY RUN (nothing is written)
   8 conversation(s) with a resolved chat claim
   ws01: panes 3→3, threads 3, shells 0, members 4→4, seated 1, nodes 6 · chat_target_foreign,fractions_read_as_unsized
   ws02: panes 2→1 (1 not a member), threads 1, shells 0, members 1→1, seated 0, nodes 2 · chat_pane_not_a_member,fractions_read_as_unsized
   ws03: panes 2→1 (1 not a member), threads 1, shells 0, members 1→1, seated 0, nodes 2 · chat_pane_not_a_member,empty_column_dropped,fractions_read_as_unsized
   ws04: panes 1→0 (1 not a member), threads 0, shells 0, members 0→0, seated 0, nodes 1 · chat_pane_no_conversation,empty_column_dropped
   ws05: panes 2→2, threads 0, shells 2, members 3→3, seated 1, nodes 5 · fractions_read_as_unsized
   ws06: panes 1→1, threads 1, shells 0, members 1→1, seated 0, nodes 2
   ws08: panes 0→0, threads 2, shells 0, members 2→2, seated 2, nodes 3

── census (DRY RUN — nothing was written) ─────────────────────
  live workspaces scanned : 7
  already migrated (skip) : 0
  would write             : 7
  skipped (NOT derivable) : 0
  write failures          : 0

  ── what WOULD be written ──
  pane rows read          : 11
    NOT materialised      : 3
      dismissed / deleted : 2
      no conversation row : 1
  ↳ panes bound to threads that are NOT members. Materialising one would put a
    thread the user closed back on their grid; these are deliberately dropped.
  pane rows materialised  : 8
  open conversations in   : 8
  shells in               : 2
  members in              : 12
  pane nodes out          : 12
    of which seated       : 4
  total nodes out         : 21
  membership dropped      : 0

  anomalies               : {"chat_target_foreign":1,"fractions_read_as_unsized":4,"chat_pane_not_a_member":2,"empty_column_dropped":2,"chat_pane_no_conversation":1}

✅ clean — every scanned workspace is accounted for; this was a DRY RUN
```

**`members in` = `pane nodes out` = 12, in the total and in every workspace individually.** No
workspace lost a member and none grew one. `ws07` (ENDED) was correctly never scanned. `--apply`
printed the identical census under an `(APPLIED)` banner and wrote 21 rows.

**The rows, and what they prove.** `c02dismissed` and `c03deleted` have **no node**, and their live
pane rows were not materialised — `final-verdict.md` finding 5, closed at the database. `ws01`'s
`p01c`, which names `ws06`'s thread, landed **unbound** rather than stealing the binding. `ws04`'s
grid is a bare root. Every one of the seven migrated workspaces read back through the production path
(`nodesFromRows` → `validateTree`) as `{ok: true}`, and every emitted row carried its own workspace's
`rootId`.

**The gate, and idempotence** (`pagespace_cv2`, same corpus plus a whitespace-id pane row):

```
dry run, one blank_id workspace      -> ❌ NOT SAFE TO CUT OVER … ws09 SKIPPED(blank_id) held 1 pane(s)   exit 1
                                        totals identical to the run without ws09 (members in 12, nodes out 21)
dry run, after repairing the id      -> ✅ clean                                                          exit 0
--apply                              -> written 7→8, 23 node rows, 8 rev rows at rev 0                    exit 0
--apply again                        -> already migrated (skip): 8 · written: 0 · node rows still 23      exit 0
```

---

# 5. GATES

| gate | result |
|---|---|
| `bun run build` | **exit 0** |
| `bun run typecheck` (MONOREPO, after build) | **exit 0** — 17/17, zero `error TS` |
| `bunx tsc --noEmit` **directly in `apps/web`** | **exit 0**, zero errors |
| `bun run lint` (MONOREPO) | **exit 0** — 15/15 |
| `bun run --filter @pagespace/lib lint` | **exit 0** |
| `bun run --filter @pagespace/lib test -- src/agent-workspaces` | **610 passed / 610**, 19 files, exit 0 |
| `bun run --filter web test -- src/lib/agent-workspaces` | **200 passed / 200**, 17 files (all 6 integration files ran against a live DB), exit 0 |
| `web test -- src/lib/agent-workspaces src/stores/agent-workspace src/components/agents/panes src/components/layout/left-sidebar` | **495 passed / 495**, 35 files, exit 0 |
| `cd scripts && bunx vitest run` | **1 failed / 291 passed / 14 skipped** — finding 2 |
| `tsc` over `backfill-agent-workspace-nodes.ts` + `lib/backfill-census.ts` + `lib/legacy-workspace-layout.ts` | **1 error, the expected `import.meta.main`** — nothing else |
| `bun run knip:check` | 4 issues on a built tree, all gitignored Capacitor `cordova*.js`. Moved aside and re-run: `[ok] knip: 4 issue(s), all within baseline (4)`, **exit 0**; restored. CI's knip runs in the `lint` job, which never builds |
| the backfill against a real pre-0256 database | dry **exit 1** with a skip, **exit 0** clean, `--apply` idempotent |
| **`bun run --filter '@pagespace/db' db:migrate` over a correctly backfilled database** | **exit 1 — finding 1** |

`bun run typecheck -- --force` fails with a wall of `TS6053 .next/types/…` — the documented turbo
race (`web#typecheck` has no edge to `web#build`), not a branch defect. Sequenced, and re-verified by
running `tsc` in `apps/web` by hand against a completed build, it is clean.

---

# 6. VERDICT: **DO NOT SHIP**

This is close, and it is worth saying what changed. The three blockers `final-verdict.md` named are
genuinely fixed rather than worked around: the branch compiles monorepo-wide, the post-`within`
conflict throws so the transaction unwinds, and the sessions listing runs. The correction the epic
turned on holds under construction rather than under reading — a parentless non-root node is refused
by the type, the parse, the wire, the algebra and the validator, with the one gap (the table) named,
argued in the schema, and contained by a read path that rejects rather than filters. `destroy` really
is the one removal, and I went looking for a second one rather than taking the claim. The premise is
restored: four tables, zero old-model source lines, zero importers, both membership columns gone. And
the finding nobody could have fixed afterwards — dismissed and history-deleted threads coming back on
the grid — is fixed, verified against a real pre-`0256` database, and pinned by thirteen named tests
that die when I break it. `members in` equals `pane nodes out` in every workspace and in the total.

**What stops it is the last step.** Migration `0256`'s pre-flight was written against an idea of the
derivation rather than against the derivation, and the finding-5 fix moved the derivation further away
from it. The result is that the cutover's final migration **refuses to apply to a database the
backfill has just migrated perfectly**, and refuses with an instruction that cannot be carried out. It
fails closed, so nothing is at risk — but the epic cannot land, and the failure appears only on a
database with history, which is to say never in CI and always in production.

## What would have to change

1. **Finding 1 — the `0256` pre-flight must count what the derivation actually leaves behind.** Scope
   both predicates to live workspaces (`endedAt IS NULL`), and the thread predicate additionally to
   `isActive` and `closedInWorkspaceAt IS NULL`. Verified against the migrated corpus, that pair
   returns `0` / `0` where the shipped pair returns `1` / `3`. Non-negotiable: without it the
   migration is unappliable, and there is no manual workaround that does not mean hand-editing
   production rows. This is the only item on the list.
2. **Finding 2 — settle `agent_workspace_nodes` and `agent_workspace_node_revs` in the tenant
   registry**, or accept and *document at the decision site* that tenant migrations ship sessions with
   no membership. Either way the CI step at `ci.yml:135` has to stop being red on the cutover PR. The
   module's own note argues the carry side is real export work (`targetId` is polymorphic with no FK,
   and the global chat index turns a mistake into a failed import); that argument is right, and it is
   also the argument for why this cannot ride along as a registry line after the fact.
3. **Finding 3** — one sentence in `0256`'s header claims the tool its own procedure depends on has
   been deleted. Whatever the resolution of the `CLAUDE.md` rule, an operator should not read it.

Findings 4–9 are follow-ups and should not block. Two are worth a line each anyway, because they are
prose that will mislead someone: the `put`/`drop` comment (finding 4), now unchanged across three
audits, and `bound_elsewhere`'s docblock (finding 5), which is the same shape of dead-code-plus-wrong-
comment that hid the ghost for a phase. Finding 8's unpinned rule is one test on the one module in
this branch that gets no second chance.

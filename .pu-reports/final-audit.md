# Final audit — the node-tree cutover at a stationary tip

**Auditor only.** Nothing was implemented, nothing fixed, nothing merged, no PR opened, no board
task touched. Two throwaway databases (`pagespace_fa`, `pagespace_fa2`) were created on the shared
test container, used, and dropped; no other database was touched. Every mutation was applied to the
shipped source, the suite re-run, and the file restored — verified clean by `git status --porcelain`
after each. Runtime probes were written into `.pu-probe/`, run, and deleted. The working tree was
clean before this file and is clean after it.

**Audited:** `pu/workspace-node-model` @ `27eeff101`, the base the brief names. Merge-base with
`master` is `968e7be76`. The diff is **245 files**, 108 of them non-test `.ts`/`.tsx`.

**Method.** Every row below was produced by running something. Where a previous report says a fix
landed, I re-derived it rather than reading it — including by breaking the mechanism and watching
the suite go red.

---

## 0. TWO CORRECTIONS TO THE BRIEF'S PREMISES, ESTABLISHED FIRST

Both are bookkeeping, and neither changes what the code is. They are here because the brief's
argument for why this verdict is meaningful rests on them.

**The tip moved, and there is a seventh audit.** The brief says "nothing is in flight, the tip has
not moved" and "six audits are on record in `.pu-reports/` (19 files)". `origin/pu/workspace-node-model`
is now `11df94c65`, one commit ahead of `27eeff101`, and that commit adds
`.pu-reports/sanity-2026-08-08-21.md` — a **seventh** audit ("recover a third scheduled verdict,
stranded on its own branch"), bringing the directory to 20 files. I read it and re-tested it; see
the table. Its findings are entirely orchestration-process (ghost worktrees in `pu status`,
worktrees reaped mid-run, a missing backfill report) and its two code sections — the re-parenting
hazard and the scope-reduction scan — came back CLEAN then and come back CLEAN now.

**No CI run exists for `27eeff101`.** The brief says "all 11 CI checks pass". They pass on
**`bea23a7b2`**, two commits below the current PR head:

| SHA | | `ci / E2E (agent-session user stories)` |
|---|---|---|
| `dff8c60f0` | merge(tenant-export) | **failure** |
| `bea23a7b2` | merge(realtime): close-row | **success** — with all 10 other checks green |
| `27eeff101` | report only | **no check run at all** (`total_count: 0`) |
| `11df94c65` | report only, current PR head | pending at time of writing |

This does not weaken the brief's point, and I verified why: **the code tree CI validated is
byte-identical to the tree I audited.**
`git diff --name-only bea23a7b2 11df94c65 -- . ':(exclude).pu-reports'` returns **0 files**.
Everything between the green run and the PR head is `.pu-reports/*.md`. The E2E green is real
evidence about this code.

I did **not** re-run Playwright locally. The E2E claim below rests on that CI run over the
identical tree, plus a mutation check of both halves of the seam in unit tests.

---

# 1. THE RE-TEST TABLE — every finding from every audit on record

## `pu-rev-phase1.md` — Phase 1+2 review of record (12)

| # | Claim | Today | Evidence |
|---|---|---|---|
| 1 | **HIGH** drop-then-put; the self-FK cascade eats a reparented subtree | **FIXED** | `workspace-node-algebra.ts:160` is `removeNodes(upsertNodes(nodes, put), drop)`; `workspace-node-write.ts` rescues survivors. Live DB: dropping a container cascades its subtree (probed) |
| 2 | **HIGH** `create` accepts an empty `nodeId` / blank `targetId` | **FIXED** | Probed: `create({parentId:'   '})` → `unknown_parent`; row parse refuses `parentId:''` (`too_small`); `validateTree` answers `blank_id` for a blank node id **and** a blank chat target |
| 3 | **MED-HIGH** fraction finiteness skipped on the parked group | **NO LONGER APPLICABLE** | No parked group; the sweep is hoisted out of the group loop (`workspace-node-validate.ts:424-432`), ahead of the sum |
| 4 | **MED** one-conversation-one-node lives only in the DB | **FIXED** | `duplicate_chat_target` probed in-set; cross-workspace closed at the write path and, measured, by the index itself |
| 5 | **MED** `validateTree` is O(n²) — **217 ms** at `MAX_NODES` | **MEASURED at 37.7 ms** | 2048 flat nodes → `{ok:true}` in 37.7 ms. Still super-linear; not the number the finding was written about |
| 6 | **MED** the "byte-identical round trip" is false — key order differs | **RESOLVED AS DOCUMENTED** | Probed a sized bound pane: `JSON.stringify` equal **true**, deep equal **true**, key order identical. The claim was in any case weakened to deep equality (`workspace-node.ts:105-109`) and the change test is `sameNode`, not `JSON.stringify` |
| 7 | **LOW-MED** at exactly `MAX_NODES`, a zero-growth eviction is refused | **STILL LIVE** | New finding 4. Measured: evict → `2049 nodes; the cap is 2048`; split → `2050` |
| 8 | **LOW** `openConversation` refuses a parked target | **NO LONGER APPLICABLE** | No parked state |
| 9 | **LOW** a detached pane keeps a stale `fraction` | **NO LONGER APPLICABLE** | Same |
| 10 | **LOW** the composite self-FK's name is truncated | **STILL LIVE, documented** | Live DB: `agent_workspace_nodes_rootId_parentId_agent_workspace_nodes_roo`. Named in the schema at `:202-206` |
| 11 | **LOW** `put` carries no ordering guarantee | **FIXED** | Stated in `NodeWrite`'s docblock (`workspace-node-algebra.ts:80-86`) |
| 12 | **LOW** `validateTree` spends the cast `descendantsOf` refuses to | **FIXED** | `workspace-node-validate.ts:362` uses the `shift()`-until-`undefined` idiom |

## `final-verdict.md` — DO NOT SHIP (10)

| # | Claim | Today | Evidence |
|---|---|---|---|
| 1 | **BLOCKER** branch does not typecheck or lint | **FIXED** | `bun run typecheck` MONOREPO **exit 0, 17/17, zero `error TS`**; `bun run lint` **exit 0, 15/15** |
| 2 | **HIGH** the unhandled `conflict` commits the ghost and reports success | **FIXED** | Throws `NodeWriteConflicted` inside the transaction (`workspace-node-runtime.ts:455`), re-formed outside the rollback (`:484-486`); the index refusal measured by name against a live table |
| 3 | **HIGH** `listSessionConversationsBulk` throws `id is ambiguous` | **FIXED** | Both columns aliased; the DB-backed suites run green (full web suite **16745 passed / 0 failed**) |
| 4 | **MED** four stale test files, 9 web failures | **FIXED** | Full web suite 1126 files, 16745 passed, 6 skipped, **0 failed** |
| 5 | **MED** the backfill puts dismissed and history-deleted threads back on screen | **FIXED — verified against a real pre-0256 database, and MUTATION-CHECKED** | Seeded `ws02` (live pane → dismissed thread) and `ws03` (live pane → history-deleted thread). After `--apply`, neither thread has a node and neither pane was materialised; census reports `panes 2→1 (1 not a member)` for each. **Neutering `partitionPanesByMembership` turns 13 named tests red** |
| 6 | **MED** a SKIPPED workspace is invisible and its threads re-claimable | **MOSTLY FIXED** | (a) docblock corrected; (b) **zero-skip exit gate measured**: exit **1** with one `blank_id` workspace, exit **0** after repair — and **mutation-checked** (dropping `skipped === 0` from `runIsClean` turns a test red); (c) the legacy verb route is deleted. **(d) the `home === null` re-claim path is unchanged** and is correct by the model — `claim-conversation-in-workspace.ts:117-126` |
| 7 | **LOW** client and server apply `put`/`drop` in opposite orders | **STILL LIVE** | New finding 3, reproduced at runtime |
| 8 | **LOW** headline totals count workspaces never written | **FIXED** | Measured: a run with one `blank_id` skip reports **identical** totals (`members in 12`, `nodes out 21`) to the run without it, and names it in its own `NOT WRITTEN` section |
| 9 | **LOW** the lone-member share rule is untested | **STILL LIVE** | New finding 5. Mutation re-run today: `< 2` → `< 1` leaves **610/610 green** |
| 10 | **LOW** two root-minting conventions | **STILL LIVE** | New finding 8 |

## `sanity-verdict-1.md` — DRIFT FOUND (6)

| # | Claim | Today | Evidence |
|---|---|---|---|
| 1 | re-parenting hazard: no violations | **RE-CONFIRMED CLEAN** | §2.6 |
| 2 | **HIGH** cross-workspace bind surfaces as a 502 | **FIXED** | 409 + rebase body; conflict channel probed |
| 3 | **MED** a completed changelog leaf with no code | **FIXED** | `CHANGELOG.md` is `M` on the branch |
| 4 | the cascade is correct and covered | **RE-CONFIRMED** | `THE CASCADE` tests present and green |
| 5 | **LOW** the backfill cluster has no committed report | **CLOSED** | `pu-fix-backfill-highs.md` + `final-verdict.md` Part A |
| 6 | **LOW** the epic page duplicates its own spec | **STILL LIVE, unchanged at 7×** | New finding 7 |

## `sanity-verdict-2.md` — DRIFT FOUND (12)

| # | Claim | Today | Evidence |
|---|---|---|---|
| 1 | **HIGH** the operator's census prints `NaN`; `scripts/` is in no typecheck project | **FIXED** | Hand-typechecked `backfill-agent-workspace-nodes.ts` + `lib/backfill-census.ts` + `lib/legacy-workspace-layout.ts` + `lib/tenant-export-columns.ts` + `lib/migration-types.ts` against the repo's own options: **the only error is the expected `import.meta.main` TS2339**, which **7 of 7** bun scripts in `scripts/` carry. Every census field printed a number in the real run below. `cd scripts && bunx vitest run` is wired at `ci.yml:135` |
| 2 | **HIGH** dismissed / history-deleted threads come back on the grid | **FIXED** | final-verdict #5 |
| 3 | **MED-HIGH** a skipped workspace goes dark; the skip is client-reachable | **(a) FIXED (b) unchanged by design (c) FIXED** | (c) re-verified: `api/agent-workspaces/[workspaceId]/` holds `conversations, diff, files, git-blob, nodes, shells, route.ts` — **no `workspace/` and no `workspace/verbs/`** |
| 4 | **MED** three structures, four superseded tables, a live authenticated writer | **FIXED** | §3, verified in a migrated database |
| 5 | **MED** totals count workspaces never written | **FIXED** | final-verdict #8 |
| 6 | **MED** the epic page states the superseded model seven times | **STILL LIVE at exactly 7×** | New finding 7 |
| 7 | **LOW** `put`/`drop` order divergence | **STILL LIVE** | New finding 3 |
| 8 | **LOW** lone-member share rule unpinned | **STILL LIVE** | New finding 5 |
| 9 | **LOW** three root-minting conventions | **STILL LIVE** (two in production paths) | New finding 8 |
| 10 | **LOW** `bound_elsewhere` is dead code, docblock asserts the opposite | **STILL LIVE** | New finding 6 |
| 11 | **LOW** the backfill cluster still has no committed report | **CLOSED** | sanity-verdict-1 #5 |
| 12 | **LOW** residual `detached` vocabulary in client comments | **PARTLY FIXED — 2 of 3 remain** | New finding 7b |

## `sanity-2026-08-08-23.md` — DRIFT FOUND (6)

| # | Claim | Today | Evidence |
|---|---|---|---|
| 1 | the epic tip does not compile (3 × TS2339) | **FIXED** | Monorepo typecheck 17/17, exit 0 |
| 2 | re-parenting hazard: no violations | **RE-CONFIRMED** | §2.6 |
| 3 | board reads 100% over a red PR; 3b a leaf named for an unshipped identifier | **3 RESOLVED / 3b STILL LIVE (and there are two)** | §4 |
| 4 | scope-reduction scan clean | **RE-CONFIRMED** | §2.7 |
| 5 | worktrees reaped mid-audit | n/a | Operational |
| 6 | report coverage gaps | **CLOSED** | 20 files |

## `sanity-2026-08-08-21.md` — the recovered SEVENTH audit (6)

| # | Claim | Today | Evidence |
|---|---|---|---|
| 1 | `pu status` reports eight worktrees that do not exist; 1b worktrees reaped mid-run | **NOT RE-TESTED** | Orchestrator state, outside this brief |
| 2 | a completed board leaf whose code is not on any branch (`pane-labels.ts`, Phase 4 at 0%) | **RESOLVED** | `D apps/web/src/stores/agent-workspace/pane-labels.ts` and its test are on the branch; Phase 4's seven leaves all have code (§4) |
| 3 | six feature commits with no report; `pu-wnt-wire.md` stale | **CLOSED** | 20 reports |
| 4 | three agents running ~50 min with zero commits | n/a | Operational, superseded |
| 5 | the re-parenting hazard: **CLEAN** | **RE-CONFIRMED CLEAN** | §2.6 |
| 6 | scope-reduction scan: **CLEAN** | **RE-CONFIRMED CLEAN** | §2.7 |

## `audit-simplicity.md` — the premise audit (5)

| # | Claim | Today |
|---|---|---|
| 1 | **CRITICAL** the branch has THREE structures | **FIXED** — §3 |
| 2 | **HIGH** the self-FK cascade is redundant | **NOT DONE, deliberately sequenced.** Step 3 of that audit's own order; the cascade is still on the composite self-FK and `persistedWrite`'s rescue still defends against it. An open follow-up with a named cost, not drift |
| 3 | assumptions inherited rather than required | **ALL STILL PRESENT**, argued in place. Follow-ups |
| 4 | extract `workspace_sandboxes` | **NOT DONE**, argued and costed in `pu-one-removal.md` §4 |
| 5 | **ORDERING** `FRACTION_EPSILON`/`readFraction` imported from the old model | **FIXED** — `workspace-fractions.ts` with its own suite |

## `closing-verdict.md` — DO NOT SHIP (9)

| # | Claim | Today | Evidence |
|---|---|---|---|
| 1 | **BLOCKER** `0256`'s pre-flight refuses a **correctly migrated** database | **FIXED in the executable block — NOT in the block above it** | **The whole of §5.** The `DO` block is now scoped to `endedAt IS NULL` and, for threads, additionally `isActive` and `closedInWorkspaceAt IS NULL`. Measured: **refuses** an unmigrated database (11 panes / 8 threads), **passes** the same database after the backfill, and `0256` applies through the **real migrator** end to end. **But the operator-facing comment at `:41-52` still carries the OLD unscoped queries** — see new finding 1 |
| 2 | **HIGH** the tenant export carries no membership; the repo's ratchet is red | **FIXED** | `cd scripts && bunx vitest run` → **15 passed / 1 skipped, 307 tests passed, exit 0** (was 1 failed / 291). `agent_workspace_nodes` IS carried — `TABLE_IMPORT_ORDER` (`migration-types.ts:150`), a spec in `TENANT_EXPORT_COLUMNS` (`:235`), an export query (`tenant-export.ts:411`) and a validate query (`tenant-validate.ts:208`). `agent_workspace_node_revs` is excluded with a written reason (`:382`). It is also now registered in GDPR export coverage (`gdpr-export-coverage.ts:96`) |
| 3 | **LOW** `0256`'s header says the backfill script is deleted | **STILL LIVE** | New finding 2. `0256_dapper_groot.sql:31-32` |
| 4 | **LOW** client/server `put`/`drop` order, with a comment denying it | **STILL LIVE** | New finding 3 |
| 5 | **LOW** `bound_elsewhere` dead union member | **STILL LIVE** | New finding 6 |
| 6 | **LOW** three `detached` comments | **PARTLY FIXED** | The third (`conversation-repository.ts`) now correctly reads *"Closing is now a `destroy` of the thread's node"*. Two remain — new finding 7b |
| 7 | **LOW** zero-growth eviction refused at `MAX_NODES` | **STILL LIVE** | New finding 4 |
| 8 | **LOW** the lone-member share rule is unpinned | **STILL LIVE** | New finding 5 |
| 9 | **LOW** two root-minting conventions; stale `migration-types.ts:131` | **root minting STILL LIVE; the `migration-types.ts` comment FIXED** | `migration-types.ts:132-135` now reads *"that column is gone and nothing on a conversation row references a session any more"*. Four **other** files still state it in the present tense — new finding 9 |

## `sanity-2026-08-09-10.md` — DRIFT FOUND (5)

| # | Claim | Today | Evidence |
|---|---|---|---|
| 1 | **HIGH** `agent_workspace_nodes` is an undecided table in the tenant export | **FIXED** | closing-verdict #2 above |
| 2 | **HIGH** a server-side close no longer removes the sidebar row | **FIXED, and MUTATION-CHECKED on both halves** | `ci / E2E (agent-session user stories)` is **success** on `bea23a7b2` (the identical code tree) and was **failure** on the merge before it. Both halves now have unit coverage that dies when broken: neutering `forgetConversationInCache` on the `conversation:closed` handler turns **4** named listener tests red; neutering `deps.announceClosed(row)` in the decider turns **2** red, including *"announces AFTER the membership write, never before it"* |
| 3 | **HIGH** the board reads 100%; nothing on master; PR red | **PARTLY RESOLVED** | The PR is green on the identical tree and `mergeable: MERGEABLE`. It is still **OPEN** and unmerged, which is correct — merges to master are the user's |
| 4 | **MED** pu registry and git disagree about the epic worktree | **NOT RE-TESTED** | Orchestrator state |
| 5 | **MED** unpushed commit on the epic branch | **RESOLVED** | Everything local is contained in the PR head (`git merge-base --is-ancestor` → yes); no epic worktree is dirty |

---

# 2. WHAT I PROBED, AND WHAT CAUGHT IT

Every row constructed at runtime, not read for.

### 2.1 A parentless non-root node

| path | mechanism | answer |
|---|---|---|
| `nodeFromRow(pane, parentId: null)` | **row parse** | REFUSED — `expected string, received null` at `["parentId"]` |
| `nodeFromRow(split, parentId: null)` | **row parse** | REFUSED |
| `nodesFromRows([goodRoot, badPane], 'W')` | **row parse** | REFUSED — the **whole set**, not filtered |
| `nodeFromRow(pane, parentId: '')` | **row parse** | REFUSED — `too_small` |
| `nodeFromRow(pane, parentId: '   ')` | parse ACCEPTS; **validator** catches | `dangling_parent` — correct: it resolves to nothing |
| `create({parentId: null})` | **algebra** | `unknown_parent` — *no node "null" to create "pc" in* |
| `move({parentId: null})` | **algebra** | `unknown_parent` |
| `create({parentId: '   '})` | **algebra** | `unknown_parent` |
| `validateTree(forged parentless pane)` | **validator** | `null_parent` |
| `decideNodeWrite(forged parentless pane)` | **validator via the write path** | `{status:'invalid', code:'null_parent'}` |
| **`INSERT` a parentless pane/split row straight into Postgres** | **NOTHING — the table takes it** | `INSERT 0 1`, twice |

**The one path where nothing catches, named:** the **database** accepts a parentless non-root row.
The converse CHECK (`nodeType = 'root' OR parentId IS NOT NULL`) is deliberately absent and the
schema says so at `agent-workspace-nodes.ts:196-200`. I measured the consequence: after those two
INSERTs, reading `ws04` back through the production path **threw**, and the workspace became
unreadable — which is exactly what `nodesFromRows`' reject-don't-filter rule promises. A *writer*
cannot reach it: every write goes through `decideNodeWrite` → `validateTree`. This is a documented
layer boundary, not an unguarded path.

### 2.2 A second removal path — searched for, not found

* **One** `db.delete(agentWorkspaceNodes)` in tracked production source
  (`workspace-node-store.ts:332`), driven by `decision.persist.drop`. **Zero** raw
  `DELETE FROM agent_workspace_nodes`.
* **One** removal in the model: `destroy`. Probed — `destroy(root)` → `drop:[W,pa,pb]`,
  `destroy(pane)` → `drop:[pa]` with the sibling reseated. `closePane(root)` → `root_immutable`
  (*"closing a pane is not ending the session, which is a destroy the caller names"*) — a command
  asserting its own subject, not a second mechanism.
* Every remover composes it: `closePane` → `compile([destroy])`; `expel` → `compile([destroy])`
  (`workspace-membership.ts:300`); the eviction path in `open` → `create` then `destroy`
  (`workspace-node-commands.ts:645`); `destroyWorkspaceTree` →
  `commitUnderLock(seed:false, destroy(rootOf(nodes).id))` (`workspace-node-runtime.ts:654`), whose
  only caller is `endSession`.
* `move` cannot remove: probed, it only ever returns a `put` (`drop: []`).
* The one thing that removes nodes without going through `destroy` is **referential**: deleting a
  `drives` row cascades `agent_workspaces` → `agent_workspace_nodes`. That removes the *workspace*,
  not a node inside a living one. Recorded so a future audit need not re-derive it.

### 2.3 A chat bound in two workspaces

| path | mechanism | answer |
|---|---|---|
| two panes on one chat, same set | **validator** | `duplicate_chat_target` |
| `bind` a second pane to a shown chat | **algebra** | `target_already_shown` |
| `create` a second pane on a shown chat | **algebra** | `target_already_shown` |
| `decideNodeWrite` with both | **validator** | `{status:'invalid', code:'duplicate_chat_target'}` |
| raw `INSERT` in a **different** workspace | **database** | `duplicate key … agent_workspace_nodes_chat_target_idx` |
| raw `INSERT` in the **same** workspace | **database** | same |
| the runtime write path | **pre-flight + by-name backstop** | throws `NodeWriteConflicted` in-transaction; index violation caught by constraint name; answered `conflict` / 409 + fresh snapshot |

**No unguarded path.** The cross-workspace case is invisible to the validator *by construction* —
its input is one workspace — and the code says so at `workspace-node-validate.ts:483-505`.

### 2.4 A pane given a child, and a cycle

| path | mechanism | answer |
|---|---|---|
| `create` under a pane | **algebra** | `not_a_container` |
| `move` under a pane | **algebra** | `not_a_container` |
| `validateTree` | **validator** | `pane_has_children` |
| raw `INSERT` of a child under a pane | **NOTHING** — the table takes it | caught on read: `pane_has_children` |
| `validateTree` on a disjoint 2-cycle | **validator** | `cycle` — *node "s1" is its own ancestor* |
| self-parent | **validator** | `cycle` |
| `move(container into its own child)` | **algebra** | `parent_in_subtree` |
| `decideNodeWrite` with a cyclic `put` | **validator** | `invalid / cycle` |
| raw `INSERT` of a cycle, **row at a time** | **database** | REFUSED by the composite self-FK (the parent does not exist yet) |
| raw `INSERT` of a cycle, **one multi-row statement** | **NOTHING** — FK triggers fire at statement end | caught on read: `cycle` |
| raw `UPDATE` making a pane its own parent | **NOTHING** | caught on read: `cycle` |
| raw `UPDATE` making the root a child | **database** | REFUSED — `agent_workspace_nodes_root_no_parent_chk` |
| raw `INSERT` of a blank id | **NOTHING** | caught on read: `blank_id` |
| raw `INSERT` of a second root | **database** | REFUSED — `agent_workspace_nodes_one_root_idx` |
| raw `INSERT` with `nodeType='Root'` / `targetKind='Chat'` | **database** | REFUSED — both closed-domain CHECKs fire, so the two partial indexes stay total |
| raw `INSERT` naming a parent in another workspace | **database** | REFUSED — composite self-FK |

The DB's gaps are exactly the four the schema documents as the parse's territory, and each is
caught by the read. All forged rows were deleted and every workspace re-read `{ok:true}`.

### 2.5 The root

`move(root)` → `root_immutable` (*"the workspace has no outside"*); `bind(root)` → `root_immutable`
(*"shows nothing of its own"*); `resize(root)` → `root_immutable` (*"it is not a share of
anything"*); `destroy(root)` → accepted, `drop:[W,pa,pb]`, and that is the whole correction.

### 2.6 The re-parenting hazard — CLEAN

Swept the **108** changed non-test `.ts`/`.tsx` files. The only fallback operator on a `parentId`
assignment remains `workspace-node-placement.ts:291` — `command.parentId ?? root?.id`, the
documented `arrange` default, followed immediately by `no_root` and `unknown_parent` refusals and
with the moved ids filtered to `childrenOf`. **0 violations.**

### 2.7 Scope reduction — CLEAN

Over the same 108 files: `TODO`/`FIXME`/`XXX`/`HACK` **0**; `@ts-ignore`/`@ts-expect-error` **0**;
`.skip(`/`it.todo`/`xdescribe` **0**; empty `catch {}` **0**; ` as any` **2 files**, both the English
words *"as any other"* in prose; `as unknown as` **4 files**, all four verified **present verbatim on
`master`**; `eslint-disable` **2 files**, both `react-hooks/exhaustive-deps` and both verified
**present verbatim on `master`**.

---

# 3. THE PREMISE — one structure, counted

Verified against `pagespace_fa` after `0256` applied through the real migrator.

| | `audit-simplicity.md` | `sanity-verdict-2.md` | **now** |
|---|---|---|---|
| tables in the domain | 8 | 8 | **4** — `agent_workspaces`, `agent_workspace_shells`, `agent_workspace_nodes`, `agent_workspace_node_revs` |
| of which superseded | 4 | 4 | **0** |
| old-model source lines | 1,618 | 1,343 | **0 tracked** — `workspace-layout-verbs.ts`, `contract.ts`, `workspace-layout-wire.ts`, `workspace-layout-store.ts`, `workspace-layout-runtime.ts`, `agent-workspace-layout.ts`, `pane-labels.ts` all return **0** from `git ls-files` |
| files importing the old model | 26 | 19 | **0** — `git grep` for an actual `from '…'` of any of them returns nothing; every remaining textual mention is a comment naming what was deleted |
| `conversations.workspaceId` / `closedInWorkspaceAt` | present | present | **gone from the schema and from the live table** (`information_schema` count: 0) |
| the live authenticated writer (`workspace/verbs/`) | — | present | **gone** |

The one legacy artefact left is `scripts/lib/legacy-workspace-layout.ts` — **91 lines** the migration
declares for itself, imported only by `backfill-agent-workspace-nodes.ts`, with a header saying to
delete it with the script. That is correct: a migration's subject is the schema it migrates *from*.

**The claim is one structure, and the count supports it.**

---

# 4. BOARD vs GIT — no false completions

`pagespace tasks list gai93lz5cej7nw0zj0bwrmxe` plus the five child task-lists (reached through
`pagespace pages tree --drive omziyxp4skckh7ixi2sxzhuk`): **23 leaves, all `completed`, 100%.**
Three are titled DROPPED and are deliberate.

I checked every leaf against the diff. **No leaf marked completed lacks code.** The two that did not
match by filename both resolve:

- `wu6onc4d8ivp3x8rt8r1lnkj` *"hydrateFromServer no-op early-out"* — `hydrateFromServer` is a store
  method (`useAgentWorkspaceStore.ts:210`), not a file. Present.
- `lsiz4kdb5v7xaqv9bjyk7bfi` *"Owner-room broadcast with ownerId read inside the lock"* —
  `readWorkspaceOwnerId(tx, workspaceId)` at `workspace-node-runtime.ts:472`, inside the
  transaction. Present.

Two leaf **titles** are fossils (recorded, not counted as false completions):

- `rlxskz4ui7cwyzalivb0mjfm` *"Sidebar renders attached and detached nodes from the live store"* —
  a model with no detached nodes.
- `fiq4npgzyzo9bsauav5e0t17` *"useWorkspaceDirectoryLayoutListener"* — no such identifier ships. The
  work exists as `useWorkspaceNodesListener` and `useSessionDirectoryListener`. This is
  `sanity-2026-08-08-23`'s finding 3b, still live, and there are two of them rather than one.

One DROPPED reason is inverted: Phase 5 `z2z9e8kzi9isodhx5ivbti8r` and its leaf
`icnb2d01zfyzk6u2nu8dhv8g` are titled *"DROPPED (not built) — Drop shadow tables/columns/shim"* —
but the shadow tables and both shadow columns **were** dropped, by `0256`, in this PR. The board
records the epic's most destructive act as not built.

---

# 5. THE BACKFILL AND `0256`, END TO END

`pagespace_fa`: fresh database, migrated to **0255 only** (256 journal entries; both membership
columns and all four legacy tables present), seeded with eight workspaces — two production-shaped
grids, **a live pane bound to a dismissed thread** (`ws02`), **a live pane bound to a
history-deleted thread** (`ws03`), a pane on a hard-deleted thread (`ws04`), a terminal pane plus an
unplaced shell (`ws05`), cross-workspace pane contention between `ws01` and `ws06`, an **ENDED**
session still holding a pane and a thread (`ws07`), and a membership-only workspace with no pane
rows (`ws08`).

### The guard, before

```
ERROR:  Node backfill has not run on this database: 11 pane row(s) and 8 thread(s) have no node.
```

Correct: 12 panes less `ws07`'s, and 11 threads less the dismissed one, the inactive one and
`ws07`'s.

### THE CENSUS — verbatim

```
🌳 agent workspace node backfill — DRY RUN (nothing is written)
   8 conversation(s) with a resolved chat claim
   ws01: panes 3→3, threads 3, shells 0, members 4→4, seated 1, nodes 6 · chat_target_foreign,fractions_read_as_unsized
   ws02: panes 2→1 (1 not a member), threads 1, shells 0, members 1→1, seated 0, nodes 2 · chat_pane_not_a_member
   ws03: panes 2→1 (1 not a member), threads 1, shells 0, members 1→1, seated 0, nodes 2 · chat_pane_not_a_member,empty_column_dropped
   ws04: panes 1→0 (1 not a member), threads 0, shells 0, members 0→0, seated 0, nodes 1 · chat_pane_no_conversation,empty_column_dropped,empty_column_dropped
   ws05: panes 2→2, threads 0, shells 2, members 3→3, seated 1, nodes 5
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

  anomalies               : {"chat_target_foreign":1,"fractions_read_as_unsized":1,"chat_pane_not_a_member":2,"empty_column_dropped":3,"chat_pane_no_conversation":1}

✅ clean — every scanned workspace is accounted for; this was a DRY RUN
```

**`members in` = `pane nodes out` = 12, in the total and in every workspace individually.** No
workspace lost a member and none grew one. `ws07` (ENDED) was correctly never scanned. `--apply`
printed the identical census under an `(APPLIED)` banner and wrote **21 node rows + 7 rev rows**.
Every emitted row carried its own workspace's `rootId`, and all seven workspaces read back through
the production path (`nodesFromRows` → `validateTree`) as **`{ok: true}`**. `ws01`'s `p01c`, which
names `ws06`'s thread, landed **unbound** rather than stealing the binding; `ws04`'s grid is a bare
root; `c02dismissed` and `c03deleted` have **no node** and their live pane rows were not
materialised.

### The gate and idempotence (`pagespace_fa2`, same corpus plus a whitespace-id pane row)

```
dry run, one blank_id workspace   -> ⚠️ ws09 SKIPPED (blank_id) … ❌ NOT SAFE TO CUT OVER   exit 1
                                     totals IDENTICAL to the run without ws09 (members in 12, nodes out 21)
dry run, after repairing the id   -> ✅ clean                                               exit 0
--apply                           -> written 8, members in 13 = pane nodes out 13, 23 rows, 8 revs all at 0   exit 0
--apply again                     -> already migrated (skip) 8 · written 0 · 23 rows unchanged                exit 0
```

### The guard, after — and the real migrator

```
### 0256 PRE-FLIGHT on the CORRECTLY MIGRATED database:
DO                                                      ← PASSES

### the three by-design no-node cases, named:
      id      | workspaceId | isActive | closedInWorkspaceAt |       endedAt       | has_node
--------------+-------------+----------+---------------------+---------------------+----------
 c02dismissed | ws02        | t        | 2026-02-01 00:00:00 |                     | f
 c03deleted   | ws03        | f        |                     |                     | f
 c07          | ws07        | t        |                     | 2026-03-01 00:00:00 | f
 pane | workspaceId |       endedAt
------+-------------+---------------------
 p07  | ws07        | 2026-03-01 00:00:00

$ bun .pu-probe/migrate-to.ts packages/db/drizzle    (the real runMigrations, full journal)
  Applying: 287a861b... (1786285111169)
  done                                              ← exit 0
```

Post-cutover: **4 tables**, **0** membership columns, **257** journal rows, **21 node rows
preserved**.

**closing-verdict's BLOCKER is fixed.** All three cases it named — an ended workspace's pane, a
dismissed thread, an inactive thread — have no node by design and no longer trip the guard.

---

# 6. NEW FINDINGS — most severe first

## FINDING 1 — **MEDIUM**: `0256`'s operator instructions still carry the queries the blocker fix corrected, and they read non-zero on a correctly migrated database

`packages/db/drizzle/0256_dapper_groot.sql:41-52`

The fix to closing-verdict's blocker changed the **executable** `DO` block and left the
**human-readable** block above it untouched. Twenty lines above a guard that now scopes to live
workspaces and applies the membership predicate, the file still says:

```sql
-- BEFORE APPLYING THIS TO ANY DATABASE, CHECK THAT THE BACKFILL LANDED:
--
--   SELECT count(*) FROM agent_workspace_panes p
--    WHERE NOT EXISTS (SELECT 1 FROM agent_workspace_nodes n
--                       WHERE n."rootId" = p."workspaceId");
--   SELECT count(*) FROM conversations c
--    WHERE c."workspaceId" IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM agent_workspace_nodes n
--                       WHERE n."targetKind" = 'chat' AND n."targetId" = c.id);
--
-- Both must be 0. A non-zero count is a workspace, or a thread, whose only
-- record of itself is about to be dropped.
```

Those are, verbatim, the two predicates the blocker was about. Run on `pagespace_fa2` — 0255,
backfilled, the script's own gate reporting `✅ clean … 0256 may be applied`:

```
 orphan_panes_per_header      1
 orphan_threads_per_header    3
### the executable DO block on the SAME database:  DO   (passes)
```

**Failure scenario.** An operator prepares the cutover on a production snapshot. Step 2 of the
script's procedure exits 0; `--apply` exits 0 and prints *"0256 may be applied"*. Before the
irreversible step they do what the migration file tells them to do in capitals — run the two
queries — and read **1** and **3** against a sentence that says *"Both must be 0. A non-zero count is
a workspace, or a thread, whose only record of itself is about to be dropped."* The correct and
responsible response is to stop. The cutover stalls on a database that is in fact perfectly
migrated, and the operator now has two authorities in one file disagreeing about whether their data
is safe — with the wrong one being the part written for them and the right one being the part
written for the machine. The `DO` block's own comment even explains why the counting was wrong,
three lines below the comment that still counts that way.

This fails safe, and no data is at risk. It reproduces the previous audit's blocker in the half a
human reads. Fixing it is deleting or rewriting twelve lines of comment in a file that already
carries a documented, argued exception for exactly this block.

## FINDING 2 — **LOW (carried, third audit)**: the same header tells an operator the tool its procedure depends on has been deleted

`packages/db/drizzle/0256_dapper_groot.sql:31-32`

> *"(`scripts/backfill-agent-workspace-nodes.ts` at migration 0255, **now deleted with the tables it
> read**)"*

The script exists, runs, and is step 3 of the procedure this migration's step 5 depends on — I ran
it four times against two databases. Recorded by `pu-fix-backfill-highs.md` §8 and again by
`closing-verdict.md` #3. It is inside the same operator-facing block as finding 1.

## FINDING 3 — **LOW (carried, fourth audit)**: client and server apply `put`/`drop` in opposite orders, under a comment saying they do not

`workspace-node-algebra.ts:160` · `workspace-node-write.ts:188-190`

`applyNodeWrite` is `removeNodes(upsertNodes(nodes, put), drop)` — **put, then drop**.
`decideNodeWrite` computes `upsertNodes(removeNodes(nodes, drop), incoming)` — **drop, then
upsert** — under:

> *"Drop first, then upsert — a node is never in both, and this is `applyNodeWrite`'s order, so the
> tree judged here is exactly the tree the algebra would have produced."*

Driven with one id in both arrays:

```
client  applyNodeWrite  -> ["W"]        (pa removed)
server  decideNodeWrite -> ["W","pa"]   (pa kept)
```

The algebra emits no overlapping write, so the shipped client cannot produce one. The comment is the
dangerous half: `validateTree`'s own docblock anticipates *"a client that assembled its own nodes
never goes through the algebra's operations at all"*, and this comment tells the next maintainer the
two orders are interchangeable. One line of prose, unchanged across four audits.

## FINDING 4 — **LOW (carried, third audit)**: at exactly `MAX_NODES`, an eviction that nets zero growth is refused, with a message naming a count the write does not produce

`workspace-node-commands.ts:645`

The eviction path creates before it destroys, so the transient tree is one node over. Measured on a
workspace holding 2047 bound chat panes:

```
EVICT path (create-then-destroy, nets ZERO growth) -> max_nodes_exceeded: 2049 nodes; the cap is 2048
SPLIT path (genuinely +2)                          -> max_nodes_exceeded: 2050 nodes; the cap is 2048
```

Reachable only by deliberately filling a workspace. The split refusal is correct; the eviction one
is not, and the two are indistinguishable to the user.

## FINDING 5 — **LOW (carried, fifth audit)**: the lone-member share rule is load-bearing, argued at length, and unpinned

`packages/lib/src/agent-workspaces/workspace-node-backfill.ts:427`

`if (shares.length < 2) return shares.map(() => null);` weakened to `< 1`:

```
Test Files  19 passed (19)        Tests  610 passed (610)        Exited with code 0
```

**The mutation survives**, on the one module in this branch that runs once against real data and
gets no second chance. Fifth audit to say so. Every *other* rule in that module I mutated today is
genuinely pinned — 13 tests for the membership predicate, 1 for the exit gate's skip term.

## FINDING 6 — **LOW (carried, third audit)**: `bound_elsewhere` is an unreachable union member whose comment points at a live mechanism

`workspace-node-runtime.ts:168-172` · `agent-workspaces-runtime.ts:298`

`NodeWriteRefusal` still names `'bound_elsewhere'`, and `git grep` over `apps/web/src` and
`packages/lib/src` finds **no construction site** — only the declaration and consumer branches. The
two textual matches for `code: 'bound_elsewhere'` are a comment and a test comment, both describing
the catch that was **deleted**. `agent-workspaces-runtime.ts:298` (`if (result.code ===
'bound_elsewhere')`) can never be taken; the live path is `:308`, which maps `status: 'conflict'`
onto the outcome of the same name. The type's comment says the opposite of what the code does:

> *"`bound_elsewhere` is the one code no layer can produce: it comes from the table's global
> chat-target index, and only the database is in a position to know."*

The index path answers `conflict`, as I measured in §2.3.

## FINDING 7 — **LOW (carried)**: the epic page still states the superseded model seven times, and two client comments still spell "detached"

**(a)** `pagespace pages read gai93lz5cej7nw0zj0bwrmxe` — 515 lines, unchanged in this respect since
`sanity-verdict-2.md`. Exactly **7** copies each of `**Status**: 📋 PLANNED`, the `## Model` fence,
and these three now-false sentences, at lines 15, 146, 246, 334, 410, 460, 499:

```
A workspace owns one rooted tree plus zero or more detached nodes.
The root is the sole structural root: it cannot be detached, moved, bound, or destroyed.
Creation is atomic — attached or detached, never create-then-attach.
```

There are no detached nodes; the root **is** destroyed, by `destroy`, and that is the whole
correction. The artefact a reader grounds on describes the model this branch exists to have deleted.

**(b)** Two shipped comments still describe a state the model cannot spell:
`apps/web/src/stores/agent-workspace/workspace-tree-view.ts:7` and
`apps/web/src/components/agents/panes/SessionPanes.tsx:42` (*"The workspace's whole flat list —
attached and detached"*). The third one closing-verdict named is **fixed**.

## FINDING 8 — **LOW (carried)**: two root-minting conventions in production paths

`workspace-node-commands.ts:181` mints `id === workspaceId` (probed: `rootSeedFor('WS1').id ===
'WS1'`); `workspace-node-backfill.ts:761` mints `${workspaceId}::root`. Harmless — `rootOf` finds by
type — but an operator reading rows finds two conventions for one concept depending on whether the
workspace predates the cutover, and my seeded corpus shows both would coexist in one table.

## FINDING 9 — **LOW**: four shipped files still explain live rules by a column this PR drops

The `migration-types.ts` instance closing-verdict named is **fixed**. Four others still read as
present-tense fact about `conversations.workspaceId`, which `0256` drops in the same PR:

* `packages/db/src/schema/agent-workspace-nodes.ts:233-236` — the justification for **constraint 6**,
  the global chat-target index: *"a conversation belongs to exactly one workspace
  (`conversations.workspaceId`, set at creation and permanent)"*. This is the load-bearing one: the
  reason the index omits `rootId` is argued from a column that no longer exists.
* `packages/lib/src/agent-workspaces/workspace-node-validate.ts:497` and `:502` — the same argument,
  in the comment explaining why the validator can only settle half the rule.
* `packages/db/src/schema/agent-workspaces.ts:24` — *"`conversations.workspaceId` FKs here"*.
* `packages/lib/src/agent-workspaces/session-contract.ts:25` — *"`conversations.workspaceId` is the
  binding"*.

The rules these comments defend are all still correct; the reason given for them stopped being true
in this PR. Named because the model's own thesis is that membership is the node, and four files
still say it is the column.

---

# 7. GATES

| gate | result |
|---|---|
| `bun install` + `bun run build` | **exit 0** |
| **`bun run typecheck` (MONOREPO, after build)** | **exit 0 — 17/17, zero `error TS`** |
| **`bun run lint` (MONOREPO)** | **exit 0 — 15/15** |
| **`bun run --filter @pagespace/lib test -- src/agent-workspaces`** | **610 passed / 610**, 19 files, exit 0 |
| **`bun run --filter web test -- src/lib/agent-workspaces src/stores/agent-workspace src/components/agents/panes src/components/layout/left-sidebar`** | **507 passed / 507**, 35 files, exit 0 |
| **`bun run --filter web test` (FULL)** | **16745 passed \| 6 skipped**, 1127 files, **0 failed**, exit 0 |
| `bun run --filter realtime test` | **961 passed**, 25 files, exit 0 |
| **`cd scripts && bunx vitest run`** | **307 passed \| 14 skipped**, 15 files passed / 1 skipped, **exit 0** (was 1 failed) |
| **`tsc` over `scripts/backfill-agent-workspace-nodes.ts` + `lib/backfill-census.ts` + `lib/legacy-workspace-layout.ts` + `lib/tenant-export-columns.ts` + `lib/migration-types.ts`, by hand** | **1 error, the expected `import.meta.main` TS2339** — nothing else. 7 of 7 bun scripts in `scripts/` carry it |
| the backfill against a real pre-0256 database | dry **exit 1** with a skip, **exit 0** clean, `--apply` idempotent, `members in == pane nodes out` |
| **`0256` through the real migrator over a correctly backfilled database** | **exit 0** — closing-verdict's blocker closed |
| CI on the identical code tree (`bea23a7b2`) | **10/10 green**, including `ci / E2E (agent-session user stories)` |

`bun run typecheck` was run after a completed `bun run build`; a bare `--force` races
`web#typecheck` against `web#build` into `TS6053 .next/types/…`, which is the documented turbo edge
gap, not a branch defect.

---

# 8. VERDICT: **DRIFT FOUND**

I want to be exact about what that does and does not mean, because most of this report is a record
of things that are now right.

**What is genuinely fixed, verified by construction rather than by reading.** The correction the
epic turned on holds: a parentless non-root node is refused by the type, the row parse, the wire,
the algebra and the validator, with the one gap — the table — named, argued in the schema, and
contained by a read path that rejects rather than filters, which I confirmed by writing such a row
and watching the workspace become unreadable. `destroy` really is the one removal; I went looking
for a second and found only a referential cascade that removes workspaces, not nodes. The premise is
restored in full: four tables, zero superseded ones, zero old-model source lines, zero importers,
both membership columns gone from the live table. Every board leaf marked completed has code.

**And the two things that stopped the last two audits are closed, at the database.** Migration
`0256`'s executable pre-flight now counts what the derivation actually leaves behind: it refuses an
unmigrated database, passes a correctly-migrated one, and `0256` applies end to end through the real
migrator over a corpus containing every case that previously made it wrong. The tenant export
carries membership, with a spec, an export query, a validate query, a GDPR-coverage registration,
and a written exclusion for the revs table — and the repo's own ratchet is green. The close-row
regression is fixed on both halves of the seam, with the E2E green on the identical code tree and
unit coverage that I broke twice and watched go red six times.

**Why not CLEAN.** Finding 1. The fix to the blocker changed the guard and did not change the
instructions the guard was derived from, so `0256` now contains two pre-flight checks that disagree:
an executable one that is correct, and a written one — in capitals, addressed to the operator, in the
file governing an irreversible DDL with no down migration — that returns **1** and **3** where it
says *"Both must be 0"* and *"A non-zero count is a workspace, or a thread, whose only record of
itself is about to be dropped."* I measured both on the same database. This fails safe and risks no
data; what it costs is that a careful operator following the file's own procedure stops the cutover
on a database that is perfectly migrated, which is precisely the outcome the previous audit called a
blocker, surviving in the half a human reads. Finding 2 sits four lines above it and tells the same
operator the tool the procedure depends on has been deleted.

That is a twelve-line comment block, and it is the only thing between this branch and a clean
verdict.

**Findings 3–9 should not block.** Three of them are prose that will mislead someone and have now
survived three, four and five audits respectively: the `put`/`drop` comment, `bound_elsewhere`'s
docblock, and finding 9's four files arguing live constraints from a dropped column. Finding 5 is
one unwritten test on the one module that gets no second chance. Finding 7's epic page is the
artefact the next reader will ground on, and it still describes the model this work deleted.

Nothing here was merged, no PR was opened, and the board was not touched.

# Final verdict of record — the node-tree cutover

**Branch:** `pu/final-review` @ `28a3bbab4` (the whole epic, merged against current master).
**Scope:** the migration rehearsal (Part A) and an independent verdict on Phases 2–4 (Part B).
Nothing was implemented, nothing was fixed, nothing was merged, no PR was opened.

**Database.** The shared `pagespace_test` on `localhost:5433` is empty (0 tables), and two other
agents' databases (`pagespace_test_xws`, `pagespace_main_bf_flip_it`) are on the same server. I
created my own rather than touching either: **`pagespace_wnt_rehearsal`** (the seeded corpus) and
**`pagespace_wnt_control`** (pristine, migrations only — the control that proves the failing tests
below are branch defects and not my seed data). Both are on the test Postgres container. Nothing ran
against any non-test database.

---

# PART A — THE MIGRATION REHEARSAL

Migrations applied through `0255_boring_leo`. The corpus is 18 workspaces: the two
production-measured shapes from the deleted `annotate-conversation-panes.ts` docblock ("one workspace
had 3 threads and 2 panes, another had 10 threads and 4 panes"), plus one workspace per anomaly the
derivation's own `DerivationNoteCode` union enumerates, plus an ENDED workspace and a skip case.

## The census — dry run, per workspace

| workspace | shape under test | cols in | panes in | threads in | shells in | **members in** | **pane nodes out** | splits out | detached out | nodes out | anomalies |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|
| ws01 | **prod shape A** — 3 threads / 2 panes | 2 | 2 | 3 | 0 | **3** | **3** | 0 | 1 | 4 | — |
| ws02 | **prod shape B** — 10 threads / 4 panes | 2 | 4 | 10 | 0 | **10** | **10** | 1 | 6 | 12 | — |
| ws03 | a column holding no panes | 2 | 1 | 1 | 0 | **1** | **1** | 0 | 0 | 2 | `empty_column_dropped` |
| ws04 | a column id that collides with a pane id | 2 | 4 | 0 | 0 | **4** | **4** | 2 | 0 | 7 | `column_id_renamed` |
| ws05 | kind w/o id, id w/o kind, kind outside the domain | 1 | 3 | 1 | 0 | **4** | **4** | 1 | 1 | 6 | `pane_target_half_bound` ×2, `pane_target_unknown_kind` |
| ws06 | two panes of one workspace on one conversation | 1 | 2 | 1 | 0 | **2** | **2** | 1 | 0 | 4 | `chat_target_duplicated` |
| ws07 | owns `c07`, has no pane for it | 0 | 0 | 1 | 0 | **1** | **1** | 0 | 1 | 2 | — |
| ws08 | a pane naming ws07's conversation | 1 | 2 | 1 | 0 | **2** | **2** | 1 | 0 | 4 | `chat_target_foreign` |
| ws09 | panes bound to a DISMISSED and a DELETED thread | 1 | 2 | 1 | 0 | **3** | **3** | 1 | 1 | 5 | — (see finding 5) |
| ws10 | a pane naming a conversation with no row | 1 | 2 | 1 | 0 | **2** | **2** | 1 | 0 | 4 | `chat_target_missing_row` |
| ws11 | widths that don't sum to 1; mixed heights | 2 | 4 | 4 | 0 | **4** | **4** | 2 | 0 | 7 | `fractions_read_as_unsized` ×2 |
| ws12 | a whitespace-only pane id | 1 | 2 | 2 | 0 | **2** | **2** | — | — | — | **SKIPPED `blank_id`** |
| ws13 | membership only — no panes at all | 0 | 0 | 3 | 2 | **5** | **5** | 0 | 5 | 6 | — |
| ws14 | `orderIndex` gaps and ties | 2 | 3 | 3 | 0 | **3** | **3** | 1 | 0 | 5 | — |
| ws15 | a terminal pane + a shell with no pane | 1 | 2 | 1 | 2 | **3** | **3** | 1 | 1 | 5 | — |
| ws16 | **ENDED** | — | — | — | — | — | — | — | — | — | correctly never scanned |
| ws18 | contends for an unowned conversation (lower id) | 1 | 1 | 0 | 0 | **1** | **1** | 0 | 0 | 2 | — |
| ws19 | contends for the same one, and loses | 1 | 1 | 0 | 0 | **1** | **1** | 0 | 0 | 2 | `chat_target_foreign` |
| **TOTAL** | | | **35** | **33** | **4** | **51** | **51** | 12 | 16 | 81 | |

**`members in` = `pane nodes out` in every single workspace, and in the total.** No workspace lost a
member and none grew one. The one skip is reported, not silently dropped.

Anomaly totals: `{empty_column_dropped:1, column_id_renamed:1, pane_target_half_bound:2,
pane_target_unknown_kind:1, chat_target_duplicated:1, chat_target_foreign:2,
chat_target_missing_row:1, fractions_read_as_unsized:2}`; skips `{blank_id:1}`.

### The resumed run — the two codes only a second pass can reach

Reset, applied `--workspace ws18` alone (binding `c18` there), then moved `c18`'s ownership to ws19
and ran the full pass. ws19 came back
`members 1→1 · chat_target_already_bound, membership_claim_lost`, `membership dropped: 1`, and the
node stayed in ws18. A resumed run does not fight the index it half-filled. All ten
`DerivationNoteCode` values are now exercised against real rows.

## The three assertions the brief demanded

| assertion | method | result |
|---|---|---|
| every emitted node carries the `rootId` of the workspace it came from | SQL over all 77 written rows: rows whose `rootId` names no workspace = **0**; roots whose id ≠ `<rootId>::root` = **0**; distinct `rootId` = 16 | **PASS** |
| every derived tree passes `validateTree` | read all 77 rows back through the production path `nodesFromRows` → `validateTree` → `buildRenderTree`, per workspace | **PASS** — 16/16 valid, 0 orphaned nodes, 0 round-trip throws |
| a second run writes nothing new | `--apply` twice | **PASS** — second run: `already migrated (skip): 16`, `written: 0`, node count unchanged at 77 |

`ws12` correctly holds 0 node rows and its 2 legacy pane rows are untouched. `ws16` (ended) was never
scanned. Every migrated workspace is seeded at `rev 0` with its rev row present.

**Verdict on Part A: the derivation itself is sound.** It is the one part of this branch I would ship
as-is. Two consequences of the surrounding *procedure* are findings 5 and 6 below.

---

# PART B — THE VERDICT ON PHASES 2–4

## Gates, exact numbers

| gate | result |
|---|---|
| `bun run typecheck` | **FAIL — exit 2**, 3 × TS2339, all in `agent-workspaces-runtime.ts` |
| `bun run lint` | **FAIL — exit 1**; `web:build` dies on the same type error |
| `bun run --filter @pagespace/lib test -- src/agent-workspaces` | **682 passed / 682**, 21 files |
| `bun run --filter web test -- src/lib/agent-workspaces` (pristine control DB) | **9 failed / 208**, 4 files failed of 18 |

The web failures are **not** the documented worktree/DB quirk. They reproduce identically against a
pristine, freshly migrated database with no seeded rows, and two of the nine are in a fully-mocked
unit file that never opens a connection.

---

## FINDING 1 — BLOCKER: the branch does not typecheck, and does not lint

`apps/web/src/lib/agent-workspaces/agent-workspaces-runtime.ts:306`, `:545`, `:577`

```
error TS2339: Property 'changed' does not exist on type
  '{ status: "ok"; … changed: boolean } | { status: "conflict"; code: "target_already_shown"; … }'
```

`ApplyWorkspaceNodeWriteResult` gained a `conflict` member (`workspace-node-runtime.ts:186-198`). All
three membership call sites narrow away `refused` and `stale` and then read `.changed`, which the
`conflict` member does not carry. `bun run lint` fails too, because `web:build` runs as its
dependency and hits the same error.

**Failure scenario:** CI's typecheck and lint gates both fail on the branch as committed. This is not
a judgement call about severity — it is a red gate.

---

## FINDING 2 — HIGH: the unhandled `conflict` commits the ghost this epic exists to delete, and reports it as success

`apps/web/src/lib/agent-workspaces/agent-workspaces-runtime.ts:296-306` ·
`apps/web/src/lib/agent-workspaces/workspace-node-runtime.ts:402-408`

Finding 1's type error is not cosmetic; it is the compiler pointing at a live defect. Three separate
mistakes compound:

**(a) The conflict RETURNS from inside the transaction, after `within` has already written.**
`workspace-node-runtime.ts:377` throws its refusal, with an explicit comment saying why: *"Every
refusal above happens before `within` has written anything, so returning commits an empty
transaction. This one happens AFTER, so returning would commit `within`'s rows without the node that
makes them a member — the exact ghost this funnel exists to make unrepresentable."* The chat pre-flight
at `:406` sits **below** that line and **returns**. The transaction commits.

**(b) `admitConversationNode` reads `.changed` off a `conflict`.** It is `undefined`, so
`!result.changed` is true and the function answers **`already_a_member`** — which
`createConversationInSessionWith` treats as success and `claimConversationInSessionWith` maps to
`already_in_session`.

**(c) `applyWorkspaceMembershipWrite`'s `bound_elsewhere` mapping is dead code.**
`commitUnderLock`'s own backstop (`workspace-node-runtime.ts:455`) catches the chat-index violation
first and converts it to `conflict`, so the outer `isChatTargetConflict` catch at `:599` can never
fire. `NodeWriteRefusal`'s `bound_elsewhere` is unreachable, and so are
`admitConversationNode`'s and `claimConversationInSessionWith`'s branches for it.

### Proven against a real database

A temporary integration probe (written, run, deleted) drove `applyWorkspaceMembershipWrite` at a
workspace whose chat target is held by a node in another workspace, with a `within` that inserts the
conversation row:

```
conflict outcome status = conflict
admitConversationNode would answer = already_a_member
conversation rows committed = 1 | membership nodes in target workspace = 0
```

**A conversation row landed with no membership node, and the caller was told it succeeded.**

### The branch's own tests already say so, and they fail

| failing test | says |
|---|---|
| `agent-workspaces-runtime.integration.test.ts` › *a create refused because the thread is bound ELSEWHERE leaves no row behind either* | `promise resolved "undefined" instead of rejecting` — the create returned success |
| `agent-workspaces-runtime.integration.test.ts` › *two concurrent claims of ONE conversation into TWO workspaces: exactly one wins* | instrumented: `OUTCOMES ["claimed","already_in_session"]`. One node exists (the binding holds), but **the loser is told the thread is in ITS workspace** |
| `agent-workspaces-runtime.integration.test.ts` › *two concurrent calls for ONE never-bound conversation converge on ONE workspace* | they converged on two different workspaces |
| `workspace-node-runtime.test.ts` › *reports a chat-target unique violation as `bound_elsewhere`, not as a fault* | `expected 'conflict' to be 'refused'` — mechanism (c) |

**Failure scenario, in production terms.** Two tabs claim one thread into two workspaces at the same
instant. Workspace A wins. Workspace B's client is answered `already_in_session`, renders the thread
in B's sidebar, and every subsequent read disagrees with it. On the *create* path the same answer
additionally leaves a committed conversation row that belongs to no workspace — real history, member
of nothing, visible nowhere. That is the measured production symptom this epic was written to delete,
reintroduced at the chokepoint built to make it unrepresentable.

---

## FINDING 3 — HIGH: `listSessionConversationsBulk` throws on every call

`apps/web/src/lib/agent-workspaces/agent-workspaces-runtime.ts:931-977`

The subquery projects `agentWorkspaceNodes.id` **and** `conversations.id`, both aliased `"id"`; the
outer select then names `"id"` twice. Postgres:

```
error: column reference "id" is ambiguous   (SQLSTATE 42702)
```

This is not a race and not data-dependent — it fires on any non-empty `workspaceIds`. Reproduced on a
pristine database via `session-discovery-symmetry.integration.test.ts`.

**Failure scenario:** `GET /api/agent-workspaces` (`route.ts:123`) calls it inside a `Promise.all`
with no local catch, so the whole sessions listing route 500s and the agents sidebar renders nothing
for every user. The `list_sessions` agent tool (`session-tools-runtime.ts:496`) fails the same way.

(Adjacent, same block: the outer select drops `agentPageId`, and `conversationPageId(row)` at `:984`
is then handed a row without it. Masked today because the query dies first.)

---

## FINDING 4 — MEDIUM: four test files are stale against the epic's own decisions

Three of the nine failures assert `conversations.workspaceId` — the column Phase 4's own docblock says
"is no longer written by anything" (`agent-workspaces-runtime.ts:263`):

* `spawn-worker-global-session.integration.test.ts:95` and two siblings — `expected null to be '<workspaceId>'`.

One more asserts a `targets[]` entry of four keys where the code now emits five
(`agentPageId` was added):

* `workspace-node-runtime.test.ts` › *CARRIES THE TRUTH TO REBASE AGAINST* —
  `expected [ { id: 'conv-mine', …(4) } ] to deeply equal [ { id: 'conv-mine', …(3) } ]`.

These are not product defects, but they are red, and the first three mean the retirement of
`conversations.workspaceId` landed without anyone re-running the tests that assert it.

---

## FINDING 5 — MEDIUM: the backfill puts dismissed and history-deleted threads back **on screen**

`packages/lib/src/agent-workspaces/workspace-node-backfill.ts:518-576` (the pane path) vs `:654-677`
(the membership path)

The membership path is careful: a thread with `closedInWorkspaceAt` set is excluded, and the module
says why — *"materialising it as a detached node would reopen, for every user at once, every thread
they ever dismissed."* The **pane** path applies no such filter. It reads `agent_workspace_panes` and
binds whatever the row names.

On master, closing a listing stamps `closedInWorkspaceAt` and **nothing on the server removes the pane
row** (`app/api/agent-workspaces/[workspaceId]/conversations/[conversationId]/route.ts`; the pane close
is a separate, best-effort client write). So "a live pane row bound to a dismissed thread" is ordinary
production data. Same for a history-deleted thread whose pane outlived it.

**Evidence — ws09, straight out of the migrated table:**

```
      id       |  parentId  | nodeType | targetId  | isActive | closedInWorkspaceAt
 p09closed     | k09a       | pane     | c09closed | t        | 2026-02-01 00:00:00
 p09dead       | k09a       | pane     | c09dead   | f        |
```

Both are **attached** — not parked. Post-cutover, membership is the node, so:

* the thread the user dismissed is a member again, and is back on the grid rather than merely in the
  sidebar — strictly worse than the outcome the membership path refuses;
* the history-deleted thread is a permanent member. `expelConversationFromSession` is what removes a
  deleted thread's node, and it runs at deletion time — it will never run for a thread deleted before
  the cutover. The node holds a cap slot forever and renders a pane bound to nothing.

The one-line fix is available and cheap (pass the closed/inactive conversation ids into
`DeriveOptions` and read those panes as unbound, exactly as `chat_target_foreign` already does), which
is why this is worth blocking on: it is unrecoverable after the fact.

---

## FINDING 6 — MEDIUM: a SKIPPED workspace is invisible after cutover, and its threads become re-claimable

`scripts/backfill-agent-workspace-nodes.ts:38-45` (the production procedure) ·
`packages/lib/src/agent-workspaces/workspace-node-backfill.ts:44-48`

The backfill's contract for a workspace it cannot derive is *"REPORTED and left on the old tables,
which still work."* Step 4 of its own procedure then deploys the app image that reads nodes, at which
point the old tables do **not** still work. Measured against the migrated database:

```
ws12: rev=0 nodes=0                     ← the skipped workspace
ws12 legacy pane rows still present: 2
findWorkspaceOfChat(c12a) = null
findWorkspaceOfChat(c12b) = null
findWorkspaceOfChat(c01a) = ws01        ← a migrated one, for contrast
```

`GET /api/agent-workspaces` returns `nodes: []` for it and `AgentsSidebar.tsx:159` seats exactly that,
so the user sees an empty workspace. Worse, `findWorkspaceOfChat` returning `null` means
`claimConversationInSessionWith`'s `if (home !== null) return 'not_found'` guard passes: every thread
in a skipped workspace can be claimed into a **different** workspace — the rebind the model declares
impossible ("moving a thread elsewhere is a FORK, never a rebind"). And on first interaction
`seedRoot` mints a root, after which `loadAlreadyMigrated` treats the workspace as migrated and no
later run will ever revisit it.

**Reachability is not theoretical.** The legacy wire validates pane ids with `z.string().min(1)`
(`contract.ts:147,170,183`), which accepts `'   '`; `validateTree` uses `trim()`. Any authenticated
client can post a whitespace pane id today and permanently opt its workspace out of the migration.
That is exactly what ws12 does, and `blank_id` is the only skip code I could find that is reachable
from legacy data at all — every other one is closed by the FK, the id allocator, or
`settleGroupShares`.

---

## FINDING 7 — LOW: the client and the server apply `put`/`drop` in opposite orders, and a comment says they don't

`packages/lib/src/agent-workspaces/workspace-node-write.ts:189-191` ·
`packages/lib/src/agent-workspaces/workspace-node-algebra.ts:152` ·
`apps/web/src/stores/agent-workspace/node-writes.ts:166`

`applyNodeWrite` is `removeNodes(upsertNodes(...))` — **put, then drop** — and the client reduces its
pending queue through it. `decideNodeWrite` computes `upsertNodes(removeNodes(nodes, drop), incoming)`
— **drop, then upsert** — under a comment asserting *"this is `applyNodeWrite`'s order, so the tree
judged here is exactly the tree the algebra would have produced."* It is not: for a payload naming one
id in both `put` and `drop`, the client removes the node and the server keeps it (`persistedWrite`'s
own doc acknowledges "put wins").

**Failure scenario:** the algebra never emits an overlapping write, so the shipped client cannot
produce one — but the wire primitive is `put(nodes[])`, and `validateTree`'s docblock explicitly
anticipates *"a client that assembled its own nodes never goes through the algebra's operations at
all."* Such a caller diverges from the server silently. The comment is the more dangerous half: it
tells the next maintainer the two orders are interchangeable.

---

## FINDING 8 — LOW: the run's headline totals count workspaces that were never written

`scripts/backfill-agent-workspace-nodes.ts:427-433`

`recordCensus` runs **before** the skip check, and a skipped derivation carries a fully populated
census with an empty `rows`. In my rehearsal the report printed `total nodes out: 81` against 77 rows
actually written, and `pane nodes out: 51` against 49. The operator's only summary of an irreversible
run overstates it, and the process exit code (`:550`) is computed from the same conflated pair.

---

## FINDING 9 — LOW: the lone-member share rule is documented, load-bearing, and untested

`packages/lib/src/agent-workspaces/workspace-node-backfill.ts:353`

`if (shares.length < 2) return shares.map(() => null)` is the mutation that **survived**. Weakening it
to `< 1` leaves all 682 lib tests green, and it is behaviourally observable: a single-column workspace
whose stored `widthFraction` is 1.0 derives `fraction: 1` instead of the unsized node the rule
requires (verified directly — see the mutation table). The docblock argues the rule at length ("a
container that looked sized would make the next arrival rebalance against a number nobody chose") and
nothing pins it. On a module that runs once, that is the wrong place to have a hole.

---

## FINDING 10 — LOW: two root-minting conventions

`workspace-node-commands.ts:176-178` mints the root with `id === workspaceId`; the backfill
(`workspace-node-backfill.ts:581`) mints `${workspaceId}::root`. Harmless — `rootOf` finds by type,
never by id — but an operator reading rows will find two conventions for one concept depending on
whether the workspace predates the cutover. Relatedly, `admit`'s `newRootId` branch
(`workspace-membership.ts:212-224`) is unreachable in production: `commitUnderLock` runs `seedRoot`
before every producer, so a root always exists by the time `admit` sees the tree.

---

## The four checks that came back CLEAN

**The re-parenting hazard — 0 violations.** Across the 63 changed non-test source files: **217**
`parentId` lines, **78** assignment or declaration sites, **2** using a fallback operator, **0**
violations.

* `workspace-node-placement.ts:282` — `command.parentId ?? root?.id`. The documented default for
  `arrange`; the root is found by `rootOf` (by type), a rootless workspace **refuses** (`no_root`), and
  the ids moved are filtered to `childrenOf`, so nothing foreign can be dragged in. Cleared by the
  Phase 1 review and re-checked here.
* `useAgentWorkspaceStore.ts:787` — `root?.id ?? ''` in `gridSlotFor`, new in Phase 4 and therefore
  not covered by the earlier review. The sentinel is deliberately a parent `move` will not find, so
  the outcome is a refusal, not a relocation. The comment says so. **Not a violation** — though a
  refusal spelled as a sentinel string is the one place in this epic where the "refuse, never repair"
  rule is expressed by a value rather than by a branch.

Every other site is a READ (`node.parentId`, `container.parentId`), a comparison, or the success-path
collapse promotion. `parentId: null` sites are closing a pane or parking a member, which the model
defines as a location.

**The cascade — correct, against a real database.** Persisted `R → s1 → { s2 → {a,b}, c }`, ran
`move(c → R)`, applied the decision through `writeWorkspaceNodes` (which deletes first, then upserts):

```
persist.put = c,s2,b,a | drop = s1
after       = R,a,b,c,s2      a.parentId=s2   b.parentId=s2   s2.parentId=R
```

`a` and `b` were rescued into the upsert by `persistedWrite` and survived the `ON DELETE CASCADE`.
Mutation M6 confirms the rescue is what does it.

**The ghost guard — the refusal path is correct.** A membership write whose node write is refused
before `within` leaves **no** conversation row (verified at the database). It is only the
post-`within` conflict return that leaks — finding 2.

**Scope reduction, purity, `any`, vocabulary.** Across the changed source: **0** `any`, **0**
`@ts-ignore`/`@ts-expect-error`, **0** `eslint-disable`, **0** TODO/FIXME/"for now"/"out of scope",
**0** empty catch blocks, **0** authored `.skip`/`it.todo`. No `attach`/`detach` **operation** exists
anywhere — `move` is the only thing that changes a location, and "detached" is used as a state. The
one wobble is the boolean parameter named `attach` on the membership surface
(`workspace-membership.ts:161`, `claim-conversation-in-workspace.ts:94`,
`create-conversation-in-workspace.ts:149`): it names a placement, and the docblocks argue for it
explicitly, but a state-shaped name (`parked`) would keep the verb out of the API. Recorded as an
observation, not a defect.

---

## Are the tests real? — the mutation table

Ten mutations across seven modules, each run against the full `@pagespace/lib` agent-workspaces suite
(baseline **682 passed / 682**). Every file was restored after each run.

| # | module | mutation | tests killed | scoped to its own behaviour? |
|---|---|---|--:|---|
| M1 | `workspace-node-validate.ts` | neuter the `fraction_not_finite` sweep | **5** | yes — all five are the NaN/Infinity tests, incl. the parked-pane and ordering ones |
| M2 | `workspace-node-validate.ts` | neuter `duplicate_chat_target` | **3** | yes — the two validator tests + the write-path one |
| M3 | `workspace-node.ts` | `rootOf` finds "the node with no parent" instead of by `nodeType` | **8** | yes — every one names the hazard (`should find the root by its type, not by its null parent`) |
| M4 | `workspace-node-algebra.ts` | `isSlot` drops `Number.isInteger` | **1** | yes — exactly `should refuse a fractional index` |
| M5 | `workspace-node-rows.ts` | absence of a fraction becomes an explicit `undefined` key | **10** | yes — the absence-preservation set, incl. both round-trip properties |
| M6 | `workspace-node-write.ts` | remove the cascade rescue | **2** | yes — both `THE CASCADE` tests, nothing else |
| **M7** | `workspace-node-backfill.ts` | a lone member keeps its stored share (`< 2` → `< 1`) | **0** | **SURVIVED — finding 9** |
| M8 | `workspace-node-backfill.ts` | remove first-placement-wins for a duplicated chat target | **4** | yes — the duplicate test plus the three census tests that assert one node per member |
| M9 | `workspace-membership.ts` | `dismiss` becomes a `destroy` | **3** | yes — all three `dismiss` tests |
| M10 | `workspace-node-commands.ts` | `closePane` re-parents to the root instead of parking | **6** | yes — all six `closePane` tests |

M7's survival was confirmed behaviourally, not inferred: with the mutation, a single column of
`widthFraction: 1.0` derives `split fraction: 1` where the branch derives `null` and notes
`fractions_read_as_unsized`.

Nine of ten mutations died, and every death was confined to tests named for the mutated behaviour —
no collateral, no suite-wide collapse. **The lib suite is real.** The web suite is a different story:
it is 9 tests red, and four of those nine are the tests that would have caught finding 2.

---

# VERDICT: **DO NOT SHIP**

The migration derivation is genuinely good work and the rehearsal exonerates it: 51 members in, 51
pane nodes out, every tree valid, every node correctly scoped, idempotent on the second pass, and ten
of ten anomaly classes handled deliberately. The re-parenting hazard is closed, the cascade holds
against a real database, and the lib suite survives mutation.

The client plane is not shippable. What has to change:

1. **Finding 1** — make the branch typecheck and lint. Three call sites, one file. Non-negotiable: it
   is a red CI gate.
2. **Finding 2** — the chat-target conflict must **throw** (like the ACL refusal five lines above it),
   not return, so `within`'s rows unwind; and `admitConversationNode` must handle `conflict`
   explicitly rather than falling into `already_a_member`. Then re-run
   `agent-workspaces-runtime.integration.test.ts` — the branch's own tests for the ghost and the claim
   race already encode the right answer and currently fail.
3. **Finding 3** — alias the two `id` columns in `listSessionConversationsBulk` (and restore
   `agentPageId` to the outer select). The sessions-list route is down for every user without it.
4. **Finding 4** — update the four stale tests, or delete the assertions on the retired
   `conversations.workspaceId`. Do not merge with them red; they are the reason findings 2 and 3
   reached this review at all.
5. **Finding 5** — filter dismissed and history-deleted conversations out of the backfill's **pane**
   path, as the membership path already does. This is the only item on the list that cannot be fixed
   after the fact.
6. **Finding 6** — before running `--apply` in production, run it dry and require the skip count to be
   **zero**, or accept and document that a skipped workspace goes dark and its threads become
   re-claimable. The script's stated fallback ("left on the old tables, which still work") is not true
   after step 4 of its own procedure.

Findings 7–10 are follow-ups and should not block. In particular, finding 9's uncovered rule is worth
a single test on the one module in this branch that gets no second chance.

---

*Reproduction: `scripts/.rehearsal/` (seed SQL, the round-trip verifier, the mutation harness) is
deliberately NOT committed — it is scratch. The seeded corpus lives in `pagespace_wnt_rehearsal` and
the control in `pagespace_wnt_control` on the local test Postgres; both are mine and both are
disposable.*

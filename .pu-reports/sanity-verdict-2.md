# Sanity verdict 2 — after the one-removal correction

**Auditor only.** Nothing implemented, nothing fixed, nothing merged, no PR opened, board untouched.

**Audited:** this worktree's HEAD `377362cc5` on `pu/sanity2`. `origin/pu/workspace-node-model`
(`e2927a406`) is exactly this tree plus one master merge whose 8 files are all CLI/MCP-settings and
touch nothing in this epic — so auditing HEAD is auditing the base branch's content. Merge-base with
`master` is `968e7be76`; `origin/master` has since moved to `f97118a78`.

**Method.** Every claim below was produced by running the code or the gate, not by reading a report.
Runtime probes were written into `.pu-probe/`, run, and deleted. A fresh database
(`pagespace_sv2`, plus `pagespace_sv2_admin`) was created on the shared test Postgres and migrated
through `0255_boring_leo` rather than reusing `pagespace_test` or any other agent's database.

---

# Gates — exact numbers

Worktree needed `bun install`; `bun run build` was run to completion **before** `bun run typecheck`,
because `web#typecheck` has no turbo edge to `web#build` and a forced run races it into a wall of
`TS6053 .next/types/... not found`. That race is what a bare `--force` produces and it is not a
failure; sequenced, the gate is clean.

| gate | result |
|---|---|
| `bun run build` | **exit 0** |
| `bun run typecheck` (MONOREPO, after build) | **exit 0** — 17/17 tasks, **0** `error TS` |
| `bun run lint` (MONOREPO) | **exit 0** — 15/15 |
| `bun run --filter @pagespace/lib lint` | **exit 0** |
| `bun run --filter @pagespace/lib test -- src/agent-workspaces` | **695 passed / 695**, 22 files, exit 0 |
| `bun run --filter @pagespace/lib test` (full) | **9339 passed**, 6 skipped, **1 suite fails to set up** — see below |
| `bun run --filter web test -- src/lib/agent-workspaces` | **221 passed / 221**, 19 files, exit 0 |
| `bun run --filter web test` (FULL web suite) | **16797 passed \| 6 skipped (16803)**, 1130 files, **0 failed**, exit 0 |
| `bun run --filter realtime test` | **961 passed**, 25 files, exit 0 |
| `bun run knip:check` | green — see below |
| `scripts/backfill-agent-workspace-nodes.ts` under `tsc` | **3 real errors** — finding 1 |

**The one red lib suite is environmental and untouched by this branch.**
`src/compliance/erasure/__tests__/gdpr-eraser.integration.test.ts` fails first for an unset
`ADMIN_DATABASE_URL` and then, once a migrated admin database is provided, on
`DROP ROLE admin_app` — the role owns objects in another checkout's database on the same shared
container. `git diff $(merge-base)...HEAD` does not touch `compliance/erasure` at all.

**knip is green.** It reported 4 new issues (`apps/{android,ios}/**/cordova*.js`), all
gitignored Capacitor assets generated at 08:55:54 by the `bun run build` above. Moved aside and
re-run: `[ok] knip: 4 issue(s), all within baseline (4)`, exit 0; then restored. CI's knip step runs
in the `lint` job, which never runs `bun run build`, so nothing reaches those files there.

Working tree was clean before this report was written and is clean after it, apart from this file.

---

# FINDING 1 — HIGH: the backfill's operator report prints `NaN`, and no gate in this repo can see it

`scripts/backfill-agent-workspace-nodes.ts:488`, `:499`, `:501` ·
`packages/lib/src/agent-workspaces/workspace-node-backfill.ts:268`

The one-removal correction renamed the census field: `.pu-reports/pu-one-removal.md:95` says so in
as many words — *"`WorkspaceCensus.detachedOut` → `seatedOut`"*. The lib was renamed. **The script
was not.** Three call sites still read `census.detachedOut`, a property that no longer exists.

Run against the real derivation:

```
census keys: workspaceId,columnsIn,panesIn,conversationsIn,shellsIn,membersIn,nodesOut,
             paneNodesOut,splitNodesOut,seatedOut,boundChatNodesOut,unboundPaneNodesOut,
             membershipDropped
census.seatedOut   = 1
census.detachedOut = undefined
script totals.detachedOut after one workspace = NaN
script censusLine "panes in→out"              = 2→NaN
```

**Failure scenario.** An operator runs the dry pass before an irreversible one-shot migration over
every workspace in production. Every per-workspace line reads
`ws01: panes 2→NaN, threads 1, shells 0, members 3→3, detached NaN, nodes 4`, and the summary reads
`of which detached : NaN`. Step 2 of the script's own procedure is *"Run this DRY and read the
census"* — the census is the only thing standing between a bad derivation and production, and two of
its fields are unreadable. (The process exit code and the `❌ DEFECT` check read `membersIn` and
`paneNodesOut`, which are real, so the run still exits correctly; it is the human-facing readout that
is destroyed.)

**Why nothing caught it, and this is the more important half.** `bun run typecheck` is 17/17 green
and `bun run lint` is 15/15 green with this defect in the tree, because **`scripts/` is inside no
typecheck project at all**. The root `tsconfig.json` has `"include": ["types/**/*"]`; no app or
package tsconfig includes `scripts`. Compiled directly against the repo's own compiler options:

```
scripts/backfill-agent-workspace-nodes.ts(488,32): error TS2339: Property 'detachedOut' does not exist on type 'WorkspaceCensus'.
scripts/backfill-agent-workspace-nodes.ts(499,64): error TS2339: ... same
scripts/backfill-agent-workspace-nodes.ts(501,61): error TS2339: ... same
```

`bun run lint:scripts` passes (eslint there is not type-aware) and is not wired into CI either —
`.github/workflows/ci.yml:352-361` runs `lint`, `typecheck`, `knip:check` and nothing else. No test
file anywhere references `backfill-agent-workspace-nodes`, and `vitest.workspace.ts` declares no
`scripts` project, so `scripts/__tests__` is not in the default run.

This is precisely the class the brief names — *"a package-scoped typecheck is how a live ghost bug
reached this branch"* — reappearing one level out, on the one module in this epic that runs once
against real data.

---

# FINDING 2 — HIGH (carried, unchanged): the backfill puts dismissed and history-deleted threads back on screen

`scripts/backfill-agent-workspace-nodes.ts:213-226` (the pane load) vs `:232-245` (the membership
load) · `packages/lib/src/agent-workspaces/workspace-node-backfill.ts:533-591`

`final-verdict.md` finding 5, re-tested: **still live, and not narrowed.**

The membership query is careful and says why —
`eq(conversations.isActive, true), isNull(conversations.closedInWorkspaceAt)` at `:242-243`, under a
comment reading *"A thread the user dismissed is deliberately NOT a member — materialising it as a
detached node would reopen every thread everyone ever closed."* The **pane** query at `:226` selects
`agentWorkspacePanes` with `inArray(workspaceId, workspaceIds)` and **no filter whatsoever**.
`DeriveOptions` (`workspace-node-backfill.ts:455-466`) carries `chatClaims`,
`claimedChatTargets` and `knownConversationIds` — and still no closed/inactive set. The binding
loop's only reaction to an unknown conversation is `note('chat_target_missing_row', …)` followed by
*"Reported, and then carried anyway"* (`:557-563`).

**Failure scenario.** On master, closing a listing stamps `closedInWorkspaceAt` and nothing on the
server removes the pane row, so "a live pane row bound to a dismissed thread" is ordinary production
data. Post-cutover, membership *is* the node, so at the moment of migration every such thread becomes
a member again **and is attached to the grid** — strictly worse than the sidebar-only reappearance
the membership path refuses. A history-deleted thread's pane becomes a permanent member holding a cap
slot: `expelConversationFromSession` is what removes a deleted thread's node and it runs at deletion
time, so it will never run for anything deleted before the cutover.

This remains the only item on the list that cannot be fixed after the fact.

---

# FINDING 3 — MEDIUM-HIGH (carried): a SKIPPED workspace goes dark, its threads become re-claimable, and the skip is still reachable from an authenticated client

`scripts/backfill-agent-workspace-nodes.ts:38-45` · `workspace-node-backfill.ts:48-50` ·
`apps/web/src/lib/agent-workspaces/claim-conversation-in-workspace.ts:126` ·
`apps/web/src/app/api/agent-workspaces/[workspaceId]/workspace/verbs/route.ts`

`final-verdict.md` finding 6, re-tested: **still live in all three parts.**

**(a) The stated fallback is still untrue.** `workspace-node-backfill.ts:49-50` still promises a
non-derivable workspace is *"REPORTED and left on the old tables, which still work."* Step 4 of the
script's own procedure then deploys the app image that reads nodes, after which the old tables do not
work: the sidebar's listing (`listSessionConversationsBulk`) joins `agentWorkspaceNodes` and nothing
falls back. Procedure step 2 now reads *"Any workspace reported as SKIPPED is one a human looks at
before cutover"* — softer wording, but still **no zero-skip gate**, and after finding 1 the census a
human is told to read is partly `NaN`.

**(b) The re-claim hole is open.** `claim-conversation-in-workspace.ts:117-126` reads
`home = findWorkspaceOfConversation(...)` — which is now purely a node lookup
(`agent-workspaces-runtime.ts:372`) — and passes when `home === null`. A skipped workspace has no
nodes, so every thread in it reads as a member of nothing and can be claimed into a **different**
workspace. That is the rebind the model declares impossible ("moving a thread elsewhere is a FORK,
never a rebind").

**(c) Reachability confirmed at runtime.** The legacy verb route is still mounted and still writes
pane rows, and its schema takes whitespace ids that `validateTree`'s `trim()` later refuses:

```
ensure:      accepted whitespace ids -> true
split_right: accepted whitespace ids -> true
split_down:  accepted whitespace ids -> true
```

and the derivation's answer to such a row:

```
backfill skipped -> {"code":"blank_id","detail":"a node carries a blank id; ..."}
rows written -> 0
```

Any authenticated caller with access to a not-yet-migrated workspace can therefore opt it out of the
migration permanently, before the run happens.

---

# FINDING 4 — MEDIUM: the branch still carries three structures, and the third one is a LIVE writer

`packages/db/src/schema/agent-workspace-layout.ts:66,86,117,125` ·
`packages/lib/src/agent-workspaces/workspace-layout-verbs.ts` ·
`apps/web/src/app/api/agent-workspaces/[workspaceId]/workspace/verbs/route.ts:92`

`audit-simplicity.md` finding 1, counted fresh against today's tree.

| | `audit-simplicity.md` | **now** |
|---|---|---|
| tables in this domain | 8 | **8** (verified in the migrated DB) |
| of which superseded | 4 | **4** — `agent_workspace_pane_columns`, `agent_workspace_panes`, `agent_workspace_layout_revs`, `agent_workspace_layout_ops` |
| old-model layout lines | 1,618 (`workspace-layout-verbs.ts` + `contract.ts`) | **1,300** for the same pair (1,173 + 127), **1,343** counting `workspace-layout-wire.ts` (43) |
| files importing the old model | 26 | **19** (10 non-test source files import `workspace-layout-verbs`; 3 import `agent-workspaces/contract`) |
| `conversations.workspaceId` / `closedInWorkspaceAt` | present | **still present** (`schema/conversations.ts:30,90`) |

**No deletion is in flight.** The 318-line drop is the `contract.ts` split (`7f0ce69df`), which moved
shells and session-lifecycle concerns out into `shells-contract.ts` (274) and `session-contract.ts`
(123) — step 2 of `audit-simplicity.md`'s revised order. **Step 1 has not happened**: the new model
still reaches backwards for `FRACTION_EPSILON` / `readFraction` at five sites
(`workspace-node-validate.ts:65`, `workspace-node-algebra.ts:51`, `workspace-node-write.ts:43`,
`workspace-node-backfill.ts:56`, `services/agent-workspaces/workspace-node-store.ts:39`). The latest
migration is `0255`, additive; no drop migration exists.

**What is new since that audit, and it is worse than a count.** The third structure is not inert.
`POST /api/agent-workspaces/[workspaceId]/workspace/verbs` is mounted, authenticated, gated and
calls `applyWorkspaceLayoutVerb`, which writes `agent_workspace_panes` /
`agent_workspace_pane_columns` / `agent_workspace_layout_revs`. **No shipped client posts to it** —
grepping `apps/web/src` finds the route and a 410 message and nothing else. So the branch ships a
live authenticated writer to a structure nothing reads. `closedInWorkspaceAt` is the mirror image: no
writer remains (only selects in `conversation-rev.ts:56` and `global-conversation-repository.ts:47`),
so the column is a read-only shadow of a fact that has moved.

---

# FINDING 5 — MEDIUM (carried): the run's totals count workspaces that were never written

`scripts/backfill-agent-workspace-nodes.ts:427` vs `:429`

`final-verdict.md` finding 8, re-tested: **still live**, and now compounded by finding 1.
`recordCensus(totals, derived)` at `:427` runs **before** `if (derived.skipped !== null)` at `:429`.
A skipped derivation still carries a fully populated census with an empty `rows`. Measured directly
on a `blank_id` workspace:

```
rows written -> 0    census.membersIn -> 2    census.paneNodesOut -> 2    census.nodesOut -> 4
```

Every one of those four numbers is added to the run's headline totals for a workspace that wrote
nothing. The `❌ DEFECT` check and the process exit code (`:536`) are computed from the same
conflated `membersIn` / `paneNodesOut` pair, so a skip inflates both sides symmetrically and hides
itself from the one automated assertion the script makes.

---

# FINDING 6 — MEDIUM: the epic page states the SUPERSEDED model, seven times over

`pagespace pages read gai93lz5cej7nw0zj0bwrmxe` — 515 lines.

`sanity-verdict-1.md` finding 6 recorded the spec appearing **twice**. It now appears **seven**
times: seven `**Status**: 📋 PLANNED` blocks, seven copies of the `## Model` fence, seven copies of
the five-phase Delivery section that the `# DELIVERY CHANGED — one cutover PR, not five` section at
line 104 supersedes. The duplication is growing with each pass over the page.

The substance matters more than the repetition. Every copy of the Model block still reads:

```
A workspace owns one rooted tree plus zero or more detached nodes.        (lines 15, 146, 246, 334, 410, 460, 499)
The root is the sole structural root: it cannot be detached, moved, bound, or destroyed.   (18, 149, 249, 337, 413, 463, 502)
Creation is atomic — attached or detached, never create-then-attach.       (20, 151, 251, 339, 415, 465, …)
```

All three are now false. There are no detached nodes; the root **is** destroyed, by `destroy`, and
that is the whole correction; and `create` has no detached mint. The epic page — the artefact a
reader grounds on — describes the model this branch exists to have deleted, and says nothing about
the correction. Board leaf `rlxskz4ui7cwyzalivb0mjfm` carries the same fossil in its title:
*"Sidebar renders attached and detached nodes from the live store."*

---

# FINDING 7 — LOW (carried): the client and the server apply `put`/`drop` in opposite orders, and a comment says they do not

`packages/lib/src/agent-workspaces/workspace-node-algebra.ts:161` ·
`packages/lib/src/agent-workspaces/workspace-node-write.ts:194-196`

`final-verdict.md` finding 7, re-tested at runtime. `applyNodeWrite` is
`removeNodes(upsertNodes(nodes, put), drop)` — put, then drop. `decideNodeWrite` computes
`upsertNodes(removeNodes(nodes, drop), incoming)` — drop, then upsert — under a comment reading
*"Drop first, then upsert — a node is never in both, and this is `applyNodeWrite`'s order, so the
tree judged here is exactly the tree the algebra would have produced."*

Driven with one id in both `put` and `drop`:

```
client applyNodeWrite  -> ids: ws1,pa
server decideNodeWrite -> ok   ws1,pa,pb
```

The client removes the node; the server keeps it. The algebra never emits such a write, so the
shipped client cannot produce one — but the wire primitive is `put(nodes[])`, and
`validateTree`'s own docblock anticipates *"a client that assembled its own nodes never goes through
the algebra's operations at all."* The comment is the dangerous half: it tells the next maintainer
the two orders are interchangeable, and they are not.

---

# FINDING 8 — LOW (carried): the lone-member share rule is documented, load-bearing, and still unpinned

`packages/lib/src/agent-workspaces/workspace-node-backfill.ts:367`

`final-verdict.md` finding 9, re-mutated against today's suite. `if (shares.length < 2) return
shares.map(() => null);` weakened to `< 1`:

```
Test Files  22 passed (22)
Tests  695 passed (695)     Exited with code 0
```

**The mutation still survives.** File restored, tree verified clean. The docblock above it argues
the rule at length (*"a container that looked sized would make the next arrival rebalance against a
number nobody chose"*) and nothing holds it. Same module as findings 1, 2 and 5 — the one that gets
no second chance.

---

# FINDING 9 — LOW (carried): three root-minting conventions, one of them in unreachable code

`packages/lib/src/agent-workspaces/workspace-node-commands.ts:181` ·
`packages/lib/src/agent-workspaces/workspace-node-backfill.ts:596` ·
`packages/lib/src/agent-workspaces/workspace-membership.ts:255-264`

`final-verdict.md` finding 10, re-tested. `rootSeedFor` mints `id === workspaceId`; the backfill
mints `${workspaceId}::root`. Harmless — `rootOf` finds by type — but an operator reading rows finds
two conventions for one concept depending on whether the workspace predates the cutover.

The second half is confirmed unreachable and adds a third convention if it ever runs. `admit`'s
rootless branch works when called directly:

```
admit([]) -> {"ok":true,"write":{"put":[{"nodeType":"root","id":"r1",...},{"nodeType":"pane","id":"n1","parentId":"r1",...}]}}
```

— it mints the root as `newRootId`, a `createId()`. But `applyWorkspaceMembershipWrite` goes through
`commitUnderLock`, whose `seed` flag defaults to `true` and is passed `false` by exactly one caller
(`destroyWorkspaceTree`), so `seedRoot` has always minted a root before `admit` sees the tree. The
branch cannot fire in production.

---

# FINDING 10 — LOW (new, a residue of the finding-2 fix): `bound_elsewhere` is now dead code, and its docblock asserts the opposite

`apps/web/src/lib/agent-workspaces/workspace-node-runtime.ts:168-172` ·
`apps/web/src/lib/agent-workspaces/agent-workspaces-runtime.ts:297`, `:566` ·
`apps/web/src/lib/agent-workspaces/claim-conversation-in-workspace.ts:160`

The correct fix to `final-verdict.md` finding 2 moved the chat-index conflict onto the `conflict`
channel and deleted the local `try/catch` that produced `{status:'refused', code:'bound_elsewhere'}`
— `applyWorkspaceMembershipWrite`'s docblock (`:682-691`) explains why that catch was dead. But the
code was left in the union: `NodeWriteRefusal` still names `'bound_elsewhere'`, and grepping the
whole of `apps/web/src` and `packages/lib/src` finds **no construction site** — only the type
declaration and three consumer branches that can never be taken.

The type's own comment now says the opposite of what the code does: *"`bound_elsewhere` is the one
code no layer can produce: it comes from the table's global chat-target index."* The index path
answers `status: 'conflict'` today (`workspace-node-runtime.ts:455`, `:484-486`, `:511-516`), which
`admitConversationNode:307` maps to `'bound_elsewhere'` correctly. A dead union member with a
comment pointing at a live mechanism is how the last one of these went unnoticed for a whole phase.

---

# FINDING 11 — LOW (carried): the backfill cluster still has no committed report

`.pu-reports/README.md` makes a committed report the completion signal for every cluster, and
`sanity-verdict-1.md` finding 5 recorded the backfill — ~1,400 lines, the epic's own "one genuinely
irreversible act" — as the gap. `.pu-reports/` now holds 13 files; **none is titled for the
backfill**, and none takes it as its subject. The migration rehearsal that would close this exists,
but it is Part A of `final-verdict.md` on the unmerged `pu/final-review` branch (`52675890f`), so it
is not on the branch the cutover would ship, and this audit had to `git show` it out of another ref
to read it at all.

---

# FINDING 12 — LOW: residual `detached` vocabulary in shipped client comments

`apps/web/src/stores/agent-workspace/workspace-tree-view.ts:7` —
*"…a detached node, a target with no resolved title, an empty grid…"* ·
`apps/web/src/components/agents/panes/SessionPanes.tsx:42` —
*"The workspace's whole flat list — attached and detached."*

Two live comments in the client plane still describe a state the model cannot spell. Every other
occurrence of the word in this domain is deliberate history ("an earlier cut called it detached"),
and the epic has an explicit vocabulary rule; these two read as current fact.

---

# The four things the brief asked to be PROBED — results

## 1. Is the parentless-pane class gone? **Yes. Every path refuses, and no path is unguarded.**

Constructed at runtime, one attempt per entry point:

| path | mechanism that catches it | answer |
|---|---|---|
| `nodeFromRow` — pane row, `parentId: null` | **row parse** (`workspace-node-rows.ts:183`, `z.string().min(1)`) | REFUSED — `expected string, received null` |
| `nodeFromRow` — split row, `parentId: null` | **row parse** (`:149`) | REFUSED |
| `nodesFromRows` — one such row in a valid set | **row parse**, whole set | REFUSED — rejects, never filters |
| `create({parentId: null})` | **algebra** — `findNode(nodes, null)` resolves nothing | `unknown_parent`: *no node "null" to create "pb" in* |
| `move({parentId: null})` | **algebra** | `unknown_parent`: *no node "null" to move "pa" into* |
| wire `put: [{nodeType:'pane', parentId: null}]` | **wire schema** (`workspace-node-wire.ts:104`) | REFUSED — `put.0.parentId: expected string, received null` |
| `decideNodeWrite` handed a forged parentless pane (bypassing the wire) | **validator** | `invalid` / `null_parent` |
| in-memory forged set through `validateTree` | **validator** (`:275-282`) | `null_parent` |
| wire `parentId: "   "` (whitespace survives `min(1)`) | wire ACCEPTS; **validator** catches | `dangling_parent` — correct: it resolves to nothing |

**No path where none catches.** The three layers are genuinely independent — the type makes it
unspellable for constructed nodes, the parse re-establishes it for rows, and `validateTree` states it
for a set a client assembled. The backfill validates before emitting rows
(`workspace-node-backfill.ts:776-778`), and the read path goes through `nodesFromRows`
(`workspace-node-store.ts:166`), so `rowFromNode` — which is total and validates nothing — is never
handed an unvalidated node. `root_immutable` survives on exactly `move`, `bind`, `resize` and nowhere
else, verified by call.

## 2. Is there ONE removal? **Yes, in the tree. Proven through the same function.**

```
destroy(root) -> {"ok":true,"write":{"put":[],"drop":["ws1","pa","pb"]}}
destroy(pane) -> {"ok":true,"write":{"put":[{"nodeType":"pane","id":"pb","parentId":"ws1","position":0,...}],"drop":["pa"]}}
```

One `destroy`, one target argument, root and leaf answered the same way — the root path returning an
empty node set, which `validateTree` accepts first (`:181`).

**The search for a second removal came back clean.** Everything that removes anything composes this
one function:

- `closePane` → `compile([destroy])` (`workspace-node-commands.ts:391`). It refuses the root
  (`root_immutable`) and a split (`not_a_pane`) — that is a **command asserting its own subject**, not
  a second mechanism; the removal it performs is `destroy`.
- `expel` → `compile([destroy])` (`workspace-membership.ts:300`). `dismiss` is gone; the word survives
  only in the docblock explaining its deletion.
- `expelConversationFromSession` → `applyWorkspaceMembershipWrite(run: expel)`.
- `destroyWorkspaceTree` → `commitUnderLock(seed:false, produce: destroy(rootOf(nodes).id))`
  (`workspace-node-runtime.ts:654`). **One caller: `endSession`.**
- Exactly one `db.delete(agentWorkspaceNodes)` in the whole tree
  (`workspace-node-store.ts:332`), driven by `decision.persist.drop`.
- No `DELETE` route touches nodes. The four `DELETE`s under `api/agent-workspaces` are the session,
  a shell, a conversation, and files.

**The `endedAt` stamp is not a second removal, and it is not reachable another way.**
`endAgentSession` has exactly **one** caller in the repo — `endSession`
(`agent-workspaces-runtime.ts:1163`) — which then calls `destroyWorkspaceTree`. Every other
`applyStamps` touching `endedAt` **clears** it (`reopenEndedSessionListing:386`,
`agent-workspace-sprite.ts:366` with `cas:{endedAt:null}`); the orphan reconciler only
`stampSpriteTornDown`. No writer stamps `closedInWorkspaceAt` any more.

**Verdict: two removals reconciled by convention is gone.** What remains is a documented ORDER
(lifecycle, then tree) between two facts about two different things, with the interrupted state
argued in both directions at `agent-workspaces-runtime.ts:1139-1158` and the tree write deliberately
best-effort. That is a composition, not a second removal.

## 3. The eight open `final-verdict.md` findings, re-tested against today's code

| # | verdict-1/final-verdict claim | today | evidence |
|---|---|---|---|
| 1 | BLOCKER — 3 × TS2339, branch does not typecheck or lint | **FIXED** | `bun run typecheck` exit 0, 0 `error TS`; `bun run lint` exit 0 |
| 2 | HIGH — unhandled `conflict` commits the ghost and reports success | **FIXED** | conflict now **throws** `NodeWriteConflicted` inside the transaction (`workspace-node-runtime.ts:455`) and is re-formed outside the rollback (`:484-486`); `admitConversationNode:307` handles `conflict` explicitly. The four tests that encoded the right answer now pass (see #4) |
| 3 | HIGH — `listSessionConversationsBulk` throws `id is ambiguous` on every call | **FIXED** | both columns explicitly aliased (`agent-workspaces-runtime.ts:929-930`), with the postmortem in the comment; the DB-backed suites run green against a fresh migrated DB |
| 4 | MEDIUM — four stale test files, 9 web failures | **FIXED** | full web suite **16797 passed / 0 failed**, including `spawn-worker-global-session.integration.test.ts` and `workspace-node-runtime.test.ts` |
| 5 | MEDIUM — backfill re-opens dismissed/deleted threads via the pane path | **STILL LIVE** | finding 2 above |
| 6 | MEDIUM — a SKIPPED workspace goes dark; its threads become re-claimable | **STILL LIVE** | finding 3 above, all three parts re-probed |
| 7 | LOW — `put`/`drop` order divergence, with a comment denying it | **STILL LIVE** | finding 7 above, reproduced at runtime |
| 8 | LOW — headline totals count workspaces never written | **STILL LIVE**, worsened | finding 5 above, and finding 1 makes two of the printed fields `NaN` |
| 9 | LOW — lone-member share rule untested | **STILL LIVE** | finding 8 above, mutation re-run and survived |
| 10 | LOW — two root-minting conventions; `admit`'s `newRootId` unreachable | **STILL LIVE** | finding 9 above |

Also re-tested from `sanity-verdict-1.md`: its **finding 2** (cross-workspace bind surfacing as a
502) is **FIXED** — `WorkspaceNodeConflictResponse` exists on the wire and the route answers 409 with
a rebase body (`nodes/route.ts:146-152`), delivered by the `pu-fix-xws` cluster. Its **finding 3**
(a completed changelog leaf with no code) is **FIXED** — `CHANGELOG.md` is modified on the branch with
a `Changed` entry that says *"Closing the last pane no longer ends your session"* in as many words.
Its **finding 5** (missing backfill report) is **still live** — finding 11 above. Its **finding 6**
(page duplication) is **worse** — finding 6 above.

## 4. The re-parenting hazard — the count

Swept the **80** changed non-test `.ts`/`.tsx` source files (`git diff $(merge-base)...HEAD`):

- **186** lines mentioning `parentId`
- **76** assignment-or-declaration matches (including type members, zod schema fields and function
  parameters)
- **1** using a fallback operator on an assignment
- **0** failure-path assignments — **0 violations**

The single fallback is `apps/web/src/lib/agent-workspaces/workspace-node-placement.ts:291`,
`const parentId = command.parentId ?? root?.id`, unchanged in character from the two previous reviews:
the documented default for `arrange`, the root found by `rootOf` (by type), a rootless workspace
refusing with `no_root` at `:292-294`, an unresolvable parent refusing at `:295-297`, and the ids
moved filtered to `childrenOf` at `:298`, so nothing foreign can be dragged in.

**One thing changed for the better since `final-verdict.md`.** Its second cleared site,
`useAgentWorkspaceStore.ts:787` — `root?.id ?? ''` in `gridSlotFor`, the one place the "refuse, never
repair" rule was expressed by a sentinel value rather than a branch — **no longer exists**;
`gridSlotFor` is gone from the store. `useAgentWorkspaceStore.ts:1009` `const parentId =
node.parentId` in `unbindPane` is a READ, feeding a `create`-then-`destroy` pair at the same parent.
Every remaining site is a read, a comparison, `parentId: null` on a root, or
`workspace-node-algebra.ts:583`'s collapse promotion, which is a success path putting the survivor
where its container was.

## 5. Board vs git — no false completions

`pagespace tasks list gai93lz5cej7nw0zj0bwrmxe` and the five child task-lists: **23 leaves, all
`completed`, 100%.** Three are titled DROPPED (`rjeb2gzf4t3zp448xt5wtp3u`,
`npssn6wuea85dfh12pjc5md7`, `gse5njjzrqf93n3m6mcycgzw`) and are deliberate. Spot-checked the leaves
most likely to be empty:

- `klbc4gfdudclarqzj5lj30x4` "Changelog and memory capture" — **has code.** `CHANGELOG.md` is `M` on
  the branch with `Fixed`, `Changed` and `Added` entries, including the one user-visible behaviour
  change. This is `sanity-verdict-1.md` finding 3, closed.
- `gxv4kkfq511ndrazak46jzty` "Delete pane-labels.ts" — **has code.** `D
  apps/web/src/stores/agent-workspace/pane-labels.ts` and its test.
- `dpyypkfsqlysk6qys444ll2d` "Delete claim, close, reopen and annotate" — **has code.** `D
  apps/web/src/lib/agent-workspaces/annotate-conversation-panes.ts` and its test; claim/close/reopen
  rewritten onto the membership chokepoint.

**No leaf marked completed lacks code.** The only board drift is vocabulary:
`rlxskz4ui7cwyzalivb0mjfm` is titled *"Sidebar renders attached and detached nodes from the live
store"* for a model with no detached nodes — recorded in finding 6, not counted as a false
completion.

---

# What the correction actually achieved

Stated plainly, because most of this report is about what is left. The two corrections landed and
they landed properly:

- **`parentId` is a `string` on every non-root node**, and the class of bug is closed at three
  independent layers with no path between them, verified by construction rather than by reading.
- **`destroy` is the one removal**, and every removal in the epic — closing a pane, closing a thread,
  history-deletion's membership half, ending a session — is that function with a different argument.
  `dismiss` is gone, the never-empty guard is gone, and the lifecycle stamp is composed in a
  documented order rather than reconciled by convention.
- **The three blockers from `final-verdict.md` are genuinely fixed**, not worked around: the branch
  typechecks and lints monorepo-wide, the post-`within` conflict now throws so the transaction
  unwinds, and the sessions listing runs. 16797 web tests and 9339 lib tests pass, and the four tests
  that encoded the ghost and the claim race are green.

---

# VERDICT: **DRIFT FOUND**

The model is now what the brief says it should be, and the gates are green — which is why the drift
that remains is worth naming precisely rather than filing under "known".

The one that would cost the most is **finding 1**: the correction renamed a census field, the lib
followed, the script did not, and the operator's only readout of a one-shot irreversible migration
prints `NaN` — with a green monorepo typecheck, a green lint and a green knip, because `scripts/` is
inside no typecheck project and no test suite. That is the same shape as the defect this correction
was written to fix, one level further out.

**Findings 2 and 3** are the pre-cutover items: a backfill that puts dismissed and history-deleted
threads back on the grid (unrecoverable after the fact), and a skip path that is still reachable from
an authenticated client and still leaves a workspace dark with its threads re-claimable.

**Finding 4** is the epic's own premise: three structures, four superseded tables, ~1,343 lines of the
old model, and — new since `audit-simplicity.md` — a live authenticated route writing rows nothing
reads.

Findings 5–12 are follow-ups.

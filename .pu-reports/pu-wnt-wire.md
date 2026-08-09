# pu-wnt-wire — the server side of the node cutover

Branch `pu/wnt-wire`. Three board leaves, one cluster: the atomic read, the
`put`/`drop` route, and the agent tools that drive them.

**Status: all three leaves complete.** Not opened as a PR, not merged.

---

## LEAF 1 — the atomic snapshot read

**What I built.** `packages/lib/src/services/agent-workspaces/workspace-node-store.ts`
— `readWorkspaceNodeSnapshots(executor, workspaceIds)` returns
`Map<workspaceId, {rev, nodes}>` from **one statement**:

```sql
SELECT COALESCE(r."rootId", n."rootId") AS "workspaceId", COALESCE(r."rev", 0) AS "rev", n.*
  FROM (SELECT * FROM agent_workspace_node_revs WHERE "rootId" IN (…)) r
  FULL OUTER JOIN (SELECT * FROM agent_workspace_nodes WHERE "rootId" IN (…)) n
    ON n."rootId" = r."rootId"
```

`readWorkspaceNodeSnapshot(executor, id)` is that call with a one-element list.
There is no `currentRev` and no `getWorkspaceGrid`: the store has **two**
functions (read, write) where `workspace-layout-store.ts` had six. `findOp` /
`recordOp` went with the table they read.

**Two deviations from the prompt's SQL, both deliberate:**

1. **`FULL OUTER JOIN`, not `LEFT JOIN` from revs.** Driving from the revs table
   alone makes a workspace with node rows and **no rev row** read as *empty* —
   the epic's own headline symptom arriving from the other side. Nothing in the
   write path can produce that state (the rev is minted in the transaction that
   writes the rows), but a Phase-5 backfill can, and "there is nothing here"
   about a workspace full of panes is the worst available failure. The two
   filtered subqueries keep it to two index scans rather than a join across the
   whole table; I rendered the SQL through drizzle's `PgDialect` to confirm the
   interpolation is valid Postgres.
2. **`lastMessageAt` is joined in the per-viewer target resolution**, not in this
   statement. It is authorized by exactly the gate the title already passes, and
   putting it in the structural read would mean either a second authorization
   pass or an unauthorized column on the broadcast wire.

**Fraction handling.** Stored `real` values go through `readFraction` — THE
funnel, shared with the write's change detector. Without one shared
quantization every re-send of a sized tree looks like a change, bumps a rev and
broadcasts. A stored `0` or `Infinity` reads as *unsized* rather than as a node
the validator must reject.

**How I verified it.**
`packages/lib/src/services/agent-workspaces/__tests__/workspace-node-store.test.ts`.
The concurrency test uses a fake database that commits a pending write **after
each statement returns** and records the tree at every rev. The assertion is
`nodes === history[rev]` — **exactly**, not `≤` — plus a blunt
`statementCount() === 1`. A reader that issues two statements straddles a commit
and cannot satisfy the first assertion in either order. That is the whole point
of the leaf, and mutation #1 below is the proof.

Also pinned: every workspace *asked for* gets an entry (so "never written" and
"you did not ask" are different answers), the `bigint` rev arriving as a string
is coerced at the parse, two workspaces with the same client-minted node id stay
apart, and a row whose `nodeType` is outside the CHECK constraint's domain
**rejects the whole read** rather than being dropped.

---

## LEAF 2 — the `put`/`drop` route

**What I built.**

- `packages/lib/src/agent-workspaces/workspace-node-wire.ts` — the request/response
  schemas. `{baseRev, put, drop}`, strict, `.finite()` fractions, `fraction`
  optional-never-null.
- `packages/lib/src/agent-workspaces/workspace-node-write.ts` — `decideNodeWrite`,
  the pure decision. Scope → rev → validity-of-the-applied-result → change.
- `apps/web/src/app/api/agent-workspaces/[workspaceId]/nodes/route.ts` — `POST`
  (and a `GET`, added because otherwise the one read is unreachable over HTTP and
  a client could only learn the tree from a 409).
- `apps/web/src/lib/agent-workspaces/workspace-node-runtime.ts` — one locked write
  funnel shared by the route and the agent tools.

**The promises, and where each is kept:**

| Promise | Where |
|---|---|
| 200 `{rev, nodes, targets}`; 409 same body | route; the 409 goes through the same per-viewer resolution, and a test asserts the two bodies are equal |
| Replay is a no-op **by construction** | `upsertNodes` + change detection. No `opId` anywhere; the route 400s on an unknown top-level field, so a client sending one out of habit learns it is not a guarantee |
| Reject the ENTIRE write on a foreign `rootId` | `decideNodeWrite` check 1, **before** the rev check |
| `validateTree` on the applied result, never repair | `decideNodeWrite` check 3 |
| Keep the advisory lock and rev-minting transaction | `withWorkspaceLayoutLock` is **imported** from the old store, not re-cut — so a node write and a legacy verb write for one workspace serialize against *each other* for the migration window |
| Keep `authorizePaneScope`'s second gate | `introducedPaneTargets` + `authorizePaneTargets`, run inside the lock |

**The `rootId` question.** A `WorkspaceNode` carries no workspace — that is what
makes cross-workspace parenting unspellable. So the wire node carries `rootId`
**optionally**, and a disagreement refuses the whole write. Accepting-and-ignoring
would be worse than either refusing or obeying, because the client would then
believe it had moved something. `nodeOfWire` is where the field stops; the row's
workspace comes from `rowFromNode(node, workspaceId)`'s parameter, so even an
unchecked payload could not write into another session — but the *client* would
be lied to, which is the actual failure.

**The gate runs on INTRODUCED bindings only, and this is a change from the verb
route.** A verb named the one target it was binding. A node payload does not:
a plain resize re-sends every affected pane *with* its existing target. Gating on
"every target in the payload" would mean a viewer who lost access to one page
could no longer move, resize, **or close** any pane in their own workspace —
closing is a `put` with `parentId: null`, so the trap has no exit. Containment is
the rule that keeps the gate honest without building the trap: a `(kind, id)`
already held by a node in this workspace is not being introduced, and it passed
this gate when it arrived. It is computed against the tree the **lock** read, not
a lock-free pre-read, because between an unlocked read and the write another
client can remove the node holding a target — turning a re-send into an
introduction the gate already waved through. The cost is a few permission queries
inside the per-workspace advisory lock; the alternative is a race whose payoff is
exactly the disclosure the gate exists to stop.

**`targets[]`** is `{id, kind, title, lastMessageAt}`, resolved and redacted once
per viewer, riding **beside** the tree. Same three per-kind rules as
`resolvePaneLabels`, ported: chat needs containment-or-`canAccessConversation`
then `redactConversationTitleForViewer`; terminal needs containment; page needs
its own ACL. A target that fails its gate has **no entry**, so refusing to
resolve is indistinguishable from "gone". The broadcast
(`workspace:nodes-updated`) is structural — tree and rev, no titles — because
`session:<id>` is a room and per-viewer redaction is not expressible on that wire.

---

## LEAF 3 — server-resolved commands for the agent tools

**What I built.** `apps/web/src/lib/agent-workspaces/workspace-node-placement.ts`
replaces `workspace-placement.ts` (deleted, with its two suites, replaced by
`workspace-node-placement.test.ts`).

- `placePagePaneForConversation` → `openPage` with `preferSplit: true` and
  `excludeTargetId: <invoking conversation>`.
- `placeWorkerPane` → `openConversation`, same two flags.
- `layoutCommand({resize|move|arrange})` → `resize` / `move` / composed `move`s.

**Policy is ported, not reinvented** — `workspace-node-commands.ts`'s `open`
already carries `resolveOpenPlacement`'s rules; this module supplies the two
flags and nothing else. Pinned in tests: fills an unbound pane, splits rather
than evicts, never gives up a running shell, never eats its own invoker, leaves
an already-open target alone.

**Atomicity.** `compile` (previously private in the commands layer) is now
exported so `arrange_panes` is *one* write for N moves — no intermediate order
is ever published, and a refused step leaves the layout untouched. That is a
one-word change to a merged file with no behaviour change; the alternative was a
second composer beside it.

**Two things retired, and both by construction rather than by convention:**

- **The rebase loop.** `MAX_PLACEMENT_ATTEMPTS` existed because the old helper
  read a rev, computed a verb against it, POSTed, and could be told the rev had
  moved. `applyWorkspaceNodeCommand` resolves the command against the tree the
  lock read, so `baseRev` *is* `rev` and there is nothing to rebase onto.
- **The `opId`.** Placement is idempotent by POLICY: `open` leaves a target
  already on screen where it is and returns an empty write.

**The ACL gate on the acting user is kept, twice and deliberately.**
`placePagePaneForConversation` checks page access itself (and logs *which* page
was named — a prompt-injection attempt is exactly what an operator needs in a
log), and the write funnel's gate checks it again uniformly and says nothing.

**A layout write stays best-effort**: both placement entry points swallow and
log; only the rearrange tools report.

### The tool surface moved to the node vocabulary

This is the largest judgement call in the leaf, so it is stated plainly.
`list_panes`/`resize_pane`/`move_pane`/`arrange_panes` addressed a `columnId` +
a `paneId`. There is no column any more. I considered keeping the old wire and
projecting the tree back into columns; that is **lossy the moment a split
nests**, and lossy in exactly the direction that makes a rearrange address the
wrong rectangle. So there is one address now — a `nodeId` — `list_panes` returns
the flat list (including parked panes, a state the old wire could not spell), and
`toParentId: null` is how a pane is closed. `session-tools-schema.test.ts`'s
frozen wire contract is re-pinned with that reasoning written into it.

---

## The illegal inputs, and what each returns

Enumerated before writing, each tested. ✔ = a test fails if the behaviour changes.

| Input | Answer | ✔ |
|---|---|---|
| a `put` node whose `rootId` is another workspace | `foreign_scope` → **400**, entire write refused | ✔ |
| …and its `baseRev` is *also* stale | still 400 — the scope check is **first**, so it is never invited to rebase | ✔ |
| `drop` naming a node that does not exist | **200**, no-op, no rev bump — this is what a REPLAY looks like, so refusing it would break the wire's own promise | ✔ |
| a `put` that orphans a subtree (drops a container, keeps its children) | `dangling_parent` → **400**, nothing written, **nothing re-parented** | ✔ |
| a `put` naming a parent that never existed | `dangling_parent` → **400** | ✔ |
| `baseRev` **ahead** of the server | **409** + truth. A rev nobody minted is as unable to describe the stored tree as one that fell behind; `>=` would let its arithmetic through | ✔ |
| a payload that empties the tree entirely | `no_root` → **400**. An *empty grid* (a root holding nothing) is legal and accepted | ✔ |
| an id naming two nodes in one `put` | `duplicate_id` → **400** (`upsertNodes` appends both, so the collision reaches the validator instead of being deduplicated into whichever half a `Map` kept) | ✔ |
| a `put` adding a second root | **400** (`unreachable` — the fixed violation order settles reachability first) | ✔ |
| non-finite `fraction` (`1e999` → `Infinity` through `JSON.parse`) | **400** at the wire schema; `fraction_not_finite` at the validator if it ever arrives another way | ✔ |
| explicit `fraction: null` | **400** — absence is the state, and `{}` vs `{fraction: null}` makes every later write look like a change | ✔ |
| a `targets[]` entry the viewer may not read | **no entry** — indistinguishable from "gone", so the read is not an existence oracle | ✔ |
| a target the caller may not BIND | **403**, uniform across forbidden and non-existent | ✔ |
| a binding the workspace **already holds**, re-sent | **not gated** — see the trap above | ✔ |
| a conversation the payload would show twice | `duplicate_chat_target` → **400** (the same page in two panes is allowed) | ✔ |
| a pane carrying an `axis`; a split carrying a `target`; a half-bound pane; a root claiming a parent; a detached split | **400** at the wire schema | ✔ |
| an unknown top-level field (`opId`) | **400** — silently accepting it would let a client believe a guarantee nothing provides | ✔ |
| a stored `nodeType` outside the CHECK domain | the whole **read** rejects, rather than dropping the row | ✔ |
| `move` to an out-of-range slot | refused (`invalid_index`), never clamped | ✔ |
| `arrange` naming an id that is not a child of that container | **skipped** — a deliberate model-ergonomics decision at the command layer, not the algebra clamping | ✔ |

### Two the prompt did not name, found while writing

**1. A node in both `put` and `drop`.** `applyNodeWrite` is drop-then-upsert, so
the node survives ("put wins"). The DELETE must therefore *not* name it, or the
cascade takes its children while the validated tree still holds them. Resolved by
deriving the drop set from `ids(nodes) \ ids(next)` rather than from the payload.

**2. Node rows with no rev row.** See LEAF 1's `FULL OUTER JOIN`.

---

## THE CASCADE — and the review's mid-flight finding

The review's message arrived while I was writing the decision layer; I had hit
the same wall from the storage side. Both descriptions are of one bug.

`agent_workspace_nodes`' composite self-FK is `ON DELETE CASCADE`. The algebra's
collapse (`collapseInto`, reached from `move` and `destroy`) emits
`drop: [container], put: [survivor-with-new-parent]` — and if the survivor is
itself a container, **its** children never moved, so they are correctly absent
from `put`. A drop-first write cascades them away and the upsert cannot bring
them back, because it never named them. The write reports success and the next
read comes back short. The review's shape — `R → s1 → { s2 → {a,b}, c }`, move
`c` up — is the test case, verbatim, in `workspace-node-write.test.ts`.

**I did not take the prescribed fix, and the argument is below rather than
compliance.**

### Why not put-first-then-drop

Upserting before deleting closes the cascade hole and opens a different one. The
table carries `UNIQUE (targetId) WHERE targetKind = 'chat'` — **global**, not
per-workspace. A perfectly legitimate payload ("close this pane, open the
conversation in a fresh node") drops node X holding chat C and puts node Y
holding chat C. `validateTree` accepts the result (one node per conversation),
but under put-first **both rows exist for the length of the transaction** and the
index refuses immediately. `agent_workspace_nodes_one_root_idx` has the same
shape. Put-first trades a silent data-loss bug for a loud but wrong rejection on
a legal write.

### What I did instead — delete-first, with the cascade closure rescued

`persistedWrite` computes, in the **old** tree, the descendants of every removed
node, and adds every one of them that survives into `next` to the upsert. The
DELETE takes them; the single multi-row UPSERT puts them straight back,
unchanged, in the same statement as their re-parented ancestor. Properties:

- **Complete by construction.** Every node in `next` is either changed (already
  in `put`), or unchanged and not beneath a removed node (its row survives), or
  unchanged and beneath one (rescued). There is no fourth case.
- **It relocates nothing.** A test asserts the rescued nodes come back with the
  same parent, slot and share they had. A rescue exists to make the database
  agree with the tree, never to move anything — which is the same rule as "never
  repair", applied to storage.
- **Nothing is resurrected.** A subtree genuinely being destroyed is in `removed`,
  so it is not in `next`, so it is not rescued. Tested.

### The `put` ordering concern

Already handled, and for exactly the stated reason. The upsert is **one
multi-row statement**: Postgres evaluates FK triggers at end of statement, so a
child and its parent may appear in any order within it. I rendered the generated
SQL with a child listed *before* its parent to confirm it. A row-at-a-time writer
would need a topological sort; the module doc says so, so the next person to
"simplify" it into a loop has been told.

### Should the FK be `DEFERRABLE INITIALLY DEFERRED`?

**No — and not out of caution.** Four reasons:

1. **It does not remove the ordering question, it moves it.** The two
   unique *indexes* cannot be deferred (only unique *constraints* can), so the
   chat-target and single-root orderings stay load-bearing either way. Deferring
   the FK would make one of three orderings free and leave the other two, which
   is worse than having one rule.
2. **It makes every other transaction's errors worse.** A deferred constraint
   fires at COMMIT, with no statement context. An unrelated bug elsewhere in this
   table would surface as a commit-time violation naming nothing useful.
3. **The write is one place.** Correctness bought at one call site with a tested
   closure is cheaper and more auditable than correctness bought by making a
   constraint lax for every writer that will ever touch the table.
4. **It is not my schema to change.** Migration 0255 is merged; the prompt scopes
   me out of table changes, and a constraint semantics change riding along with a
   route is exactly the kind of thing that should be its own decision with its own
   migration.

I would revisit (1) if the two partial unique indexes were ever promoted to
deferrable constraints — at that point deferring all three together *would* make
ordering genuinely non-load-bearing, and the argument flips.

---

## Mutation table

Each mutation applied to the source, suites re-run, then reverted.

| Mutation | What it killed |
|---|---|
| Split the atomic read into two statements (rev, then nodes) | `workspace-node-store.test.ts` — **2 tests**. The read returned rev 1 with post-write nodes: a pair the workspace was never in. `expected ['pane-new','root'] to deeply equal ['root']` |
| Remove the cross-workspace `rootId` rejection | `workspace-node-write.test.ts` — **2 tests**. One caught the write being accepted (`ok`); the other caught the *ordering* specifically, degrading to `stale` — the "invited to rebase with the same reassignment" failure |
| Add an attach-to-root fallback for a dangling parent | `workspace-node-write.test.ts` — **2 tests** (`expected 'ok' to be 'invalid'`); after rebuilding `dist`, also `workspace-node-runtime.test.ts` — "is refused, writes nothing, and REPAIRS nothing" (`expected 'ok' to be 'refused'`). It fails loudly at both layers |
| Remove the cascade rescue from `persistedWrite` | `workspace-node-write.test.ts` — **2 tests**. `expected ['c','d','s2'] to include 'a'` — the two panes the review's shape loses |

> Note on the third: the web suite imports `@pagespace/lib` from `dist`, so a
> source-only mutation does not reach it until a rebuild. I rebuilt and re-ran to
> confirm the runtime test genuinely covers the mechanism rather than passing
> against stale output.

---

## `parentId` assignments on failure paths: **zero**

Measured, not asserted in prose. `parentIdsOf(decision)` in
`workspace-node-write.test.ts` returns every `parentId` a decision would write,
and every refusal test asserts it is `[]` — which is trivially true because a
refusal carries no `persist` at all, and that is the point: there is no branch
that could produce one.

Grep-level confirmation across the three files I wrote that touch a tree
(`workspace-node-write.ts`, `workspace-node-runtime.ts`, `workspace-node-placement.ts`):
no `parentId:` appears on any non-`ok` path, no `?? root`, no `|| root`, no
"if the parent is missing" branch. The only `parentId` values that reach storage
came from the caller, or — on the *success* path — from
`collapseInto`'s survivor inheriting a destroyed container's place, which is in
the merged algebra and is a placement, not a rescue.

---

## Things this prompt did not anticipate

Ordered by how much they will cost if ignored.

### 1. `targets[]` as specified has no `agentPageId`, and the pane header needs one

The prompt fixes `targets[]` as `{id, kind, title, lastMessageAt}`. I built
exactly that. But `PaneScope` today carries `agentPageId` — which agent a chat
pane's conversation belongs to — and it is derived by the shared
`conversationPageId(row)` for a reason: five sites had each re-spelled it and a
sixth invented a third answer. `PaneChat` and the pane header consume it.

Nothing in Phase 4 can reconstruct it from `{id, kind, title, lastMessageAt}`.
Either `targets[]` gains a fifth field (it costs nothing — the row is already
selected and the derivation is one shared call), or Phase 4 needs a second
authorized read for a fact it just paid for. **I did not add it**, because the
wire shape is stated explicitly and a sibling agent may be building against it;
this is the decision to make before Phase 4 starts, not during it.

### 2. Nothing consumes the bulk read yet, and knip is a blocking gate

`readWorkspaceNodeSnapshots` takes a list and the single case is that list with
one element — the shape the leaf asked for, exercised by its own suite. But a
*web-level* `readWorkspaceNodesBulk` (bulk + per-viewer targets) has no caller
until the sessions list moves off `readWorkspaceGridsBulk`, which is the
sidebar's phase. I wrote it, knip flagged it as a dead export, and I removed it
rather than ship an unexercised export past a blocking gate.
`resolveTargetsByWorkspace` already takes a list of subjects and authorizes each
against its **own** workspace's owner, so the wrapper is two lines when its
caller arrives. Flagging it because "the bulk case is served" is true of the
store and not yet true of the runtime.

### 3. The advisory lock is shared with the old model *on purpose*, and that is load-bearing

`withWorkspaceLayoutLock` is imported rather than re-cut. If a later change gives
the node store its own lock keyed on the same workspace by a different hash, the
two models can write one session at the same instant for the whole migration
window. This is the sort of thing that looks like tidy-up.

### 4. A `stale` can no longer reach the agent tools, and I left that visible

`applyLayoutCommandForWorkspace` maps `stale` to `{ok: false, reason: 'stale'}`
rather than folding it into the generic refusal. It is unreachable — a command's
`baseRev` *is* the rev the lock read — and it is named so that if it ever
appears it reads as "the funnel stopped deciding under the lock", which is a bug,
rather than as "the workspace was busy", which is not.

### 5. `open_page_pane` no longer reads the page title

The old helper queried `pages.title` so the broadcast would carry the right
label. The node broadcast carries no labels at all, so the query is gone. One
fewer round trip, and one fewer place a stale label can be written down — but if
anything downstream was relying on the broadcast's label, it will now get nothing
and must resolve through its own read. That is the intended design; it is listed
because it is a silent behaviour change rather than a loud one.

---

## Gates

| Gate | Result |
|---|---|
| `bun run --filter @pagespace/lib typecheck` | pass |
| `bun run --filter web typecheck` | pass |
| `bun run --filter @pagespace/lib lint` | pass |
| `bun run --filter web lint` | pass (warnings only, all pre-existing) |
| `bun run --filter @pagespace/lib test -- src/agent-workspaces src/services/agent-workspaces` | **759 passed**, 27 files |
| `bun run --filter web test -- src/lib/agent-workspaces src/lib/ai/tools src/app/api/agent-workspaces` | **1902 passed**, 51 skipped, 0 test failures |
| `bun run knip` | no unused exports from this change (remaining findings pre-date it, in files not touched here) |
| `bun run test:security` | **could not run here** — `db:migrate` fails, no Postgres in this worktree |

The six "failed files" in the web run are all `.integration.test.ts` suites whose
`requireDb` guard throws in `beforeAll` because there is no Postgres in this
environment (plus `activity-tools.test.ts`, same cause). Zero *tests* failed.
This matches the known env-only gap; the same suites cannot run on any branch
here.

### New/changed files

```
packages/lib/src/agent-workspaces/workspace-node-wire.ts                       new
packages/lib/src/agent-workspaces/workspace-node-write.ts                      new
packages/lib/src/services/agent-workspaces/workspace-node-store.ts             new
packages/lib/src/agent-workspaces/workspace-node-commands.ts                   export `compile`
apps/web/src/lib/agent-workspaces/workspace-node-runtime.ts                    new
apps/web/src/lib/agent-workspaces/workspace-node-placement.ts                  new
apps/web/src/app/api/agent-workspaces/[workspaceId]/nodes/route.ts             new
apps/web/src/lib/agent-workspaces/authorize-pane-scope.ts                      + node-shaped gate
apps/web/src/lib/websocket/agent-workspace-events.ts                           + structural node broadcast
apps/web/src/lib/agent-workspaces/agent-workspaces-runtime.ts                  rewired
apps/web/src/lib/ai/tools/{session-tools,session-tools-runtime}.ts             rewired
apps/web/src/lib/ai/tools/{page-pane-tools,page-pane-tools-runtime}.ts         rewired
apps/web/src/lib/agent-workspaces/workspace-placement.ts                       DELETED (+ 2 suites)
```

Out of scope and untouched, as instructed: the sidebar, the store, every React
component, the old tables, `conversations.workspaceId`, the compat shim, and the
membership chokepoint.

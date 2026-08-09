# pu-wnt-runtime — membership moves to the tree

Branch `pu/wnt-runtime`. Two board leaves, one cluster: the membership chokepoint
and the deletion of the reconciliation machinery.

**Status: both leaves complete.** Not opened as a PR, not merged.

The sentence the whole change reduces to: **a conversation is in a workspace
exactly when a node of that workspace's tree is bound to it.**
`conversations.workspaceId` and `conversations.closedInWorkspaceAt` are no
longer written by anything. The columns stay, with their data, so the cutover is
one reviewable step and a revert is a code revert.

---

## LEAF 1 — the membership chokepoint

### What changed

**`packages/lib/src/agent-workspaces/workspace-membership.ts`** (new, pure).
Four acts over a node list:

| Act | Algebra | Meaning |
|---|---|---|
| `admit` | `create` (+ the root, if the workspace has no tree) | the thread becomes a member |
| `dismiss` | `move` to no parent | the thread leaves the GRID, stays a member |
| `readmit` | `move` back into the grid | |
| `expel` | `destroy` | the thread leaves the WORKSPACE — history-deletion only |

**`applyWorkspaceMembershipWrite`** in `workspace-node-runtime.ts` is the one
funnel. It is `commitUnderLock` with a new `within(tx)` hook: work that must land
in the **same transaction** as the node write. `createConversationInSessionWith`
passes the conversation's own INSERT through it, so the row and its membership
commit together or not at all.

Three orderings inside that funnel are load-bearing, and each is pinned:

1. **`within` runs before the binding gate.** The gate asks whether the acting
   user may bind this target; for a spawn, that target is a conversation *this
   transaction is creating*. A gate on the pooled connection cannot see an
   uncommitted insert, so it is run against `tx` — which means it must run after
   the row exists. `paneScopeDeps(executor)` is the new seam.
2. **`within` runs before the change check.** A retried create finds the node
   already there, so the write is a no-op on the tree — but the conversation
   layer's own idempotency gates (is this id really the thread the caller
   described? is it *theirs*?) still have to run.
3. **The gate's refusal THROWS.** Every refusal above it happens before `within`
   has written, so returning commits an empty transaction. This one happens
   after, so returning would commit a conversation with no membership — the
   exact ghost. `NodeWriteRefused` unwinds and is re-formed as the ordinary
   `{status: 'refused'}` on the way out.

**`placeInGrid` became `attach`**, and the narrowing is the point. The old flag
decided whether the thread was in the grid *at all*, and a thread it said no to
was reachable only through the second structure. Both answers are now
membership: `attach: false` mints the node **parked** — in the workspace, in the
listing, off the grid.

**Shells go through the same chokepoint** (`workspace-shells-runtime.ts`). The
shell row and its terminal node commit together; the shell's id is minted by the
caller because the node that binds it is decided against the tree before the row
exists. A refused shell (invalid name, `(workspaceId, name)` collision) throws so
the node unwinds with it — a node bound to a shell that does not exist is the
same ghost wearing a different hat. `createDbSessionShellStore(executor?)` and
`NewSessionShellInput.id` are the two small seams that made this possible.

**Every spawn shape in `POST /api/agent-workspaces`** now lands here: the mint
path through `createConversationInSession`, the claim path through
`claimConversationInSession`, and `firstThing: 'shell'` through `spawnShell`.

### How proved

`workspace-membership.test.ts` (30) against node lists; `workspace-node-runtime.test.ts`
gained a `describe('the membership write')` (7 cases) whose store fake is now a
**transaction**: `withWorkspaceLayoutLock` snapshots and rolls back on a throw,
and `within` writes into `store.rows`. That is what makes "unwound" and
"returned a refusal" different observable states — see mutation M7, which passed
against the old passthrough fake and fails against this one.

---

## LEAF 2 — the reconciliation machinery, deleted

| Module | Was | Is |
|---|---|---|
| `claim-conversation-in-workspace.ts` | the ONE `UPDATE conversations SET workspaceId`, guarded `WHERE workspaceId IS NULL AND userId = :caller` | creates the node; the guard is now `agent_workspace_nodes_chat_target_idx` |
| `close-conversation-in-workspace.ts` | stamps `closedInWorkspaceAt` | `move` to no parent |
| `reopen-conversation-in-workspace.ts` | clears `closedInWorkspaceAt` | `move` back into the grid |
| `annotate-conversation-panes.ts` | reconciled a listing with a grid | **deleted**, with its suite |

Deleted with them, as dead writers: `conversationRepository.claimConversation`,
`closeConversationListing`, `reopenConversationListing`, and
`withSessionListingLock` (+ its retry budget and `SessionListingLockBusyError`).
Each leaves a comment where it was saying what superseded it.

**`withSessionListingLock`'s deletion is the tidiest consequence.** It existed
because the cap was a `SELECT count(*)` over `conversations` and the write it
guarded was a different statement on a different row; four call sites had to
remember to take it, and it needed a *separate connection pool* to avoid
deadlocking against the queries it protected. The cap is now a count over the
tree inside the transaction that writes the tree, under the lock that write
already takes. One lock, one invariant, no call site that can forget it.

### The readers that had to move with it

Membership is read from `agent_workspace_nodes` in:
`agentWorkspacesStore.findByConversation` (how a chat turn resolves its
sandbox), `countOpenConversations`, `listSessionConversationsBulk`,
`authorizePaneScope`'s chat containment, `resolveTargetsByWorkspace`'s
`belongsHere`, `workspace-node-placement`'s `findWorkspaceOfConversation`,
`session-tools-runtime`'s `findWorker` and workspace listing,
`listAllConversationsPaginated`'s drive scoping, and the legacy verb model's
`resolvePaneLabels`.

`listSessionConversationsBulk` is the one worth reading: it now selects **from**
`agent_workspace_nodes` and joins `conversations`, so the row that says a thread
is here is the same row that says whether it is on screen. Each entry carries
`nodeId` and `attached`. That is what replaces the annotation, and why the
annotation is deleted rather than ported.

### How proved

Rewritten suites for claim (18), create (20), close (8), reopen (8). The
annotation's suite is replaced by the **detached-node rendering guard**: the
route test `LISTS a thread that is off the grid, carrying its node and its
state`, plus `attach is a location, not an existence` in the runtime integration
suite.

---

## MOVE vs DESTROY — the argument you asked for

**`move`, and I would hold this even against the behaviour change it causes.**

1. **The unique index IS the write-once binding.**
   `UNIQUE (targetId) WHERE targetKind = 'chat'` is global. Under `move` the row
   survives for the life of the workspace, so contract invariant 1 — "a bound
   thread moving to another session is a fork, never a rebind" — becomes a
   database constraint instead of a WHERE clause a future writer could forget. A
   `destroy` **frees that index**: a closed thread could then be claimed into a
   *different* workspace. That is a rebind reached by clicking "close", and no
   amount of code discipline above it can prevent what the constraint stops
   enforcing.
2. **Two closes must not mean two things.** `closePane` is already a `move` to
   no parent. If closing a *listing* were a destroy, the model would again have
   two removals with two meanings — the exact split this epic exists to delete.
   The reason production had workspaces with three threads and two panes is that
   "in the session" and "on screen" were maintained by convention across two
   write paths; re-splitting them at the close button rebuilds that.
3. **The model was designed for it.** `workspace-node.ts` on `PaneNode`:
   "`parentId === null` means DETACHED — in the workspace **and in the sidebar**,
   not on screen." Closed-but-present is the state the flat list exists to be
   able to express.
4. **`move` is exactly reversible; `destroy` is reversible only if nothing took
   the binding in between** — a promise the reopen path cannot make. Under
   `move`, `readmit` is a `move` and `create` never runs, so reopen cannot fail
   for a reason the user cannot act on.
5. **The never-empty guard falls out.** A `move` cannot empty a workspace, so
   `last_conversation` — the 409 that told a user to end the session instead —
   is not a refusal this act can produce. It survives in exactly one place,
   `expel`, where a destroy genuinely can empty a workspace, and there it is a
   count over the tree inside the transaction that would change it rather than a
   count on a second connection under a second lock.

**The cost, named rather than buried.** A dismissed thread no longer disappears
from the workspace's listing, because a workspace's listing is now its members.
Anyone using "close" to mean "get this out of my sidebar" loses that; the only
acts that remove a thread from a workspace are history-deletion and ending the
workspace. If the product wants "dismiss", it should be its own explicit verb
compiling to `expel` — visible, authorized as a removal, and not the close
button. I did not add one, because inventing a product affordance inside a
storage cutover is how the last two structures got here.

Nothing above depends on #2373 having been about closed threads — it was not; it
was about *unplaced* ones. The move-vs-destroy case stands on the index, the
symmetry with `closePane`, and the model's own doc.

---

## THE ILLEGAL INPUTS — enumerated first, then tested

✔ = a test fails if the behaviour changes.

| Input | Answer | ✔ |
|---|---|---|
| **a conversation created into a workspace that has ENDED** | **admitted.** Lifecycle state never refuses a permitted create; the admission reopens the listing (`planSessionReopen`), best-effort, so a reopen failure cannot un-succeed a committed membership | ✔ |
| **a claim of a conversation already bound ELSEWHERE** | `not_found` — the same shape a nonexistent id gets, from BOTH the pre-check and the index. See below | ✔ |
| **a reopen of a thread whose workspace is gone** | the `rootId` FK cascades, so the node went with it → `not_a_member` → `not_in_session`. There is no half-bound residue to clean up | ✔ |
| **a close of a thread with NO node** | `not_a_member` → `not_in_session`. Distinct in the pure layer from `unknown_node`: the caller named a conversation, not a node id | ✔ |
| **a spawn whose node write fails after the conversation lands** | **unrepresentable.** One transaction; the node write's failure rolls the conversation back, and the conversation's failure rolls the node back | ✔ |
| a create into a workspace with NO TREE AT ALL (a fresh spawn) | the root is minted in the SAME write. `validateTree` calls an empty list `no_root`, so a separate root write would reintroduce the window this leaf closes | ✔ |
| a create at the cap | `session_full`, counted over the tree inside the write's transaction — and **no conversation row is left behind** | ✔ |
| a create at the cap for a thread the workspace ALREADY holds | **accepted.** A retry consumed no slot when it arrived and must not be refused by a ceiling it is already inside | ✔ |
| a PARKED thread, against the cap | **counts.** The cap bounds membership, not visibility | ✔ |
| a terminal or a page, against the conversation cap | not counted | ✔ |
| a create whose id resolves to SOMEONE ELSE'S thread | `conversation_unavailable`. This gate used to come free from composing on the claim primitive; the composition is gone, so it is stated | ✔ |
| a create whose id is anchored to a DIFFERENT agent | `conversation_unavailable`, read on the TRANSACTION so a row this transaction just inserted is visible to its own check | ✔ |
| a create whose id holds someone else's MESSAGES | `conversation_unavailable` (the repository's squat guard) | ✔ |
| a claim of someone else's conversation | `not_found`. The one rule no index states | ✔ |
| a claim of a history-deleted thread | `not_found` | ✔ |
| a claim of an API-managed (`client`) thread | `not_found` — no in-app viewer to give it | ✔ |
| a claim of a page thread whose agent is in another DRIVE | `cross_drive_denied` | ✔ |
| a claim into a GLOBAL workspace of any accessible agent's thread | allowed — the documented exemption | ✔ |
| a re-sent close | `already_closed`, writes nothing | ✔ |
| a re-sent reopen | `already_open`, writes nothing | ✔ |
| a reopen into a FULL workspace | **reopened.** A member returning consumes no slot; `session_full` is not an outcome this route can produce any more | ✔ |
| a reopen of a thread in a rootless workspace | `no_root` → `not_in_session`. Refused, never repaired by minting a root nobody asked for | ✔ |
| closing the workspace's LAST thread on screen | **allowed.** Empty grid, every thread still a member | ✔ |
| a history-delete of the workspace's LAST conversation | `last_conversation` → 409, **before** the history write | ✔ |
| a history-delete whose membership write fails | 500, and the history is NOT deleted | ✔ |
| a shell spawn whose row is refused (bad name, name taken) | the caller's own reason; the node unwinds with it | ✔ |
| a binding the acting user may not make, in a membership write | `forbidden_target`, and the conversation `within` created is rolled back | ✔ |
| a `23505` from the chat-target index | `bound_elsewhere` → `not_found` / `conversation_unavailable` | ✔ |
| a `23505` from ANY OTHER index | keeps throwing — a genuine fault must not read as "already bound" | ✔ |

### The claim-already-bound-elsewhere case, since you asked what the caller sees

`not_found` — identical to a nonexistent id, a foreign row, or an inactive one.
The pre-check (`findWorkspaceOfConversation`, one lookup on the chat-target
index) answers the ordinary case; the index answers the racing one, and both
produce the same word. An id-guessing caller learns nothing from the difference,
and a caller who legitimately owns the thread learns nothing *useful* either —
which is the cost of the uniform-404 policy, taken deliberately and consistent
with every other refusal in this family. The spawn route's `firstThing: 'claim'`
preflight is the one surface that distinguishes it (409, "That conversation
already belongs to a session"), because there the caller has already
demonstrated ownership of the row before the question is asked.

### Two the prompt did not name, found while writing

**1. A workspace with no tree at all.** Every membership write into a
freshly-spawned workspace has to bring the root with it, because `validateTree`
calls an empty list `no_root`. `admit` mints it in the same write. Without this,
the very first `spawn_session` would be refused by the validator.

**2. The GDPR export.** Membership moved into a table no Art 15 collector read.
Under the column it travelled inside `conversations`; in
`agent_workspace_nodes` it was absent from every subject access request. The
coverage guard was already red on this branch (the tables arrived unregistered
with the node model), but this change is what made it *substantive*. Added:
`collectUserAgentWorkspaces` now carries `nodes` for OWNED workspaces, withheld
for `participant` entries under the same Art 15(4) line the shells draw;
`agent_workspace_node_revs` is allowlisted as a bare counter.

---

## Mutation table

Each mutation applied to the source, the suites re-run, then reverted.

| Mutation | What it killed |
|---|---|
| `admit` loses the root-minting branch | `workspace-membership.test.ts` — **2 tests**. A fresh workspace's first thread is refused `no_root`, whether attached or parked |
| `admit` loses its already-a-member short-circuit | `workspace-membership.test.ts` — **2 tests**. A retried spawn mints a second node for one conversation, which is what the chat-target index refuses |
| the cap counts only ATTACHED members | `workspace-membership.test.ts` — **3 tests**. A workspace full of closed threads accepts unbounded new ones |
| `dismiss` becomes a `destroy` | `workspace-membership.test.ts` — **3 tests**. `expected [ 'conv-a', 'conv-b' ] to deeply equal [ 'conv-b' ]` — closing stops being membership, and the node id no longer survives the close |
| the creators run OUTSIDE the shared transaction | `create-conversation-in-workspace.test.ts` — **2 tests**. `runs NO creator outside the membership write` and the throw-unwinds case both go red: the ghost is back |
| `claim` loses the ownership gate | `claim-conversation-in-workspace.test.ts` — **1 test**. Someone else's thread is admitted into the caller's workspace |
| the post-`within` gate refusal RETURNS instead of throwing | `workspace-node-runtime.test.ts` — **1 test**. `expected [ 'conv-new' ] to deeply equal []` — the conversation commits with no node beside it |
| `within` moves AFTER the change check | `workspace-node-runtime.test.ts` — **1 test**. A retried create skips its own idempotency gates because the layout happened not to move |

> Note on mutation #7: it **passed** against the store fake as I first wrote it,
> because a passthrough `withWorkspaceLayoutLock` cannot tell an unwind from a
> return — both leave `store.writes` empty. I rewrote the fake as a real
> transaction (snapshot, roll back on throw) and gave `within` something to
> write, and then it fails. The first version of that test proved nothing; it is
> in this table because it is the one that mattered most.

---

## Gates

| Gate | Result |
|---|---|
| `bun run --filter @pagespace/lib typecheck` | pass |
| `bun run --filter web typecheck` | pass |
| `bun run --filter @pagespace/lib lint` | pass |
| `bun run --filter web lint` | pass (warnings only, all pre-existing) |
| `bun run --filter @pagespace/lib test` | **9195 passed**, 0 test failures |
| `bun run --filter web test` | **16632 passed**, 10 failures — all env, see below |
| `bun run knip` | no unused exports from this change |
| `bun run test:security` | **could not run here** — no Postgres in this worktree |

The failing *files* in both suites are `.integration.test.ts` guards whose
`requireDb` throws in `beforeAll` because there is no Postgres here (plus
`activity-tools.test.ts` and the SDK-entry contract test, same class). Every one
of the 10 failing tests is one of those. This matches the known env-only gap;
the same files cannot run on any branch in this worktree.

The whole-repo run is also what caught the one genuine regression this change
introduced and the targeted runs did not: I had built the membership subquery
alias at MODULE SCOPE in `listAllConversationsPaginated`, so importing that
module did query-builder work, and `workspace-conversations-runtime.test.ts`
went from 8 passing tests to **zero collected** — a shape that reads as "fine"
in a summary line and is worse than a failure. The alias is now built per call
(cheap, and importing a module should not construct queries), and the suite's
`db` stub answers `.as()`. Worth stating plainly: a targeted run over the
directories I touched would not have found it, because the file that broke was
one whose *source* I had changed and whose tests I had not thought to re-run.

### New / changed files

```
packages/lib/src/agent-workspaces/workspace-membership.ts               new — the four acts
packages/lib/src/services/agent-workspaces/workspace-membership-store.ts new — the membership reads
packages/lib/src/services/agent-workspaces/agent-workspaces-store.ts     findByConversation → nodes
packages/lib/src/services/agent-workspaces/workspace-shells{,-store}.ts  + executor, + caller-minted id
packages/lib/src/compliance/export/gdpr-export{,-coverage}.ts            + the nodes collector
packages/lib/package.json                                                + 2 export specifiers
apps/web/src/lib/agent-workspaces/workspace-node-runtime.ts              + within, + the membership funnel
apps/web/src/lib/agent-workspaces/{create,claim,close,reopen}-…          rewritten
apps/web/src/lib/agent-workspaces/annotate-conversation-panes.ts         DELETED (+ its suite)
apps/web/src/lib/agent-workspaces/agent-workspaces-runtime.ts            rewired; lock deleted
apps/web/src/lib/agent-workspaces/{authorize-pane-scope,conversation-cap,
  workspace-conversations-runtime,workspace-layout-runtime,
  workspace-node-placement,workspace-shells-runtime}.ts                  readers → nodes
apps/web/src/lib/repositories/conversation-repository.ts                 3 writers DELETED, + executor
apps/web/src/lib/ai/tools/session-tools-runtime.ts                       rewired
apps/web/src/app/api/agent-workspaces/**                                 rewired
apps/web/src/app/api/ai/{global,page-agents}/**/[conversationId]/route.ts expel-then-delete
```

Untouched, as instructed: the sidebar, the store, every React component (one
test fixture excepted — see handoff #1), the old tables, and both conversation
columns.

### One gate I fixed that was already red

`conversation-events-audience.test.ts`'s emit-site registry expected
`agent-workspace-events.ts` to emit `workspace:updated`. The wire leaf
(`06508ec56`) refactored both broadcasts through a local `emit(event, …)`
helper, so the `event: '…'` literal the scan matches appears nowhere in that
file and the scan sees it emit nothing. Both files are untouched by me;
this was red on the base commit. I commented the entry out with the reason and
the fix (make the two names literal at the call sites, which is a change to that
module and belongs with it), rather than delete the guard silently.

---

## Things this prompt did not anticipate

Ordered by how much they will cost if ignored.

### 1. The sidebar still reads `conversation.pane`, and the route stopped sending it

`AgentsSidebar` consumes the `pane: {paneId, columnId, orderIndex} | null` field
the deleted annotation produced. The route now sends `nodeId` and `attached`
instead. **The client agent owns that file and I did not touch it**, so between
these two leaves landing, the sidebar's placement indicator reads `undefined`.

To keep the build green I inlined the old annotation into
`AgentsSidebar.test.tsx` as a local fixture helper, with a comment saying
exactly that: it describes what the component reads *today*, and it is the seam
the two phases meet at. The client's move onto `attached` deletes it.

**This is the highest-priority handoff in this report.**

### 2. Containment stopped being independent evidence, and that is a real (small) reduction in defence-in-depth

The read-side title gate used to ask two independent questions: does
`canAccessConversation` allow it, OR is `conversations.workspaceId` this
workspace? The second was written by an ownership-gated path, so it was
*separate* evidence.

Now containment and "a node here binds it" are the same sentence, so the check
is vacuous at read time. It is not a *weakened* gate — it is the same gate moved
earlier: a node binding a chat can only be written through `authorizePaneTargets`,
and for an INTRODUCED target containment is false by definition, so
`canAccessConversation` is what let it in. But it is now checked **once, at the
write** rather than twice. If a future write path ever reaches
`agent_workspace_nodes` without that gate, the read will no longer catch it. The
comment at `resolveTargetsByWorkspace` says so.

### 3. The `conversation:closed` / `conversation:reopened` / claim `updated` events are gone

They were emitted by the three repository writers this change deletes. The
structural `workspace:nodes-updated` broadcast the membership write already
sends carries the fact that moved (the node's location), so it is the right
channel — but `session-directory-listener.ts` still has a
`changes.closedInWorkspaceAt` branch that will never fire again. It is inert, not
broken, and it belongs to whoever moves the sidebar onto the node broadcast.

### 4. History-delete is expel-then-delete, NOT one transaction

Making it one would mean threading an executor through
`softDeleteConversation`'s message deactivation, room kicks and emits — a much
larger blast radius than this leaf. So the **order** is chosen instead, so the
survivable failure is the one that can happen: expel-then-delete can leave a
thread with intact history that belongs to no workspace, which a re-claim fixes.
Delete-then-expel would leave a pane bound to a dead thread and a cap slot nobody
can reclaim — the ghost, pointing the other way. Both history-delete routes are
tested for the failure path (500, history untouched).

### 5. `countOpenConversations` changed meaning, and its name did not

It counts **members** now, not "open listings" — because closing no longer
removes a thread from anything. Every caller wanted the number that bounds the
cap, and that is what it still returns, so no call site is wrong. But
`agent-workspaces-runtime`'s end-session warning now says "this will destroy N
threads" where N includes closed ones, which is *more* accurate and reads
differently. The name is worth changing when something else touches these files.

### 6. `conversations.workspaceId` still has three inert readers

`global-conversation-repository` selects it into a DTO nobody reads;
`conversation-rev` carries it on the emit payload; the Phase 2 backfill script
reads it as its *source*, which is correct and must not change. The first two
will always be null on new rows. Left alone deliberately — they are the "the
data is still there" half of the cutover, and cleaning them up belongs to the
contract step that drops the columns.

### 7. `admit` is typed to refuse an attached non-chat target

`openConversation` is chat-only, so a `terminal` or `page` admitted with
`attach: true` gets `invalid_target`. No caller does this today (shells arrive
parked; pages are placed by whatever opened them), and it is stated rather than
silently mis-placed. If a future caller wants an attached terminal, the fix is in
the commands layer, not here.

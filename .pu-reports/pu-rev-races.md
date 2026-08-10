# Adversarial review — `f82d9345b` + `0711ed897` (the two P1 race fixes)

Branch `pu/workspace-node-model`, PR #2378. Reviewed the COMMITTED state of the two named
commits. Method: read the funnel, then reproduce every claimed-closed race against real
Postgres with two connections, then mutation-check every clause the commit message says is
tested — the mutations run in a **throwaway `git worktree` checked out at `f82d9345b`**
(`git worktree add --detach … f82d9345b`, root `node_modules` symlinked in), so the shared
working tree was never edited. It was removed afterwards; `git status --porcelain` is empty
apart from this file.

**Timing note, and it matters for how to read this.** While this review was running the
sibling session committed `c87e49526` ("the reopen guard decided on a snapshot it could not
vouch for"), which independently found and fixed the same two residues reported below as
**F1** and **F2**, and the same wrong-reason test reported as **F4**. I found them against
`f82d9345b` before that commit existed; I have re-verified each one against HEAD and say
plainly, per finding, whether it still stands. **F3 stands at HEAD and is unaddressed by
either commit.** **F5** is a new, narrower residue *in the `c87e49526` fix itself*.

---

## Verdicts

| Claim | Verdict at `f82d9345b` | At HEAD (`c87e49526`) |
|---|---|---|
| **A — `endSession` / `requireEnded`** | **BROKEN.** Closes one of the two fatal interleavings; the other — the one Postgres's lock queue naturally produces — still yields the exact ghost. Reproduced. | Fixed for the wide window; **F5** leaves a statement-width residue. |
| **B — expel / delete ordering** | **BROKEN.** `readDeletedChatTargets` narrows the window, it does not close it, and the commit message's stated reason why it does is factually wrong. Reproduced. | Fixed for the membership branch by the second expel. **F3** (the no-membership branch) still open. |
| **C — interaction with `awaiting_backfill`** | **SOUND.** No path found where `requireEnded` or the changed expel ordering mints or skips a rev row. Verified executably. | unchanged |
| **D — tests** | **PARTLY SOUND.** 5 of 9 mutations die. Four survive, one of which (`M9`) is a test that cannot fail for the behaviour it names. | `M9` fixed by `c87e49526`; `M4`/`M8`/`M10` still uncovered. |

The commit message's headline sentence — *"Re-reading the stamp under the lock linearizes the
two"* — is false as written, and so is *"the delete either commits before (and this refuses)
or after (and it is serialized behind a node this transaction has already written, which the
delete's own expel then removes)"*. Both are the load-bearing arguments for the two fixes.

---

# Findings

## F1 — CRITICAL (at `f82d9345b`; fixed at HEAD): `requireEnded` closes the *less likely* half of the race. The ghost survives, and the lock queue prefers the half that survives.

`reopenEndedSessionListing` (`apps/web/src/lib/agent-workspaces/agent-workspaces-runtime.ts:324,387`)
runs **after** `admitConversationNode`'s transaction has committed and **released** the
workspace lock, and it takes **no lock of its own** — it is `store.findById` followed by a
CAS'd `applyStamps`, two round trips on the pooled connection. So the ordering that matters is:

```
endAgentSession stamps endedAt (outside the lock, Sprite already torn down)
  admission: withWorkspaceLock → writes its node → COMMIT → lock released
  destroy:   withWorkspaceLock → requireEnded re-reads endedAt → STILL SET → destroys the tree
  admission: reopen CAS clears endedAt          ← no lock, lands last
```

`requireEnded` passes, because at the moment it reads, the reopen has not landed yet. Failure
scenario, concrete: user has session `W` open with one conversation; user hits "End session"
while an agent turn auto-binds a second conversation into `W` (or the scratch-session cleanup
path at `apps/web/src/app/api/agent-workspaces/route.ts:446/495/544/601` fires). Outcome: `W`
is **live in the sidebar with zero nodes**, and the conversation's only record of membership
is gone — the exact state the epic exists to delete, produced by the end path, with
`requireEnded` in force.

This is not a narrow window. `destroyWorkspaceTree` typically arrives *while the admission
holds the lock* and **queues on `pg_advisory_xact_lock`**; Postgres wakes it the instant the
admission commits, whereas the admission still has to return to the app and issue two more
queries. Reproduced under exactly that natural ordering:

```
+  41ms [admission] took the lock
+  63ms [destroy]   waiting on pg_advisory_xact_lock ...
+ 199ms [destroy]   WOKE with the lock
+ 199ms [admission] COMMIT — lock released; node is durable
+ 201ms [admission] reopen: findById returned
+ 203ms [destroy]   requireEnded re-read: endedAt=2026-08-10 00:19:12.305876 -> PASSES, destroying
+ 204ms [admission] reopen: CAS applied rows=1
+ 206ms [destroy]   COMMIT

FINAL: endedAt=NULL (live, in the sidebar)  nodes=0
>>> GHOST reproduced under the NATURAL lock-queue ordering.
```

Note `+204ms` vs `+206ms`: this run is also the answer to the review question *"what if
`endedAt` is cleared after the re-read but before commit?"* — it is, and nothing stops it.
Isolation is `read committed` (server default, and `withWorkspaceLock` sets nothing), so the
destroy's `SELECT endedAt` takes no row lock and the reopen `UPDATE` does not block:

```
server default_transaction_isolation = read committed
holder: HOLDS pg_advisory_xact_lock(hashtext(ws))
reopen UPDATE (reopenEndedSessionListing takes NO lock): rows=1 in 2ms -> NOT serialized by the workspace lock
```

**Answers to the rest of Claim A's questions.**

* *Is the re-read inside the same transaction as the delete, under the same lock?* **Yes.**
  `within` is invoked on `tx` inside `withWorkspaceLock`'s callback
  (`workspace-node-runtime.ts:429`), before `writeWorkspaceNodes`. That part is correctly wired.
* *Does the reopen take the same lock?* **No** — proven above. That is the whole defect.
* *The `requireEnded`-refused branch:* `endSession` returns the lifecycle result `ended`
  (`ok: true`) and the DELETE route answers success, for a session that is now **live** with
  `endedAt = null`. The caller is told the session ended when it did not. That is the honest
  consequence of "newer intent wins", but it is invisible to the client and untested (see
  **M9**).
* *The Sprite claim — verified, and it holds.* `planSessionReopen()` returns `{ endedAt: null }`
  only, so `spriteTornDownAt` survives; `isEnded()` therefore stays true, and
  `planAgentSessionLifecycle`'s `ensure` arm takes
  `if (isEnded(row) || row.sandboxId === null) return { action: 'create', … reviveStamps(now) }`
  — a fresh provision under the same `spriteKey`
  (`packages/lib/src/agent-workspaces/plan-workspace-lifecycle.ts:292-298`). The orphan
  reconciler will not reap it either: `workspace-orphan-reconcile-runtime.ts:119` requires
  `spriteTornDownAt === null`. One caveat the message does not mention: `attach` **denies**
  a reopened session (`session_torn_down`) until an `ensure` runs. That is pre-existing
  `planSessionReopen` semantics, not a regression from this commit.

**At HEAD:** `c87e49526` replaced the two-statement reopen with the single-statement
`reopenListingIfPopulated` (`EXISTS` + CAS). That closes this window. See **F5** for what it
does not close.

---

## F2 — HIGH (at `f82d9345b`; fixed at HEAD for the membership branch): the liveness backstop narrows the delete race, it does not close it, and the stated reason it does is wrong.

`readDeletedChatTargets` is a plain `SELECT` (`packages/lib/src/services/agent-workspaces/workspace-node-store.ts:307`).
Under READ COMMITTED it takes no row lock, so the delete's `UPDATE conversations SET isActive
= false` can commit **between that read and the claim transaction's own commit**. The commit
message argues this is safe because a delete landing after "is serialized behind a node this
transaction has already written, which the delete's own expel then removes" — but in the
committed code the delete's expel runs **before** the soft-delete
(`apps/web/src/app/api/ai/global/[id]/route.ts:141-152`, and the page-agent twin), so there is
no later expel to remove anything.

Deterministic reproduction (the delete's `UPDATE` is issued but uncommitted while the claim
runs, which is precisely the interleave the order permits):

```
[DELETE] UPDATE conversations SET isActive=false  -- issued, NOT yet committed
[CLAIM]  holds pg_advisory_xact_lock(hashtext(ws))
[CLAIM]  readDeletedChatTargets: live rows returned = 1 -> dead=[] -> PASSES the backstop
[CLAIM]  node written and COMMITTED
[DELETE] soft-delete COMMITTED (nothing after it removes the node: expel already ran)

FINAL STATE: [{"node":"p1","targetId":"rvw_conv_b","isActive":false}]
>>> GHOST: a live pane node bound to a DELETED thread. The backstop did not stop it.
```

Failure scenario: user deletes a thread's history in one tab while an agent turn claims that
same thread into a session. Outcome: a pane bound to a dead thread and a
`agent_workspace_nodes_chat_target_idx` slot nobody can reclaim — the outcome the
expel-then-delete order was chosen to prevent, which is exactly what the commit message says
it was fixing.

**No reverse hazard was introduced by this commit** (the ordering itself is unchanged; only a
read was added). The reverse hazard the prompt asks about — a thread marked inactive whose
node removal then fails — is *introduced* by `c87e49526`'s second expel, and is benign: that
expel is best-effort, logs on failure, and the funnel's own liveness read plus `reopen`'s
`history_deleted` refusal keep the dead thread from being re-admitted; the residue is a stale
node, the same state a crash between expel and delete has always been able to leave.

**At HEAD:** `c87e49526` adds a **second expel after the soft-delete** in both routes. I
traced all four orderings against the workspace lock and it does close this: an in-flight
claim holds the lock, so expel #2 queues behind it and removes what it bound; a claim that
starts later queues behind expel #2 and then meets `isActive = false`.

---

## F3 — HIGH, **STILL OPEN AT HEAD**: the delete's `else` branch has no expel at all, so nothing compensates for the same race.

Both delete routes are shaped `if (membership) { expel; softDelete; /* HEAD: expel again */ }
else { softDelete }`:

* `apps/web/src/app/api/ai/global/[id]/route.ts:161-163` — `} else { await
  globalConversationRepository.softDeleteConversation(userId, id); }`
* `apps/web/src/app/api/ai/page-agents/[agentId]/conversations/[conversationId]/route.ts:279-282`
  — `// Not a member of any workspace — no listing to protect, no lock needed.`

`findWorkspaceOfConversation` is a lock-free read on the pooled connection. Failure scenario,
inputs → outcome:

1. Thread `C` belongs to no workspace. User deletes it. `findWorkspaceOfConversation(C)` → `null`,
   so the `else` branch is taken.
2. Concurrently, `ensureGlobalSandboxSession`/the claim route admits `C` into workspace `W`:
   takes the lock, `readDeletedChatTargets` sees `isActive = true` (the delete has not
   committed), writes the node, commits.
3. The `else` branch's `softDeleteConversation` commits.

Outcome: a node in `W` bound to a dead thread, a permanently-held chat-target index slot, and
**no expel runs at any point** — neither the first (the branch has none) nor the second (it is
inside the `if`). The F2 mechanism proof above is the proof of step 2; the only difference is
that here nothing at all compensates.

The comment "no listing to protect, no lock needed" states a fact about the moment of the read,
not about the moment of the write.

---

## F4 — MEDIUM (at `f82d9345b`; fixed at HEAD): `session_reopened` had a test that could not fail for the behaviour it named.

See mutation **M9**. `it('treats a REOPENED session as a non-failure — the newer work keeps
its tree')` asserts only `result.ok === true`. `endSession` returns `ended` regardless of what
the destroy answers, so that assertion is byte-identical in power to the `no_root` test below
it. Deleting the entire `session_reopened` arm from `endSession` leaves **all 69 tests green**.
`c87e49526` rewrote it to assert the info-vs-error report; I re-ran the mutation against that
version and it now dies.

---

## F5 — MEDIUM, **NEW AT HEAD** (scoped out of this review's two commits, reported because it decides whether F1 is closed): `reopenListingIfPopulated`'s `EXISTS` is snapshot-based, not row-lock-based.

`packages/lib/src/services/agent-workspaces/agent-workspaces-store.ts:589-611` claims: *"both
conditions are evaluated against the row version this UPDATE locks, so a destroy cannot slip
between the emptiness test and the stamp."* The row `UPDATE` locks is in **`agent_workspaces`**.
The `EXISTS` subquery reads **`agent_workspace_nodes`**, a different table, under the
statement's own snapshot; no `EvalPlanQual` re-check is triggered because the concurrent
destroy never touches `agent_workspaces`. A destroy that commits after the statement's
snapshot and before the statement's commit is invisible to it:

```
reopenListingIfPopulated: EXISTS saw nodes, CAS matched -> staged, rows=1
destroyWorkspaceTree(requireEnded): endedAt still set -> tree DESTROYED and committed
reopen COMMITTED

FINAL: endedAt=NULL (live) nodes=0
>>> GHOST still reachable: the EXISTS is on a DIFFERENT table, so it is snapshot-based.
```

**Honest caveat:** I deferred the reopen's `COMMIT` to make the interleave deterministic. The
shipped statement is auto-commit, so the real window is the statement's own execution time —
sub-millisecond, versus the two-round-trip window it replaced. This is a large improvement and
not a regression. But the docblock asserts an impossibility the database does not provide, and
the residue is the same permanent ghost. If it is worth closing, the cheap way is to make the
destroy touch the `agent_workspaces` row too (any `UPDATE … SET updatedAt` inside the destroy's
transaction), which forces row-level serialization between the two statements.

---

# Claim C — `awaiting_backfill` interaction: sound

The highest-risk pairing, checked on every path the two features touch:

* **The guard is never consulted on the destroy path, and cannot be disarmed by it.**
  `destroyWorkspaceTree` passes `seed: false`, so the `awaitsBackfill` branch
  (`workspace-node-runtime.ts:385`) is skipped — pre-existing — and the `requireEnded`
  `within` is a pure read. Executable check on an un-backfilled, ended workspace (legacy
  `conversations.workspaceId` membership, no `agent_workspace_node_revs` row):

  ```
  PROBE destroy result = {"status":"ok","snapshot":{"rev":0,"nodes":[],"targets":[]},"changed":false}
  PROBE rev rows = []
  ✓ mints no rev row, so awaitsBackfill stays armed
  ```

  `produce` returns an empty write when there is no root, `decision.changed` is false, and the
  function returns before `writeWorkspaceNodes` — so no rev row is minted and `awaitsBackfill`
  still answers `true` afterwards.
* **Ordering cannot invert.** The `awaitsBackfill` refusal is returned *before* `produce`;
  `within` and `readDeletedChatTargets` both run after. A workspace awaiting backfill can never
  reach `target_deleted` instead of `awaiting_backfill`.
* **Neither new refusal can commit a partial write.** Both `throw` inside the transaction and
  are re-formed after rollback (`workspace-node-runtime.ts:566`), so a seed root computed for a
  refused write is never persisted. Verified by the integration test's
  `expect(after.nodes).toEqual([])`.
* **The backfill does not go through the funnel**, so `readDeletedChatTargets` cannot refuse
  it into a `SKIPPED` census entry (which, after `0256`, would be data loss). It writes via
  `writeWorkspaceNodes` directly (`scripts/backfill-agent-workspace-nodes.ts:89`) and its
  three source queries already filter `isActive = true`
  (`packages/lib/src/agent-workspaces/workspace-node-backfill.ts:207,299,586`) — so a
  soft-deleted legacy member is skipped by the planner, not refused by the funnel.
* **New refusal codes reach only local consumers.** `NodeWriteRefusal` is referenced nowhere
  outside `workspace-node-runtime.ts`; `applyWorkspaceMembershipWrite` folds `target_deleted`
  into its generic `'refused'`, and the nodes route answers it 400 with the code. No
  exhaustive switch was broken.

`0711ed897` is documentation only and I found nothing wrong with it; its claim that
`docker-images.yml` runs the migration one-shot and then deploys web is accurate (HEAD later
corrected "nothing between them" to name the `Deploy realtime` step).

---

# Mutation table

Run against the `f82d9345b` worktree over `end-session-composition.test.ts`,
`workspace-node-runtime.test.ts`, `workspace-node-chat-binding.integration.test.ts`
(69 tests, green at baseline).

| # | Mutation | Result | Test that died |
|---|---|---|---|
| M1 | `endSession` stops passing `requireEnded: true` | **DIES** | `destroys the tree with the workspace OWNER…`, `asks the destroy to REQUIRE the end still being in force` |
| M2 | `requireEnded` guard never fires (`if (false)`) | **DIES** | integration `REFUSES the destroy and leaves the tree standing` |
| M3 | liveness backstop removed (`const dead = []`) | **DIES** | mocked `is a typed refusal, and writes nothing`; integration `REFUSES a write that binds a conversation whose history is gone` |
| M5 | liveness asked BEFORE the ACL gate | **DIES** | `runs AFTER the ACL gate, so a refusal never confirms…` (+1) |
| M9 | `endSession` drops the whole `session_reopened` arm | **SURVIVES** | — see F4 |
| M4 | containment removed: liveness asked about the whole payload, not only INTRODUCED targets | **SURVIVES** | — see below |
| M8 | `target_deleted` RETURNS instead of THROWS | **SURVIVES** | — see below |
| M10 | `requireEnded` refuses when the workspace row is MISSING | **SURVIVES** | — untested defensive branch, low value |

**M4 is a test passing for the wrong reason.** Both tests that claim to pin containment
(mocked `is asked ONLY about targets the write INTRODUCES`, integration `does NOT refuse a pane
that ALREADY holds the thread`) use a **no-change** write, so `decision.persist.put` is empty,
`attemptedChatBindings` is empty, and the entire `if (attemptedChatBindings.length > 0)` block
— containment included — is skipped. They pass whether containment exists or not. I wrote the
probe the suite is missing (a write that introduces a live target *and* re-sends a pane still
holding a deleted one) and confirmed it: under M4 all 62 shipped tests stay green and only the
probe goes red —

```
REFUSAL CODE = target_deleted conversation(s) rayj957cjb6brkm96paidaoz no longer exist, …
× REVIEW PROBE — opening a new pane must not be refused because an OLD pane holds a deleted thread
Tests  1 failed | 62 passed (63)
```

The shipped code is **correct** here (`introducedPaneTargets` does the right thing); it is the
coverage that is absent, and the absent case is a user-visible one — a workspace where one pane's
thread was deleted would become unable to open any new chat pane.

**M8 is currently an equivalent mutation, but only by accident.** Returning instead of throwing
commits `within`'s rows without the node. It is unobservable today because the only writes with
a `within` create their own conversation (active by construction), so no co-introduced target can
be dead. The `throw` is right; nothing pins it, and the comment above it asserts a property no
test would catch the loss of.

---

# What I checked that this prompt did not ask about

* **`endSession`'s caller contract end to end.** `endSession` is also the scratch-session
  cleanup path (`api/agent-workspaces/route.ts:446/495/544/601`, all `.catch(() => {})`), so a
  `session_reopened` refusal there silently leaks a live session against
  `MAX_ACTIVE_WORKSPACES_PER_OWNER`. Low probability (it takes a concurrent admission into a
  session that was just spawned and whose claim failed), noted rather than filed.
* **HTTP surface of the two new refusal codes.** `target_deleted` falls through the nodes route
  to a 400 whose message is `That write would not leave a valid workspace` — a liveness fact
  wearing a validation label. Cosmetic; it does carry the machine-readable code, and it runs
  after the ACL gate so it is not an existence oracle. `session_reopened` cannot reach any route.
* **Whether the `requireEnded` refusal can strand a Sprite.** It cannot: `endAgentSession`'s
  stamps land before the destroy, `spriteTornDownAt` survives `planSessionReopen`, and both
  `ensure` (re-provision) and the orphan reconciler (skips confirmed kills) behave correctly.
  Traced through `plan-workspace-lifecycle.ts` rather than taken from the commit message.
* **`attach` after a reopen** denies with `session_torn_down` until an `ensure` runs. Pre-existing
  `planSessionReopen` semantics, not caused by these commits — flagged because the commit message's
  "which is the state every resumed session is in" is true of `ensure` and false of `attach`.
* **Isolation level in play**, since the whole argument depends on it: `read committed`, server
  default, and `withWorkspaceLock` sets nothing (`packages/lib/src/services/agent-workspaces/workspace-lock.ts:54-58`).
* **Whether the advisory-lock hash could collide** and mask a race in testing —
  `hashtext()` is 32-bit, collisions over-serialize only. Not a correctness issue, as documented.
* **The `0711ed897` deploy narrative against `.github/workflows/docker-images.yml`.** Accurate.

## Reproduction scripts

Left in the session scratchpad (not committed, and the fixtures they create are deleted):
`proof_a.mjs` / `proof_a2.mjs` (F1, forced and natural lock-queue orderings), `proof_b.mjs`
(F2), `proof_lock.mjs` (reopen is not serialized by the workspace lock; isolation level),
`proof_c.mjs` (F5). All run against `postgresql://user:password@localhost:5433/pagespace_test`
with `node_modules/pg`.

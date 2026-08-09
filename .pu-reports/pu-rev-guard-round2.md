# Adversarial review round 2 — the rewritten `awaiting_backfill` guard (`c20aa13bd`)

Reviewer: second independent adversarial pass, reviewing the FIX for
`.pu-reports/pu-rev-session-guard.md`'s F1–F6. Nothing in `c20aa13bd` had been
reviewed by anybody.

Everything below was run against the live test Postgres
(`postgresql://user:password@localhost:5433/pagespace_test`, migration tip
`when = 1786296184692`). `@pagespace/lib` was rebuilt after every source edit,
including the final revert; `git status --porcelain` is empty apart from this
report.

---

## Headline

**The rewrite fixes F2, F4, F5 and F6 cleanly and I could not break any of
them. It does NOT fix F1 — it inverts it.** The exemption added for ended
workspaces makes the guard wave through the one write that puts an
un-backfilled workspace back into the backfill's scope with a tree already in
it, at which point the backfill skips it as `alreadyMigrated` and its remaining
legacy threads are stranded permanently, with the census printing `✅ clean`.
Proven end-to-end against the real `claimConversationInSession`, the real
`backfill()`, and a control that shows the same workspace migrates fine without
the claim.

Two further findings: the predicate's third clause is narrower than the set the
backfill actually migrates (panes and shells are invisible to it), and the whole
`awaiting_backfill` propagation this commit adds — both routes' 503s, the create
path's `cause`, and both deciders' `case` arms — has **zero** test coverage:
disabling all five sites leaves 425 tests green.

| # | Sev | Finding |
|---|-----|---------|
| G1 | **CRITICAL** | The ended-workspace exemption strands: a claim into an ended un-backfilled workspace is allowed, `planSessionReopen` clears `endedAt`, and the now-live workspace is skipped as `alreadyMigrated`. Census clean. |
| G2 | **HIGH** | Clause 3 counts only `conversations.workspaceId`; the backfill also derives nodes from legacy PANE rows and from SHELLS. A workspace whose legacy content is panes/shells is seedable and then skipped. |
| G3 | **HIGH** | Every line of the `awaiting_backfill` propagation added by this commit is untested. Five simultaneous mutations reverting it wholesale: `Tests 425 passed`. |
| G4 | LOW | `writeWorkspaceNodes` mints the rev row unconditionally, even for an empty write. The "monotonic backfill marker" property holds only because its single caller short-circuits on `!decision.changed` — it is a property of the caller, documented as a property of the table. |

---

## A. Is the rev row actually a monotonic backfill marker?

**VERDICT: the monotonicity claim is TRUE. The false-negative hunt found no
production path that mints a rev for an un-backfilled workspace — but see G4 for
why that is a caller property, not a table property.**

Every INSERT into `agent_workspace_node_revs` in the tree
(`grep -rn agentWorkspaceNodeRevs --include=*.ts`):

| site | when | verdict |
|---|---|---|
| `workspace-node-store.ts:500` (`writeWorkspaceNodes`) | every persisted write | only caller is `commitUnderLock:511`, which is behind the guard on the seed path and behind `decision.changed` otherwise |
| `backfill-agent-workspace-nodes.ts:334` (`writeWorkspace`) | `rev = 0`, same transaction as the nodes, `onConflictDoNothing` | the marker, as claimed |
| tenant import | — | `agent_workspace_node_revs` is in `TENANT_EXPORT_EXCLUDED_TABLES`; the import creates NO rev rows |

Nothing deletes a rev row. `destroy` issues `DELETE FROM agent_workspace_nodes`
only; the rev row is a separate table with `ON DELETE cascade` from
`agent_workspaces` alone.

### The false-negative probes (real functions, real DB)

```
P-A1 destroyWorkspaceTree on an EMPTY un-backfilled workspace
     destroy status ok   revRows 0   awaitsBackfill still true
P-A2 applyWorkspaceNodeWrite put:[] drop:[]
     refused awaiting_backfill   revRows 0
P-A3 applyWorkspaceNodeWrite put:[] drop:['ghost']   (semantic no-op, non-empty drop)
     refused awaiting_backfill   revRows 0
P-A4 write a root, then destroyWorkspaceTree
     after destroy: nodes 0   rev 2   revRows 1     ← marker survives the destroy
```

`destroyWorkspaceTree` is the only `seed: false` caller and therefore the only
one that skips the guard. It cannot mint a rev on a workspace with no tree:
`produce` returns `{put: [], drop: []}`, and `decideNodeWrite` computes
`changed = changedPut.length > 0 || persist.drop.length > 0` = `false`, so
`writeWorkspaceNodes` is never reached (P-A1). A `drop` naming an id that is not
there is likewise absorbed — `persistedWrite` derives `drop` from
`nodes \ next`, not from the payload (P-A3). Note that P-A2/P-A3 never even get
that far: the guard runs before `produce`, so an empty write to an
un-backfilled workspace is itself refused.

I also checked the tenant-import shape, which is the one place nodes can arrive
without a rev row. `conversations.workspaceId` and `closedInWorkspaceAt` are
both in `TENANT_EXPORT_COLUMNS.conversations.excluded`, so clause 3 is
identically false on an imported tenant and the missing rev row cannot brick
anything. `readWorkspaceNodeSnapshots`' `FULL OUTER JOIN` + `COALESCE(rev, 0)`
covers the read side. Sound.

---

## B. Can the new predicate still brick or still strand a workspace?

**VERDICT: REFUTED. G1 (strand, CRITICAL) and G2 (strand, HIGH). I found no
remaining permanent REFUSAL — the brick direction is genuinely fixed.**

### G1 — CRITICAL. The ended exemption hands the stranding straight back

The docblock's clause-1 argument is:

> `backfill()` paginates `endedAt IS NULL`, so an ENDED workspace is one it will
> never visit. Its legacy rows are not going to be migrated by anybody, which
> means **there is no stranding left to prevent**…

That is true only while the workspace stays ended. It does not stay ended. The
write the exemption exists to permit — a claim into an ended workspace, issue
#2335 — is exactly the write that **un-ends** it: `admitConversationNode` calls
`reopenEndedSessionListing` (`planSessionReopen`) on every successful
admission. The workspace is then live, holds a tree, and is in the backfill's
scope for the first time — where `loadAlreadyMigrated` (a bare
`SELECT DISTINCT rootId FROM agent_workspace_nodes`) counts it as
`alreadyMigrated`.

**Proved end-to-end** against the real `claimConversationInSession` and the real
`backfill()`. Workspace `W`, ended, un-backfilled, three live legacy threads
`c1`/`c2`/`c3` (`conversations.workspaceId = W`, `isActive`,
`closedInWorkspaceAt IS NULL`):

```
STEP0 awaitsBackfill(ended)                = false          ← the F1 fix
STEP1 claimConversationInSession(c1, W)    = 'claimed'
STEP2 endedAt after claim                  = null           ← planSessionReopen
STEP3 nodes = 2   revRows = 1                               ← root + c1's chat node
STEP4 awaitsBackfill(now live, has nodes)  = false
STEP5 backfill({dryRun:false, only:W})
      → {workspacesScanned:1, alreadyMigrated:1, written:0, skipped:0, failed:0}
      → "✅ clean — every scanned workspace is accounted for, and 0256 may be applied"
STEP6 c2 chat nodes: []
      c3 chat nodes: []
```

Control, same fixture, no claim:

```
CONTROL written 1   chat nodes 2   (both legacy threads migrated)
```

**Failure scenario.** A deployment where step 4 (the app image) landed before
step 3 (the backfill) — the operator-sequencing mistake this entire guard exists
to defend against. A user opens an ended session from history and clicks a
thread, or an agent claims one into it. `checkSessionAccess` has no `endedAt`
term (`decide-workspace-access.ts` never mentions it), so the claim route path
is fully open to an ordinary user. The claim succeeds, the session reopens, and
`c2`/`c3` lose their membership permanently. After `0256` drops
`conversations.workspaceId` they belong to nothing, read as homeless, and become
claimable into a DIFFERENT workspace — the exact outcome the backfill's own
header calls out. The census exits 0 and prints `✅ clean` over it.

The previous predicate REFUSED this write (that was F1). The rewrite allows it
and loses the data instead. Both are wrong for the same underlying reason: the
guard's scope and the backfill's scope are being reconciled by exempting
workspaces from the guard, when the mismatch is in the backfill —
`backfill()`'s `isNull(agentWorkspaces.endedAt)` (line 373) and
`loadChatClaims`' matching filter. Dropping those two filters would make clause
1 unnecessary and would also close the pre-existing hole that **every** ended
workspace's threads go homeless at `0256`, guard or no guard, with the census
clean. I would fix the scope, not the guard.

### G2 — HIGH. Clause 3 asks about a strict subset of what the backfill migrates

Clause 3 is `conversations.workspaceId = W ∧ isActive ∧ closedInWorkspaceAt IS
NULL ∧ NOT EXISTS (chat node)`. The comment calls it "is there anything left to
strand?". The backfill's source set is wider:

```
sources = pane rows (agent_workspace_panes)      → chat / terminal / page nodes
        ∪ open conversations (workspaceId = W)   → chat nodes           ← the only one clause 3 sees
        ∪ shells (agent_workspace_shells)        → terminal nodes
```

So a live workspace with legacy content but **no** row in the middle set is
seedable, and the backfill then skips it.

**Proved, chat variant.** `W` holds a legacy chat pane naming conversation `C`
whose `workspaceId` is NULL (a pane naming a thread outside the workspace's own
listing — the backfill's own doc calls this "reachable today", and
`resolveChatClaims` rule 2 exists precisely to arbitrate it):

```
P-B1 CONTROL  awaitsBackfill = false
              backfill --apply → nodes for C: [{rootId: W}]        ← C IS migrated
P-B2 SAME shape, one ordinary applyWorkspaceNodeWrite first
              awaitsBackfill = false
              app write: ok                                        ← guard does not fire
              backfill --apply → scanned 1, alreadyMigrated 1, "✅ clean"
              nodes for C: []                                      ← C has NO node anywhere
```

**Proved, shell variant.** `W` holds one `agent_workspace_shells` row and
nothing else:

```
P-B3 awaitsBackfill = false → app write ok → backfill alreadyMigrated 1
     terminal nodes for shell: 0
```

**Proved, ended-owner variant.** A chat pane in `W` naming a thread whose
`workspaceId` points at an ENDED workspace (so `loadChatClaims`'
`membershipOwner` query, which carries `isNull(endedAt)`, yields no owner and
the pane wins the claim):

```
P-B4 awaitsBackfill(W) = false
```

Severity split: the chat variant is membership loss of the same kind as G1 (the
thread ends up homeless and cross-claimable). The shell and page-pane variants
are layout loss plus an orphaned shell row — recoverable by the user reopening
things, but silent and permanent for the arrangement.

This hole existed identically in the previous predicate, so it is not a
regression introduced by `c20aa13bd`. It is unfixed, and the new docblock states
it as fixed ("every clause is chosen to make the predicate STOP being true once
the backfill has done its job"), which is why it is reported here.

### What I checked and could NOT break

- **Does the backfill mint a rev for every workspace it processes?**
  `deriveWorkspaceNodes` always emits the root node first
  (`rootId = ids.allocate(`${workspaceId}::root`, 'root')`), so `derived.rows`
  is never empty and `writeWorkspace`'s `.values([])` case is unreachable. Both
  inserts are in one `db.transaction`, so nodes-without-rev and rev-without-nodes
  are impossible from this producer.
- **Skipped and write-failed workspaces.** Both `continue` before
  `writeWorkspace`, so they get neither nodes nor a rev row — the guard stays
  armed (correct), and `runIsClean` makes the run exit non-zero, so the gate
  catches them. Verified by reading `recordNotWritten` / `runIsClean` and by
  the P-C1 dry run, which reports `would write 1` for a guarded workspace.
- **Resume.** `loadAlreadyMigrated` keys on nodes, not on the rev, so a
  workspace with a rev and no nodes is re-derived and re-written, and the rev
  insert's `onConflictDoNothing` leaves the counter alone. Correct.
- **F2 itself.** `destroyWorkspaceTree` on a backfilled workspace leaves
  `revRows 1` and `rev 2` (P-A4), so the next write is not re-guarded. Fixed.

---

## C. Does the guard's placement still hold?

**VERDICT: VERIFIED.**

Every production insert into `agent_workspace_nodes`:

| site | guarded? |
|---|---|
| `workspace-node-store.ts:482` (`writeWorkspaceNodes`) | its only production caller is `commitUnderLock:511`, downstream of the seed guard |
| `backfill-agent-workspace-nodes.ts:330` | the migrator; must not be guarded |
| tenant import (bundle SQL) | imports a complete node set, so nothing can be stranded |

`gdpr-export.ts:1001` and `workspace-membership-store.ts` are reads.
`scripts/__tests__/setup.ts:327` and the app's own `__tests__` are fixtures.

`rootOf(before.nodes) === undefined` ⟺ the workspace has no node rows: the
`agent_workspace_nodes_root_no_parent_chk` biconditional plus the composite
self-FK make a parentless non-root and a parented orphan both unrepresentable,
so a non-empty node set always contains a root. The guard therefore covers every
first-row insert through the funnel. `destroyWorkspaceTree` is the only
`seed: false` caller and provably writes nothing on an empty tree (P-A1).

---

## D. Is `awaiting_backfill` propagated correctly?

**VERDICT: the wiring is correct and exhaustive. The SECURITY question is a
non-issue. But see G3 — none of it is tested.**

Traced every consumer of the three outcome types:

| consumer | handling | verdict |
|---|---|---|
| `admitConversationNode` (`agent-workspaces-runtime.ts:302`) | named before the `refused` fallthrough | ✔ |
| `claimConversationInSessionWith` switch | exhaustive `switch` with no `default`; TS enforces | ✔ |
| `reopenConversationInSessionWith` switch | same | ✔ |
| `reopenConversationInSession`'s `readmitConversation` switch | same | ✔ |
| `POST …/claim` route | 503 + `code` | ✔ |
| `POST …/reopen` route | 503 + `code` | ✔ |
| `POST …/nodes` route | 503 (pre-existing, tested) | ✔ |
| `createConversationInSessionWith` | `ConversationUnavailableError({cause: Error('awaiting_backfill')})` | ✔ |
| `POST /api/agent-workspaces` `wantsClaim` (route.ts:536) | falls into the generic 502 + `endSession` | unreachable — the workspace was spawned microseconds earlier, so clause 3 is false |
| `ensureConversationSession` (runtime.ts:783) | falls into "claim lost" cleanup | unreachable for the same reason |
| `closeConversationInSession`'s `dismissConversation` | flattens to `'refused'` | writes nothing; a dismiss on an un-backfilled workspace is a silent no-op rather than a lie. Low, noted, not a finding |
| `expelConversationFromSession` | logs `reason: 'awaiting_backfill'` and returns `'refused'` | the code survives into the log line. ✔ |
| `applyLayoutCommandForWorkspace` | `{ok:false, reason: result.code}` | the code survives. ✔ |

**The 503-as-oracle question — weighed, and it is not a leak.** To reach the
claim route's 503 a caller must pass, in order: `checkSessionAccess` (which
answers `workspaceNotFoundOrDenied` — the deliberate 404/403 blend — for a
workspace they cannot reach), then `row.userId !== userId → not_found`, then
`isActive`, then `type`, then `findWorkspaceOfConversation(...) === null`, then
`findSession(...) !== null`, then the drive rules. Every id-guessing branch has
already answered 404 by the time `admitConversation` is called. So the 503 is
only ever shown to a caller who already owns the conversation and already has
proven access to the workspace — it tells them nothing they could not learn from
a `GET`. The reopen route is gated identically. No finding.

### G3 — HIGH. None of the propagation is tested

I disabled **all five** propagation sites at once — both route 503 blocks, the
create path's `cause` branch, and both deciders' `case 'awaiting_backfill'` arms
(regressed to `'not_found'` / `'not_in_session'`, i.e. exactly the F3 bug the
commit claims to fix) — rebuilt, and ran the whole surface:

```
$ bun run --filter web test -- src/lib/agent-workspaces src/app/api/agent-workspaces
 Test Files  31 passed (31)
      Tests  425 passed (425)
```

Green. The only `awaiting_backfill` assertion in the repo is
`…/nodes/__tests__/route.test.ts:180`, which predates this commit.

**Failure scenario.** F3 was reported, fixed, and can now be un-fixed by a
one-line edit — or by a merge — with CI green, returning the one unrecoverable
refusal on the path to arriving as "that conversation does not exist". The
commit message says "Every clause is now mutation-checked, one test dying per
clause"; that is true of the predicate and false of the propagation, which is
more than half the diff.

A related latent trap: neither route has an exhaustiveness check on `outcome`.
With the 503 block removed, the claim route falls through to
`NextResponse.json({ok: true, alreadyInSession: false})` — a **200 OK** for a
write that never happened. Nothing in the type system or the tests notices.

---

## E. The test suite

**VERDICT: the predicate's tests are real and every clause is independently
lethal. I verified all seven mutations myself rather than taking the claim, and
found no test passing for the wrong reason.**

`apps/web/src/lib/agent-workspaces/__tests__/workspace-node-chat-binding.integration.test.ts`
— baseline `16 tests`, all green.

| # | Mutation | Observed | Verdict |
|---|---|---|---|
| M1 | `takesChatTarget = false && …` (chat release disabled) | **3 failed** — "ACCEPTS a hand-off within one workspace", "SWAPS two conversations in one write", **and** "hands a conversation to a node that stays, unbinding the one that had it" | **F6 fixed** — the previously-lucky third test now bites |
| M2 | drop `endedAt IS NULL` (clause 1) | 1 failed — "ALLOWS an ENDED workspace … (F1)" | covered |
| M3 | drop the `NOT EXISTS (rev row)` (clause 2) | 1 failed — "ALLOWS a backfilled workspace whose tree was later DESTROYED by endSession (F2)" | covered |
| M4 | drop `isActive` (clause 3a) | 1 failed — "ALLOWS when the only legacy member is HISTORY-DELETED (F4)" | **F4 fixed** |
| M5 | drop `closedInWorkspaceAt IS NULL` (clause 3b) | 1 failed — "ALLOWS when the only legacy member is DISMISSED (F4)" | **F4 fixed** |
| M6 | scope the chat-node `NOT EXISTS` by `rootId` | 1 failed — "ALLOWS when the legacy pointer is STALE and the node lives in another workspace" | covered |
| M7 | clause 3 always true (`return true` after clauses 1–2) | 4 failed, incl. "ALLOWS a workspace with no legacy membership at all" | covered |
| M8 | `if (false && seedIfMissing && …)` — guard call site disabled | 1 failed — "REFUSES the seed, rather than stranding the membership it cannot see" | covered |
| M9 | claim + reopen `case 'awaiting_backfill'` regressed to `not_found` / `not_in_session` | **425 passed** | **NOT covered → G3** |
| M10 | both routes' 503 blocks + create's `cause` branch disabled | **425 passed** | **NOT covered → G3** |
| M11 | `decideNodeWrite` flipped to the algebra's put-then-drop order | 1 failed — "resolves as \"put wins\", and the storage instruction agrees with the tree" | **F5's behaviour is genuinely load-bearing and genuinely guarded** |

Every mutation was reverted and `@pagespace/lib` rebuilt after each; the final
`git status --porcelain` is empty apart from this report.

The F1/F2/F4 tests are honest — each names the state it constructs, and each
dies under exactly one clause deletion, which is what I would want. My complaint
is not with these tests but with what is missing beside them: nothing in the
suite exercises `awaitsBackfill` against a workspace whose legacy content is a
pane or a shell (G2), and nothing exercises a claim into an ended workspace
followed by a backfill run (G1).

---

## F. Were F5 and F6 fixed well, and was the reverted attempt clean?

**VERDICT: VERIFIED, all three parts.**

- **The revert is complete.** `git diff 11df94c65..HEAD --
  packages/lib/src/agent-workspaces/workspace-node-algebra.ts` is **empty** —
  `applyNodeWrite`'s put-then-drop order is untouched. The only change to
  `workspace-node-write.ts` in the whole range is the comment block; the
  `upsertNodes(removeNodes(nodes, drop), incoming)` line is byte-identical to
  `11df94c65`. Nothing half-changed was left behind.
- **The new comment is accurate.** It attributes drop-then-put to
  `decideNodeWrite`, states that `applyNodeWrite` folds the other way, and cites
  the algebra's own docblock ("PUT FIRST, THEN DROP, and the order is
  load-bearing BECAUSE OF THE CASCADE") — which says exactly that. The claim
  that the divergence is benign is correct: the server stores the node, the
  client's optimistic view drops it, and the broadcast carries the server's tree.
- **And the behaviour it describes really is load-bearing.** M11 above: flipping
  `decideNodeWrite` to the algebra's order kills the test that asserts the DELETE
  does not name an id that is in both sets, which is the cascade protection. So
  the author was right to revert and right about why.
- **F6.** The `put` entries were swapped so the taker is written first, and M1
  now kills all three tests the docblock names — including the one that
  previously passed by row-order luck.

---

## Gates

| gate | result |
|---|---|
| `bun run typecheck` | **`Tasks: 17 successful, 17 total`** |
| `bun run --filter @pagespace/lib test` (with `DATABASE_URL`) | `Test Files 1 failed \| 418 passed \| 2 skipped (421)`, `Tests 9251 passed` — the single failure is `gdpr-eraser.integration.test.ts` / `ADMIN_DATABASE_URL is not set`, environment-only and identical on any branch |
| `bun run --filter web test -- src/lib/agent-workspaces src/app/api/agent-workspaces` | `Test Files 30 passed (30)`, `Tests 414 passed (414)` |
| `git status --porcelain` | only `.pu-reports/pu-rev-guard-round2.md` |

---

## What I checked that this prompt did not ask about

- **`checkSessionAccess` has no `endedAt` term.** `decide-workspace-access.ts`
  never mentions `endedAt` at all, which is what makes G1 reachable over plain
  HTTP by any drive member rather than only through an internal path.
- **The backfill's ended-workspace blind spot in general.** `backfill()` line
  373 and `loadChatClaims`' `membershipOwner` join both carry
  `isNull(agentWorkspaces.endedAt)`. Independently of the guard, this means
  **every ended workspace's live threads get no node at all**, and `0256` then
  drops the column that knew where they lived — so they go homeless with the
  census exiting 0. That is a pre-existing property of the migration, not of
  this commit, but it is the load-bearing assumption under clause 1 and it is
  worth an explicit decision before cutover rather than an implicit one.
- **The tenant export/import round trip.** `agent_workspace_node_revs` excluded,
  `agent_workspace_nodes` carried, `conversations.workspaceId` /
  `closedInWorkspaceAt` excluded — so an imported tenant has clause 2 true for
  every workspace and clause 3 false for every workspace. Consistent, and the
  `FULL OUTER JOIN` read covers the nodes-without-rev shape. No interaction.
- **`decideNodeWrite`'s `changed` on adversarial no-ops.** An unchanged re-put,
  an empty write, and a `drop` naming a nonexistent id all compute
  `changed = false`, so none of them can mint a rev (G4 is about the store's own
  lack of that guarantee, not about the current callers).
- **`writeWorkspaceNodes`' unconditional rev mint (G4).** The rev insert sits
  outside both `if (write.drop.length > 0)` and `if (write.put.length > 0)`, so
  the function will happily mint `rev = 1` for a workspace it wrote nothing to.
  Today only `commitUnderLock` calls it and only after `decision.changed`, so
  nothing is wrong — but the docblock for `awaitsBackfill` states the marker
  property as a fact about the table ("`writeWorkspaceNodes` only ever
  increments it"), when it is actually a fact about one caller's short-circuit.
  A second caller — a future "touch the workspace" or a repair script — would
  silently disarm the guard for every workspace it touched. Worth one sentence
  in `writeWorkspaceNodes`' own doc, or an early return when both sets are empty.
- **`closeConversationInSession` flattens `awaiting_backfill` to `refused`.**
  Nothing is written and nothing is lied about, so this is not F3 recurring —
  but it is the last member-facing path where the code does not survive.

---

## Recommendation

Do not ship the guard as it stands. G1 is the same severity as the F1/F2 it was
written to fix and is reachable by an ordinary user through a supported
affordance, and G3 means the F3 fix is one careless edit from silently
reverting.

The shape that closes G1 and G2 together is to stop reconciling the guard's
scope with the backfill's by exempting things from the guard, and instead widen
the backfill: drop `isNull(agentWorkspaces.endedAt)` from `backfill()` (line
373) and from `loadChatClaims`' `membershipOwner` join, so ended workspaces are
migrated like any other. Clause 1 then has no reason to exist, ended workspaces
stop losing their threads at `0256`, and "the guard refuses" and "the backfill
will fix it" become the same set for real rather than by exemption. Clause 3
should then be widened to the backfill's actual source set — `EXISTS (a legacy
pane row) OR EXISTS (a shell with no terminal node) OR` the current
conversations clause — or, more simply, replaced with "this workspace has any
legacy pane row or any live legacy conversation", which is cheap and cannot
under-count.

Whichever is chosen, G3 should be closed in the same change: one test per
propagation site, or at minimum one route test per 503, because a fix nothing
guards is a fix with a shelf life.

# pu-wnt-client — the client side of the node cutover

Branch `pu/wnt-client`. Phase 4: the sidebar and the pane grid become two
renderings of one live tree, and there is nothing left to synchronise.

**Status: complete.** Not opened as a PR, not merged.

---

## What I built, per item

### 1. The store reads the tree

`useAgentWorkspaceStore.ts` is rewritten on nodes (1022 → 720 lines). The verb
queue is gone; `verb-queue.ts` and `pane-labels.ts` are **deleted**, with their
four suites.

The equation is unchanged in shape and simpler in substance:

```
rendered = rebasePending(serverNodes, unackedWriteSets)
```

A queue entry is now a `{put, drop}` — the write the algebra already produces —
so `opId`, `verbAlreadyLanded`, `mintedPaneId`/`mintedColumnId` and the
idempotency memory all went with the shape that needed them: an upsert of a node
set is idempotent by construction.

**`hydrateFromServer` has the no-op early-out**, and it is load-bearing rather
than cosmetic — the sidebar seats every listed workspace on every revalidation.
Same rev, a base already held, nothing pending **and identical targets** returns
without touching state at all.

> **One deviation, deliberate.** The prompt specified `equal rev + non-null base
> + empty pending → return the SAME object`. I added a fourth term: the targets
> must also be deep-equal. A title is not part of the rev — a rename lands at an
> unchanged rev — so the three-term version would strand a renamed thread under
> its old name until its next *structural* edit. The identical-revalidation case
> the early-out exists for still returns the same object (targets compare equal),
> so nothing the prompt asked for is lost. Pinned both ways: *"should return the
> SAME object for an identical re-seat"* and *"should still adopt a RENAME at an
> unchanged rev"*.

The prompt said this function is "otherwise already correct: it spreads
`...sync`, so pending writes survive". That is true of the spread and **not
sufficient** — see finding **A** below, which is the one real defect I found in
the specified design.

New pure module `node-writes.ts` (the successor to `verb-queue.ts`):
`makePending` · `unionWrites` · `rebasePending` · `isAdoptableTree`.

### 2. Broadcast on the owner's plane

`broadcastWorkspaceNodesUpdated` fans out to `sessionRoom(rootId)` **and**
`userSessionsRoom(ownerId)`. `ownerId` is read inside the existing
`withWorkspaceLayoutLock` transaction (`readWorkspaceOwnerId(tx, …)`), never as a
query on the hot path, and it is stripped from the payload before emission —
it is routing, not content.

**The prohibition is written down and asserted.** `agent-workspace-events.ts`
carries the argument in full (`decideAgentSessionAccess` admits any drive member
while `listSessions` filters on `ownerId`, so a `drive:<driveId>` room is a
workspace-enumeration oracle), and
`__tests__/agent-workspace-events.test.ts` has *"reaches no other room — never
the drive"*. It fails closed: an owner that cannot be read means the event does
not reach the owner's plane, never that it reaches somebody else's.

### 3. A global layout listener

`lib/realtime/workspace-nodes-listener.ts`, mounted once in
`GlobalChatContext.tsx` **beside** `SessionDirectoryListener` — a sibling, not a
branch inside it, because that module's own doc scopes it to SWR surgery on the
conversation listings and this plane is a zustand store with a rev watermark.
Double delivery is free: the rev guard is armed synchronously by the first copy.

### 4. The sidebar renders the live tree

`AgentsSidebar.tsx` selects the workspace object whole and `useMemo`s every
derivation. No filter is inlined into a selector anywhere.

- The listing seats each workspace's tree into the store; the rows then read
  **only** the store.
- Titles come from `targets[]`. `pane-labels.ts`, `carryPaneLabelsForward`,
  `hasUnknownBoundTarget` and `scheduleLabelRefresh` are all deleted.
- **Detached nodes render**, dimmed, with `(not open)` in the title attribute,
  and a parked row's click un-parks it. Mutation **M9** proves it.
- The row menu and the row action read one state: `conversationPlacement(tree,
  id)` decides both the label (*"Close pane"* vs *"Close conversation"*) and what
  the click does. A test drives a broadcast between render and click and asserts
  the menu followed it.

Supporting server change: `readWorkspaceNodesBulk` (the two-line wrapper the
previous phase left for its caller) and `{rev, nodes, targets}` per session on
`GET /api/agent-workspaces`.

### 5. Recursive rendering

`SessionPanes.tsx` renders one `ContainerGroup` per container at any depth —
which **removed** the two hard-coded levels rather than adding a case. Pinned by
a three-deep nesting the two-level model could not express. `AgentPanes.tsx` has
no mount-time seed and no `!workspace` spinner.

### 6. Closing the last pane leaves an empty grid

`decideClosePane` drops from five branches to two. `end-session` and
`rebind-pane` are gone; `closePane` no longer returns `'session-ended'`. The
retired branches are asserted as **non-outcomes**, because "we stopped writing
that code" and "that outcome can no longer happen" are different claims.

---

## Two things the prompt did not anticipate, and both blocked it

### A. `hydrateFromServer`'s spread preserves pending writes. That is the bug, not the fix.

The prompt says the function "is otherwise already correct: it spreads
`...sync`, so pending writes survive and replay on the new base." The spread is
correct and **replaying is not always safe**, which the specified design has no
term for.

`applyNodeWrite` is put-then-drop and `put` is an **upsert**. So a pending
`resize(X)`, rebased onto a server tree in which somebody else closed and
destroyed `X`, cheerfully appends `X` back — a pane the user destroyed returning
with its binding intact. Nothing in `validateTree` objects: the resurrected node
is structurally fine. **Idempotence and still-applies are different properties,
and only the second can be decided against a base.**

Fix: every pending write records the ids it **minted** (measured against the tree
it was computed from), and `rebasePending` refuses one whose `put` names a node
that is neither in the tree it is landing on nor minted by the write itself.
Refuses whole, never partially — and reports it, as a new
`WorkspaceQueueError` reason `'superseded'`, so the user is told their edit was
dropped instead of watching it evaporate. Mutations **M1**/**M2**.

### B. Nothing creates a root. "The root always exists server-side now" was not yet true.

Item 5 rests on it, and it was false: outside `workspace-node-backfill.ts`,
nothing in the repo emits a `nodeType: 'root'`. A freshly spawned workspace had
zero node rows, so `open()` answered `no_root` and **every** placement failed —
the client would have rendered an empty grid forever.

Fix: `seedRoot(nodes, workspaceId)` in the shared commands layer, run by the
server's write funnel **and** the client's `runCommand`, so both mint the same
node. **The id is derived from the workspace id, not minted**, and that is the
whole design: two clients racing to seed an unseeded workspace otherwise produce
two roots, which `oneRootPerWorkspace` refuses and `validateTree` calls
`multiple_roots` — a workspace that becomes unwritable on a race. Derived, the
two writes are the *same* write and converge on the upsert. It is folded into the
write that needs it (never a separate transition), and it refuses to mint over an
id already held by something else.

This retires the `ensure` verb the browser used to post on mount — the
create-then-attach shape the flat model exists to delete, and the direct cause of
the production workspaces holding zero panes.

---

## The handoff from the runtime cluster

### 1. The sidebar's placement field — resolved by not having one

Their leaf deletes `annotateConversationsWithPanes` and moves the route from
`pane: {paneId, columnId, orderIndex}` to `attached` + `nodeId`. Their branch
(`pu/wnt-runtime`) is still at my own base commit, so none of it is visible here.

**I did not move onto `attached`, and the reason is item 4 itself.** My sidebar
reads no server placement field at all — it derives placement from the live tree:

```
conversationPlacement(tree, id) → { placement: 'grid' | 'parked' | 'unplaced', nodeId }
```

`'grid'` is their `attached: true`, `'parked'` is `attached: false` with a node,
`'unplaced'` is no node. Three values where their wire has two, and — the part
that matters — **from the store rather than from a poll**. Consuming a server
annotation would reinstate exactly the staleness item 4 was written to remove:
the row menu reading a 120s-old field while the row action reads the live store.
Their two fields become dead weight on the wire for this consumer; deleting them
is their leaf's call, and nothing of mine will break when it lands.

**The fixture is gone.** The rewrite removed the
`annotateConversationsWithPanes` import and the whole `pane`/`columnId`/
`orderIndex` fixture shape from `AgentsSidebar.test.tsx` before the handoff
arrived — verified by grep, not by assumption. Nothing there describes a shape
nothing sends.

### 2. The dead branch in `session-directory-listener.ts` — deleted

`changes.closedInWorkspaceAt` is removed, and the test now asserts the
**non-outcome** (*"should do nothing — that plane moved"*) rather than being
deleted alongside it. Mutation **M22** confirms reinstating the branch goes red.

I checked it is safe to delete **before** their writers go, rather than assuming
it: both directions are still covered by more specific handlers that are
independently tested here — `CONVERSATION_EVENTS.closed` drops the row outright,
`reopened` re-reads. The branch's unique contribution was a full revalidate on a
membership stamp, and that fact now rides structurally on
`workspace:nodes-updated`.

I did **not** remove the `closed`/`reopened` handlers themselves. They were not
named in the handoff, they still fire on this branch, and removing a handler for
an event that currently exists is the riskier half of the same idea.

### 3. The read-side containment check — no compensating check added

Understood and complied with. I did not add one, and I did not want to. Recording
the one thing I noticed while working next to it: `resolveTargetsByWorkspace`'s
chat gate is `belongsHere || accessibleConversations.has(id)`. If containment
becomes vacuous, that disjunction degrades to `true || …` — the gate stops being
a gate *at this call site* even though the write-side check is doing the real
work. Worth deleting the dead half rather than leaving a disjunction whose first
term is always true, because the next reader will take it for a live check. Their
leaf, not mine.

---

## Illegal inputs, enumerated before writing, each tested

✔ = a test fails if the behaviour changes.

| Input | What happens | ✔ |
|---|---|---|
| a broadcast for a workspace the store just **forgot** | ignored — inventing an entry would resurrect a closed tree | ✔ |
| a broadcast for a workspace **never opened** | ignored — the owner's room carries every workspace they own; the store is a cache of what is open, not a mirror of the account | ✔ |
| a broadcast at a rev the store **already has** | dropped, `rev <= sync.rev` | ✔ |
| the **same event on both rooms** | the second is dropped by that guard, armed synchronously by the first | ✔ |
| a pending write whose target the server **deleted** | the write is dropped whole and flagged `superseded` — never upserted back (finding **A**) | ✔ |
| a pending write that depends on a dropped one | dropped in turn, not applied to a tree that never got its predecessor | ✔ |
| a pending write whose **parent** was destroyed | dropped — the result would not validate | ✔ |
| a **detached** node whose target the viewer may not read | renders, under the kind's generic name; a blank resolved title falls back too | ✔ |
| an **empty grid** (root holding nothing) | renders the empty frame, `activeNodeId: null`, workspace stays alive | ✔ |
| a workspace with **no root yet** | seats as read-and-holding-nothing; the first write seeds the root (finding **B**) | ✔ |
| a workspace with a **foreign** root id (backfilled) | no second root is minted; the type decides, not the id | ✔ |
| the derived root id already **taken by a pane** | refuses to mint; the command answers `no_root`, which is true | ✔ |
| an HTTP snapshot **older** than the one held | ignored | ✔ |
| a 200/broadcast body that is **not a valid tree** (two roots, a cycle, an orphan) | refused — never becomes a base, or every later local edit is refused by the gate the server applies | ✔ |
| a 200 body that is not JSON-shaped at all | the sent writes fold into the base; the render is unchanged | ✔ |
| a 409 with no parseable body | backs off rather than spinning | ✔ |
| a **non-409 4xx** | queue abandoned, flagged `refused`, durable truth re-read | ✔ |
| a broadcast payload with **no `workspaceId`** | ignored, no throw on the socket | ✔ |
| **focus naming a node that vanished** | falls back to the first *grid* pane | ✔ |
| **focus naming a parked node** | not honoured — focus names a rectangle on screen | ✔ |
| a remote edit while a node **is** focused | focus is not stolen | ✔ |
| a **close on an unresolved listing** | no-op — never act on an unverified fact | ✔ |
| a close whose thread is **already gone** from the listing | pure layout close, no DELETE | ✔ |
| a **mint completing into a pane the user closed** | superseded; the orphaned row is cleaned up | ✔ |
| a **shell opening into a pane that went away** | the shell is closed rather than left running unattached | ✔ |
| a **cyclic parent chain** reaching a renderer | the walk terminates | ✔ |
| a **split holding nothing** | skipped, no empty frame | ✔ |

### Three the enumeration produced that the prompt did not name

1. **A parked target is unreachable without the store naming the move.** `open`
   refuses `already_bound` for a target a parked node holds — correctly: "showing
   it again is a `move`, and the caller names it." Nobody was naming it, so
   clicking a closed thread in the sidebar would have silently done nothing —
   #2373 wearing a new hat. `openTarget` now un-parks (`showNode`), and mutation
   **M7** kills the version that does not.
2. **`stillMinting` must require the node to be ON THE GRID.** Closing no longer
   destroys, so a node whose pane was closed mid-mint still exists and is still
   unbound; an existence check alone lands the result in a rectangle nobody can
   see. Mutation **M12**.
3. **`resetPane` cannot exist.** A binding is for life, so "send this pane back
   to the picker" is destroy-and-recreate-in-slot (`unbindPane`), and **the node
   id changes**. That is honest — the pane the caller held is gone — but it is a
   semantic change for every holder of a node id across an await.

---

## Mutation table

22 mutations across 9 modules, each applied mechanically, suite re-run, file
restored (and `@pagespace/lib` rebuilt where the mutation was in `packages/`,
since the web suite imports from `dist`).

| # | Module | Mutation | Result |
|---|---|---|---|
| M1 | `node-writes.ts` | `rebasePending` drops the still-applies gate | killed by 2 — *drop the write rather than resurrect*, *drop a write that depends on an earlier dropped one* |
| M2 | `node-writes.ts` | `rebasePending` stops validating the result | killed by 2 |
| M3 | `useAgentWorkspaceStore.ts` | `hydrateFromServer` loses the no-op early-out | killed by 1 — *should return the SAME object for an identical re-seat* |
| M4 | `useAgentWorkspaceStore.ts` | `applyRemoteUpdate` seats an untracked workspace | killed by 2 — both resurrection cases |
| M5 | `useAgentWorkspaceStore.ts` | `applyRemoteUpdate` loses the rev guard | killed by 1 — *the same event delivered on both rooms* |
| M6 | `useAgentWorkspaceStore.ts` | focus may name a PARKED node | killed by 1 — *leaves an EMPTY GRID when the last pane closes* |
| M7 | `useAgentWorkspaceStore.ts` | `openTarget` stops un-parking a parked target | killed by 2 (store + AgentPanes) |
| M8 | `useAgentWorkspaceStore.ts` | `runCommand` stops seeding the root | killed by 2 |
| M9 | `workspace-tree-view.ts` | the sidebar renders only the ATTACHED tree | killed by 3 — **the #2373 guard** |
| M10 | `workspace-tree-view.ts` | an unresolvable title collapses to empty | killed by 3 |
| M11 | `close-pane.ts` | a close acts on an unresolved listing | killed by 1 |
| M12 | `AgentPanes.tsx` | a mint lands in a pane the user closed mid-flight | killed by 2 |
| M13 | `SessionPanes.tsx` | an empty grid renders a frame with no panes | killed by 3 |
| M14 | `SessionPanes.tsx` | the grid stops recursing into nested containers | killed by 2 |
| M15 | `workspace-tree-view.ts` | `nodeShowing` ignores parked nodes | killed by 2 |
| M16 | `agent-workspace-events.ts` | the broadcast stops reaching the owner's plane | **survived first**, then killed by 3 — see below |
| M17 | `workspace-node-runtime.ts` | the funnel stops reading the owner inside the lock | killed by 1 |
| M18 | `workspace-node-runtime.ts` | targets stop carrying `agentPageId` | killed by 1 |
| M19 | `agent-workspace-events.ts` | the routing field leaks into the payload | killed by 1 |
| M20 | `workspace-nodes-listener.ts` | the global listener stops subscribing | **survived first**, then killed by 2 |
| M21 | `workspace-nodes-listener.ts` | the listener stops guarding a garbage payload | killed by 1 |
| M22 | `session-directory-listener.ts` | the dead `closedInWorkspaceAt` branch is reinstated | killed by 1 |

**M16 and M20 both survived on the first pass, and both were real gaps in exactly
the two items the prompt made headline deliverables.**

- **M16**: the write funnel's own suite mocks `broadcastWorkspaceNodesUpdated`
  wholesale, so the *fanout* — which rooms, and what is stripped — had no test
  anywhere. Wrote `lib/websocket/__tests__/agent-workspace-events.test.ts` (7
  cases), including the drive-room prohibition. M16 and M19 then died.
- **M20**: the global listener had no suite at all. Wrote
  `lib/realtime/__tests__/workspace-nodes-listener.test.ts` (9 cases). M20 and
  M21 then died.

Both are the reason I ran mutations before writing this rather than after: a
green suite over a mocked seam says nothing about the seam.

---

## Coverage retired with the model, stated plainly

`AgentPanes.test.tsx` was 2957 lines / 81 cases against the verb vocabulary. I
replaced it with 31 cases against the node model rather than porting it, and the
difference is not all savings. What is **genuinely gone because the state is
unspellable**:

- every case about the loading sentinel (`{kind, targetId: null}`) and the
  reference-counted `priorScopeBeforeMint` capture that restored it — a
  `PaneTarget` cannot be half-bound, so a failed mint leaves the pane untouched
  and there is nothing to restore (~8 cases);
- every grid-last rebind and end-session-on-last-close case — the grid may be
  empty (~10 cases);
- the "same conversation in two panes" cases — refused by the chat-target index
  and by `shownElsewhere` (~3 cases).

What is **thinner than it was and should be re-thickened**: the reopen/claim
race-coordination block (deferred-cleanup, in-flight counts, history-delete
generations) survives in the source with its reasoning intact, but I carried
across only its structure, not its ~20 dedicated cases. Those races are
orthogonal to the layout model — they are conversation-lifecycle, not node —
so they neither changed nor got easier, and they are the largest known coverage
debt this branch leaves. `AgentsSidebar.test.tsx` was ported rather than
replaced: 56 of its cases survive unchanged, and the grid-specific block became
17 node-model cases.

---

## Gates

| Gate | Result |
|---|---|
| `bun run --filter @pagespace/lib typecheck` | pass |
| `bun run --filter web typecheck` | pass |
| `bun run --filter @pagespace/lib lint` | pass |
| `bun run --filter web lint` | pass (warnings only, all pre-existing) |
| `bun run --filter @pagespace/lib test -- src/agent-workspaces src/services/agent-workspaces` | **836 passed**, 30 files |
| `bun run --filter web test -- src/stores/agent-workspace` | **90 passed**, 4 files |
| `bun run --filter web test -- src/components/layout/left-sidebar` | **94 passed**, 6 files |
| web, all affected areas (8 paths) | **1366 passed**, 29 skipped, **0 test failures** |
| `bun run knip` | no unused exports from this change |
| `bun run test:security` | **could not run here** — no Postgres in this worktree |

The 5 "failed files" in the web run are all `.integration.test.ts` suites whose
`requireDb` guard throws in `beforeAll`. Zero *tests* failed. Known env-only gap;
the same suites cannot run on any branch here.

### Two gates that were already red when I arrived, and are now green

- **The broadcast emit-site registry** (`conversation-events-audience.test.ts`)
  fails on this branch **as it stood before my change** — verified by checking
  out the base version of the file and re-running. Phase 3 refactored `emit` to
  take the event name as a *positional* argument, which is invisible to the
  repo-wide scan for `event: '<literal>'`; `agent-workspace-events.ts` silently
  dropped out of the registry, so its broadcasts stopped being covered by the
  very check that exists to notice a new one. `emit` now takes an options object
  with the name as a named literal, the registry records both events with their
  audiences, and the file's docblock says not to turn it back into a parameter.
- **knip** flagged the three legacy layout-wire zod schemas once my store stopped
  parsing them. Deleted (with `workspaceLayoutGridSchema`, their only consumer);
  the TypeScript interfaces the verb route still writes against remain.

---

## New / changed / deleted

```
packages/lib/src/agent-workspaces/workspace-node-commands.ts     + seedRoot, rootSeedFor, openShell
packages/lib/src/agent-workspaces/workspace-node-wire.ts         + WorkspaceNodeTarget.agentPageId
packages/lib/src/agent-workspaces/workspace-layout-wire.ts       − the orphaned client schemas
apps/web/src/stores/agent-workspace/node-writes.ts               new  (replaces verb-queue.ts)
apps/web/src/stores/agent-workspace/workspace-tree-view.ts       new
apps/web/src/stores/agent-workspace/useAgentWorkspaceStore.ts    rewritten on nodes
apps/web/src/stores/agent-workspace/useWorkspaceLayoutSync.ts    rewritten (nodes-updated)
apps/web/src/stores/agent-workspace/verb-queue.ts                DELETED (+ 3 suites)
apps/web/src/stores/agent-workspace/pane-labels.ts               DELETED (+ 1 suite)
apps/web/src/lib/realtime/workspace-nodes-listener.ts            new
apps/web/src/lib/realtime/session-directory-listener.ts          − the dead closedInWorkspaceAt branch
apps/web/src/lib/websocket/agent-workspace-events.ts             two rooms; scannable emit
apps/web/src/lib/agent-workspaces/workspace-node-runtime.ts      + bulk read, agentPageId, owner-in-lock, root seed
apps/web/src/app/api/agent-workspaces/route.ts                   + {rev, nodes, targets} per session
apps/web/src/components/agents/panes/SessionPanes.tsx            recursive; empty grid
apps/web/src/components/agents/panes/AgentPanes.tsx              node vocabulary; no seed
apps/web/src/components/agents/panes/close-pane.ts               five branches → two
apps/web/src/components/agents/panes/pane-surface.ts             node + isMinting
apps/web/src/components/layout/left-sidebar/AgentsSidebar.tsx    renders the live tree
apps/web/src/components/agents/{AgentPageView,AgentsSurface,useSpawnSession}  node vocabulary
apps/web/src/lib/ai/shared/hooks/useOpenPagePane.ts              openPage(pageId, …)
apps/web/src/contexts/GlobalChatContext.tsx                      + WorkspaceNodesListener
```

Untouched, as instructed: the old tables, the legacy verb route and its runtime,
`conversations.workspaceId`, the compat shim, the membership chokepoint, and
`annotate-conversation-panes.ts` (the runtime cluster's leaf).

---

## What I would look at next

1. **The reopen/claim race coverage** named above — the largest known debt.
2. **`AgentsSurface`'s selection follow-on.** With no rebind, `onConversationClosed`
   always reports `next: null` and the surface picks its own replacement from the
   grid. I excluded parked nodes from that choice deliberately (following the
   console's header to something off-screen is worse than showing nothing), but it
   is a product judgement someone should confirm.
3. **`unbindPane` changes a node's id.** Correct under binding-for-life, and every
   in-repo caller re-reads live state, but any future caller holding a node id
   across an await needs to know.
4. **The empty-grid copy** ("Nothing is open here. Pick a conversation, shell or
   page from this workspace in the sidebar") is mine, not a designer's.

# Sanity verdict 1 — Workspace Node Tree Epic

**Auditor.** Nothing implemented, nothing fixed, nothing merged, board untouched.

**Branch audited:** `pu/workspace-node-model` @ `bea764908`, verified identical to
`origin/pu/workspace-node-model` and to this worktree's HEAD. Merge-base with `master` is
`06db061b9`; `origin/master` has since moved to `968e7be76` (the branch has not been rebased —
noted, not a finding).

**Epic:** `gai93lz5cej7nw0zj0bwrmxe`, drive `omziyxp4skckh7ixi2sxzhuk`.

---

## Gates — exact numbers

Worktree required `bun install` plus `@pagespace/db` and `@pagespace/lib` `dist` builds before the
web suite could resolve `@pagespace/lib/*` subpath exports. That is the known worktree quirk, not a
branch defect: on a bare worktree 16 of 18 web files fail to load with `Failed to load url
@pagespace/lib/...`, and all 16 pass once `dist` exists.

| Gate | Result |
|---|---|
| `bun run --filter @pagespace/lib typecheck` | **exit 0**, clean |
| `bun run --filter @pagespace/lib lint` | **exit 0**, clean |
| `bun run --filter @pagespace/lib test -- src/agent-workspaces` | **625 passed / 625, 18 files, exit 0** |
| `bun run --filter web test -- src/lib/agent-workspaces` | **172 passed, 29 skipped, 0 failed**; 13 of 18 files pass, **5 files fail to set up** |

The 5 failing web files are all `*.integration.test.ts` and every failure is
`could not reach Postgres` / `could not reach DATABASE_URL`. `DATABASE_URL` is unset in this
worktree. Zero assertion failures — env-only, matching the documented pattern. The node-model files
specifically are green: `workspace-node-placement.test.ts` (20), `workspace-node-runtime.test.ts`
(14), `authorize-pane-scope.test.ts` (15).

---

## Finding 1 — THE RE-PARENTING HAZARD: **no violations found** (reported regardless, as instructed)

Swept the whole branch for failure-path `parentId` assignment: `?? root`, `|| root`, "attach to
root", and any `parentId` written inside a `catch` / `else` / not-found branch.

**Count: 116 `parentId` code lines across the node modules; 57 are assignment or declaration sites;
exactly 1 uses a fallback operator; 0 are violations.**

The single fallback site, examined in full:

`apps/web/src/lib/agent-workspaces/workspace-node-placement.ts:274`
```ts
const root = rootOf(nodes);
const parentId = command.parentId ?? root?.id;
```

**This is legitimate, and not a failure path.** It is the documented default for `arrange` with an
omitted parent ("the ROOT's own children — the top-level order"). Three things make it safe:

- the root is found **by `nodeType`** via `rootOf`, never as "the node with no parent" — a detached
  pane has none either, and the comment at `:270-273` says exactly that;
- a workspace with no root **refuses** (`no_root`, `:276`) rather than defaulting to anything;
- the ids it then moves are filtered to `present` — `childrenOf(nodes, parentId)` at `:281,294` — so
  a stale or foreign id is **skipped**, never dragged in. It cannot pull a node from elsewhere.

Correctly classified as READS, not violations: `workspace-node-commands.ts:386`
(`const parentId = displaced.parentId`), `:581` (`const parentId = chosen.parentId`), and
`workspace-node-algebra.ts:592,602,606` (`parentId: container.parentId` — the collapse promotion,
where the survivor inherits the collapsed container's parent on a success path).

`parentId: null` at `workspace-node-commands.ts:322,413,585` is closing a pane, which the model
defines as a move to no parent. `workspace-node-backfill.ts:583,650` assign null to the root and to
parked panes. All correct per the model.

The four structural guarantees the epic page names are all present and load-bearing: the in-memory
model carries no `rootId` (`workspace-node.ts:71-107`); the composite self-FK exists
(`0255_boring_leo.sql`); `rootId` is `NOT NULL` and separate from `parentId`; and the write decision
contains no `parentId` assignment at all (`workspace-node-write.ts`, stated at `:10-17`).

**Verdict on the hazard: clean.**

---

## Finding 2 — LAYER INCOHERENCE (HIGH): the table refuses a chat binding the algebra, the validator and the authorization gate all permit

This is exactly the divergence item 5 asks for, and it is reachable through the landed HTTP route.

**The table's constraint is GLOBAL.** `packages/db/drizzle/0255_boring_leo.sql` and
`packages/db/src/schema/agent-workspace-nodes.ts:227-229`:

```sql
CREATE UNIQUE INDEX "agent_workspace_nodes_chat_target_idx"
  ON "agent_workspace_nodes" ("targetId") WHERE "targetKind" = 'chat';
```

The index key is `targetId` alone — **no `rootId`**. One conversation, one node, across the entire
table.

**The validator's check is PER-WORKSPACE.** `packages/lib/src/agent-workspaces/workspace-node-validate.ts:431-442`
iterates only `nodes`, which by construction is one workspace's list. It cannot see a binding held
by another workspace. Its justifying comment at `:407-411` rests on a premise —

> A conversation belongs to exactly one workspace (`conversations.workspaceId`, permanent … so one
> conversation → one workspace → at most one pane)

— that **the branch's own backfill contradicts**. `workspace-node-backfill.ts:122-126`:

> `UNIQUE (targetId) WHERE targetKind = 'chat'` is GLOBAL, not per-workspace, and **a pane naming a
> conversation in another session is reachable today** … So a workspace cannot know from its own
> rows whether it may bind a thread.

The backfill therefore performs a global arbitration pass (`scripts/backfill-agent-workspace-nodes.ts:182`
queries `agentWorkspaceNodes` across the whole table). **The runtime write path does no such thing.**

**The authorization gate actively permits the cross-workspace bind.**
`apps/web/src/lib/agent-workspaces/authorize-pane-scope.ts:177-180`:

```ts
if (row.workspaceId === workspaceId) return true;
return canAccessConversation(viewerId, row, { ... });   // owner ⇒ true
```

A conversation bound to workspace A is waved through for workspace B whenever the caller owns it.

### Concrete failure scenario

1. User U owns conversation C. C is bound to workspace A: `conversations.workspaceId = A`, and node
   `n1` in A holds `target = {kind:'chat', id:C}` — row `(rootId=A, id=n1, targetKind='chat', targetId=C)`.
2. U also has access to workspace B.
3. U `POST`s `/api/agent-workspaces/B/nodes` with
   `put: [{nodeType:'pane', id:'n2', parentId:<B's root>, position:0, target:{kind:'chat', id:C}}]`
   and a correct `baseRev`.
4. Scope check passes — `workspace-node-write.ts:175` only compares `rootId` to the URL's workspace,
   and the payload names B (or omits it).
5. Rev check passes.
6. `validateTree` over **B's** tree passes — only `n2` holds chat C *in B*
   (`workspace-node-validate.ts:431-442`).
7. `introducedPaneTargets` yields `{kind:'chat', targetId:C}`; `authorizePaneScope` returns **true**
   because U owns C (`authorize-pane-scope.ts:177-180`).
8. `writeWorkspaceNodes` runs the upsert (`workspace-node-runtime.ts:205`) → Postgres raises a
   unique violation on `agent_workspace_nodes_chat_target_idx`.
9. Nothing catches it between there and the route. `route.ts:104-107` catches and returns
   **502 `{error: 'Could not apply the layout write'}`**.

### Why this matters

Nothing is corrupted — the transaction aborts, so no rows are written, and the re-parenting hazard
is **not** triggered. The damage is the error surface:

- The client applied optimistically. It receives a **502 with no `rev` and no `nodes`**, so its
  rebase path — which is driven by the 409 snapshot body (`route.ts:124-126`) — never fires. The
  phantom pane stays on screen until an unrelated poll or broadcast corrects it.
- A domain refusal is reported as a server fault. An operator reading logs sees a 502, not "that
  conversation is already shown elsewhere".
- This is the precise shape the branch's own `pu-fix-dupe.md` set out to eliminate: "the client
  would apply optimistically and then receive a raw unique-constraint violation rather than a typed
  rejection". That fix closed the *within-workspace* case and left the *cross-workspace* case open.

Phase 4 (the client plane) is entirely `pending`, so no shipped client drives this yet — but the
route is landed and reachable by any authenticated caller with access to both workspaces.

---

## Finding 3 — BOARD DRIFT (MEDIUM): a completed leaf with no code, and a page that contradicts its own title

Task `jammrv8zspfisentsxykipff` on page `z2z9e8kzi9isodhx5ivbti8r` (Phase 5) is titled
**"MOVED into the cutover PR — changelog and memory capture"** and is marked **`completed`**.

- **It is not titled DROPPED**, so it does not fall under the exemption for deliberately-unbuilt
  leaves. Its title says the work moved into the cutover PR — i.e. still owed.
- **There is no code for it on the branch.** `CHANGELOG.md` is unchanged:
  `git diff --name-only origin/master...HEAD` returns no changelog path.
- **Its page body is the wrong text.** It carries the identical compat-shim boilerplate as the two
  genuinely dropped leaves — "This leaf existed only to serve a rolling deploy with old browsers…"
  — which has nothing to do with changelog or memory capture. Its own Requirements section directly
  below still demands real work: *"Given user-visible behaviour changed, should update the
  changelog"* and *"Given closing the last pane no longer ends the workspace, should say so
  explicitly — it is the one behaviour change a user will notice."*

A leaf marked `completed`, with no code, whose page says "not in scope" while its title says "moved"
and its requirements say "do this", is drift in the most consequential direction: the one
user-visible behaviour change in the epic currently has nobody accountable for documenting it.

**The two genuinely DROPPED leaves check out** and are correctly not counted as drift:
`srp2qo05coa4tzbfahyehp19` (compat shim) and `icnb2d01zfyzk6u2nu8dhv8g` (drop shadow
tables/columns/shim) both carry pages explaining *why* — the delivery shape changed to one cutover
PR, so the rolling-deploy machinery is not needed rather than postponed, with the tradeoff stated.
Consistent with the epic page's "DELIVERY CHANGED" section.

### Every other completed leaf has merged code

| Leaf | Code |
|---|---|
| P1 · WorkspaceNode type and tree helpers | `workspace-node.ts` |
| P1 · validateTree | `workspace-node-validate.ts` |
| P1 · State algebra | `workspace-node-algebra.ts` |
| P1 · Commands | `workspace-node-commands.ts` |
| P1 · Flatten and rebuild, property-pinned | `workspace-node-rows.ts:340` `buildRenderTree` + round-trip property (`3e2fbe07d`) |
| P2 · nodes/node_revs schema | `packages/db/src/schema/agent-workspace-nodes.ts` |
| P2 · additive migration | `0255_boring_leo.sql` + `0255_snapshot.json` + journal |
| P3 · Single-derivation backfill | `workspace-node-backfill.ts`, `scripts/backfill-agent-workspace-nodes.ts` |
| P3 · Atomic snapshot read | `workspace-node-store.ts:185` `readWorkspaceNodeSnapshots` |
| P3 · put/drop route | `apps/web/src/app/api/agent-workspaces/[workspaceId]/nodes/route.ts` |
| P3 · Server-resolved commands | `workspace-node-placement.ts`, `session-tools*.ts` |

Phase 3's two `in_progress` leaves (membership chokepoint, delete claim/close/reopen/annotate) and
all seven `pending` Phase 4 leaves correctly have no code on the branch. No false-completion there.

---

## Finding 4 — THE CASCADE: correct, and the coverage is real (verified by mutation)

The requested shape — `R → s1 → { s2 → {a,b}, c }`, move `c` to `R` — is exactly the fixture at
`packages/lib/src/agent-workspaces/__tests__/workspace-node-write.test.ts:290-298`, and `a` and `b`
do survive.

**The mechanism.** `workspace-node-write.ts:142-161` derives the storage instruction from the OLD
tree: every node that survives into `next` while sitting beneath a removed node is added to the
upsert. `descendantsOf` (`workspace-node.ts:172-189`) is a transitive BFS with visited-tracking, so
it reaches `a` and `b` two levels down, not just `s2`.

**The storage order is safe.** `workspace-node-store.ts:257-285` deletes first, then issues **one**
multi-row upsert. Delete-first is required because upsert-first would put two rows on one chat
target mid-transaction, which the global unique index refuses. A single statement is required
because the self-FK is **not** deferrable — and Postgres fires FK triggers at end of statement, so
parent and child may appear in any order within it. Both reasons are documented at `:232-238`. The
reasoning holds.

**Mutation check — I did not take the test's word for it.** Replacing the rescue with
`const rescued: WorkspaceNode[] = []` turns **exactly 2 tests red** and nothing else:

```
× THE CASCADE … > rescues the surviving subtree into the upsert, so the cascade cannot eat it
× THE CASCADE … > rescues them UNCHANGED — a rescue relocates nothing
Tests  2 failed | 623 passed (625)
```

File restored; `git status` clean before proceeding.

**One thing the brief's phrasing could mislead on, worth recording.** `workspace-node-cascade.test.ts`
(3 tests) does **not** test the persisted write — it mocks `removeNodes` to cascade and exercises
`applyNodeWrite`, the in-memory algebra helper, whose protection is put-then-drop *ordering*
(`workspace-node-algebra.ts:152-154`). It stayed green under the mutation above. These are two
distinct mechanisms for the same hazard at two layers, and **both** are genuinely covered — the
algebra by `workspace-node-cascade.test.ts`, the persisted write by
`workspace-node-write.test.ts:281-362`. Not a defect; stated so a future reader does not mistake one
suite for the other's coverage.

---

## Finding 5 — REPORTS (LOW): the backfill cluster landed with no report

`.pu-reports/README.md` makes a committed report the completion signal for every cluster. Present:
`pu-fix-dupe.md`, `pu-fix-review.md`, `pu-rev-phase1.md`, `pu-wnt-wire.md`.

The rule itself landed at `a31ed7cd1` ("reports are committed files, not transcripts"). Clusters
merged **after** that commit, and their reports:

| Cluster | Commits | Report |
|---|---|---|
| Duplicate chat-target fix | `85c97444f`, `ab1dbf57b` | `pu-fix-dupe.md` |
| Phase 1+2 review of record | `6876e0c91`, `cdec3a905` | `pu-rev-phase1.md` |
| Review-finding fixes | `a18addab0`, `3dff59ee2` | `pu-fix-review.md` |
| **Backfill derivation** | **`7351b8718`, merged `eb1752972`** | **none** |
| Atomic read + write | `06508ec56`, `bea764908` | `pu-wnt-wire.md` |

**The backfill is the gap.** It is ~1,400 lines across `workspace-node-backfill.ts` (763) and
`scripts/backfill-agent-workspace-nodes.ts` (555), with 52 tests — and it is, by the epic page's own
account, "the one genuinely irreversible act — one-shot, non-idempotent, over real workspaces",
which the epic explicitly says "stays its own PR with its own review". It is the cluster where a
missing written record costs the most. No file in `.pu-reports/` documents it; the only mentions of
"backfill" anywhere in the directory are two incidental references in `pu-rev-phase1.md` (which
scopes it **out**: "not present on this branch") and one in `pu-wnt-wire.md`.

The pre-rule Phase 1/2 build clusters (node model, rows, validate, algebra, table, commands) also
have no individual build reports, but they are covered retrospectively by `pu-rev-phase1.md`, which
reviews all of them by name. Not counted as drift.

---

## Finding 6 — HYGIENE (LOW): the epic page's content is duplicated

`pagespace pages read gai93lz5cej7nw0zj0bwrmxe` returns the entire spec twice. Lines 3–88 (Status,
Overview, Model, Delivery, Working agreement, Named hazard, page-tree rationale, Vocabulary rule,
`targets[]`) reappear verbatim from line 134 onward, with the "DELIVERY CHANGED — one cutover PR"
section (104–131) sandwiched between the two copies.

This matters slightly more than a cosmetic duplication: the **superseded** five-phase delivery plan
is what appears *last* on the page, after the section that supersedes it. A reader arriving at the
bottom finds "Five phases, five PRs onto `master`, expand → cutover → contract" presented as current.

---

## Scope reduction — clean

Grepped every `.ts`/`.tsx` file the branch changed for `TODO`, `FIXME`, "for now", "follow-up",
"out of scope", `.skip(`, `it.todo`, `xit(`, `describe.skip`, and empty catch blocks.

**Zero genuine hits.** The only two matches were `scripts/backfill-agent-workspace-nodes.ts:550,553`,
where the pattern `xit\(` matched inside `process.exit(` — false positives. No empty catch blocks
anywhere in the changed set. The 29 "skipped" tests in the web run are unrun tests inside the five
Postgres-blocked integration files, not authored skips.

For a branch of 34,332 insertions this is genuinely clean, and the module docs consistently argue
decisions rather than deferring them.

---

# VERDICT: **DRIFT FOUND**

The model is implemented faithfully and the named hazard is closed — but a completed board leaf owes
the epic's one user-visible changelog entry with no code and a page contradicting its own title
(Finding 3), the landed backfill cluster has no report (Finding 5), and the runtime write path's
chat-target check is per-workspace while the index enforcing it is global, so a reachable
cross-workspace bind surfaces as a 502 instead of a typed refusal (Finding 2).

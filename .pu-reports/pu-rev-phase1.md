# Review of record — Phase 1 + Phase 2, as merged

**Branch reviewed:** `pu/rev-phase1` (carrying `pu/workspace-node-model`)
**Reviewer:** adversarial pass, 2026-08-08
**Baseline:** `bun run --filter @pagespace/lib test -- src/agent-workspaces` → **519 passed / 15 files**, green before and after this review. Tree clean.

**Under review:** `workspace-node.ts` · `workspace-node-validate.ts` · `workspace-node-rows.ts` · `workspace-node-algebra.ts` · `workspace-node-commands.ts` · `packages/db/src/schema/agent-workspace-nodes.ts` · `packages/db/drizzle/0255_boring_leo.sql`. (`workspace-node-backfill.ts` out of scope — not present on this branch.)

**Method.** Every finding below was **constructed and executed**, not read off the page. Three probe suites (45 cases) were run against the real modules; 27 mutations were applied and reverted mechanically; migration `0255` was applied verbatim to a live PostgreSQL 17.5 (`pagespace-postgres-test`) and the illegal states were inserted by hand. Probe files were deleted and the container database dropped; `git status` is clean.

---

## Verdict

# DO NOT MERGE

Two defects (**#1**, **#2**) put a workspace into a state from which there is **no read path back** — one loses pane rows outright, the other makes every subsequent read of the workspace throw forever. Both are latent rather than live (nothing writes these tables yet; that is Phase 3), and both are cheap to fix now and expensive to fix after a cutover has run. Catching a landmine before the layer that steps on it is written is exactly what this pass is for.

The model itself is sound and the test suite is genuinely strong — 25 of 27 mutants killed, most by a single named test. The findings below are gaps at the seams, not a case against the design.

---

## Findings

### 1. `applyNodeWrite` prescribes drop-then-put; the table's self-FK cascades. Applying a write in the documented order silently destroys a subtree. — **HIGH**

`packages/lib/src/agent-workspaces/workspace-node-algebra.ts:109-118`

```ts
/**
 * Apply a write-set. Drop first, then upsert: an operation names the nodes it
 * removes and the nodes it writes, and a node is never in both.
 */
export function applyNodeWrite(nodes: readonly WorkspaceNode[], write: NodeWrite): WorkspaceNode[] {
  return upsertNodes(removeNodes(nodes, write.drop), write.put);
}
```

against `packages/db/src/schema/agent-workspace-nodes.ts:186-189` / `packages/db/drizzle/0255_boring_leo.sql:26`:

```sql
ADD CONSTRAINT "agent_workspace_nodes_rootId_parentId_..._fk"
  FOREIGN KEY ("rootId","parentId") REFERENCES "agent_workspace_nodes"("rootId","id")
  ON DELETE cascade
```

In memory `removeNodes` removes exactly what it is named. In the table, deleting a container **takes its whole subtree with it** — which the schema docblock at `:174-176` celebrates as a feature ("deleting a container removes its whole subtree for free"). The collapse path in `move`/`destroy` produces writes that drop a container whose children are being **reparented, not deleted**, and those children are only in `put`. Drop-first therefore cascades away rows that the write intended to keep, and `put` cannot resurrect them because it never named them.

**Failure scenario (executed against PostgreSQL 17.5, migration 0255 applied verbatim).**

Tree: `R → s1 → { s2 → {a, b}, c }`, plus `R → d`. `validateTree` says `ok`. The user drags `c` up to the root:

```
move(nodes, { nodeId: 'c', parentId: 'R', index: 1 })
  → put:  [ s2 → R pos 0,  c → R pos 1,  d → R pos 2 ]
    drop: [ 's1' ]
```

Correct: `s1` is left holding one child, so `s2` is promoted into its place. Panes `a` and `b` are untouched and correctly absent from `put`.

Applied in `applyNodeWrite`'s order:

```
DELETE ... WHERE "id" IN ('s1');       -- cascade: s2, then a, then b
  rows surviving the DELETE:  R, d          <-- a and b are GONE
INSERT ... ON CONFLICT DO UPDATE;      -- reinstates s2, c, d only

FINAL:  R | s2 | c | d      (4 rows; was 7)
```

Applied in the opposite order:

```
FINAL:  R | s2 | a | b | c | d   (6 rows — correct)
```

Two panes and their conversation bindings are destroyed by a drag-to-reorder. Worse, the wreckage is **also structurally invalid**: `s2` is left a split with zero children, which `validateTree` rejects as `degenerate_split` — so the workspace does not merely lose panes, it stops loading.

Nothing writes these tables yet, so this is not a live outage. But `applyNodeWrite` is exported, is the module's canonical statement of *what applying a write means*, and its docblock actively instructs the reader to drop first. Phase 3 will reach for it.

**What is needed:** either the docblock and the function reverse to put-then-drop, or the ordering constraint is stated where the DB writer will read it. The in-memory order is unobservable; the DB order is not, and only one of them is safe.

---

### 2. `create` accepts an empty `nodeId` and a blank `targetId`. Both persist, and both make the workspace permanently unreadable. — **HIGH**

`packages/lib/src/agent-workspaces/workspace-node-algebra.ts:330-358` (`create` validates neither) versus `packages/lib/src/agent-workspaces/workspace-node-rows.ts:100, 117, 135, 142` (`z.string().min(1)` on `id`, `parentId`, `targetId`).

`create` checks that `nodeId` is not already taken and that `index` is a slot. It never checks that `nodeId` is a **non-empty string**, and unlike `bind` it never checks the target's id. `validateTree` has no opinion on either — it checks uniqueness, not shape.

**Executed:**

```
create([root], { nodeId: '', target: null, parentId: 'R' })
  → { ok: true, write: { put: [ {nodeType:'pane', id:'', parentId:'R', position:0, target:null} ] } }
validateTree(applied)  → { ok: true }
rowFromNode(...)       → { id: '', ... }
nodeFromRow(row)       → THROWS  too_small: expected string to have >=1 characters (path: ["id"])
```

```
create([root], { nodeId: 'p2', target: { kind: 'chat', id: '' }, parentId: 'R' })
  → { ok: true, ... target: { kind: 'chat', id: '' } }
validateTree(applied)  → { ok: true }
nodeFromRow(row)       → THROWS  too_small (path: ["targetId"])

bind(withPane, { nodeId: 'p1', target: { kind: 'chat', id: '' } })
  → { ok: false, code: 'invalid_target' }        <-- bind refuses what create accepts
```

And Postgres stores both without complaint (`text NOT NULL` is satisfied by `''`):

```
INSERT ... VALUES ('', 'W2','R',1,'pane', now());          -- INSERT 0 1
SELECT "id"='' AS empty_id_stored ...                       -- t
INSERT ... ('blank','W2','R',2,'pane','chat','', now());   -- INSERT 0 1
```

**Failure scenario.** A client (or any Phase-3 wire handler calling the algebra directly) mints a pane with `nodeId: ''` — a defaulted variable, a trimmed uuid, an off-by-one in id generation. The algebra accepts, `validateTree` accepts, the row lands. From that moment every read of that workspace goes through `nodesFromRows`, which **rejects the whole set rather than filtering** (`workspace-node-rows.ts:194-202` — correctly, and documented as such). The workspace is unreadable, permanently, and the read is the only way in, so there is no in-product repair path. It takes a hand-written `DELETE` against production.

**This is compounded by a false claim and an untested guard.** `bind`'s comment at `workspace-node-algebra.ts:553-556` says of the blank target id:

> `// notice. This is the only place it can be caught.`

It is not. `create` binds at the mint — that is the entire justification for `CreateInput` carrying a target (`:325-328`) — and it is the other place, and it does not catch it. The commands layer knows this: `open` at `workspace-node-commands.ts:526` carries its own guard whose comment says "`bind` refuses a blank target id and `create` does not". **That guard is not covered by any test** — see mutation M25 below, which survived. The existing test (`workspace-node-commands.test.ts:738`) exercises only the *fill* path, which falls through to `bind`'s guard and passes with `open`'s guard deleted. The *split* path — `open` → `splitInto` → `create(…, target)` — is the one that would mint the unreadable row, and it is the one nothing tests.

---

### 3. `validateTree` never checks fractions on the parked group, so a non-finite share on a detached pane passes. — **MEDIUM-HIGH**

`packages/lib/src/agent-workspaces/workspace-node-validate.ts:276-277`

```ts
for (const group of groups) {
  if (group.parentId === null) continue;   // <-- skips the whole fraction block
```

Skipping `fraction_mixed` and `fraction_sum` for the parked panes is right and well argued: they share no container, so there is nothing for a share to be a share *of*. But `fraction_not_finite` (`:299-307`) sits **inside** the same block, and it is not a property of a container — it is a property of one number. The parked group is exempted from it by position rather than by intent.

**Executed:**

```
validateTree([root, { nodeType:'pane', id:'p', parentId:null, position:0, target:null, fraction: NaN }])
  → { ok: true }
validateTree([... fraction: Infinity ])
  → { ok: true }
nodeFromRow(rowFromNode(thatNode,'W'))
  → THROWS  invalid_type: expected number, received Infinity (path: ["fraction"])
```

The algebra's own gate does catch this — `accept()` at `workspace-node-algebra.ts:286-291` sweeps every node unconditionally — so no operation in this branch can produce it. But `validateTree` is documented as *the* gate: "the single function every write path runs before persisting" (`workspace-node-validate.ts:8-9`), and the wire primitive is `put(nodes[])`, which is a node set, not an operation. A `put` validated only by `validateTree` carries the NaN through; Postgres `real` accepts `NaN` and `Infinity` happily; and the read-back throws — the same permanent unreadability as finding #2.

The module's own reasoning at `:288-298` — that a NaN is "self-propagating" and that the client's optimistic resize divides by a container extent of `0` — applies with equal force to a pane the user has just parked.

**Fix shape:** hoist the finiteness sweep above the `parentId === null` skip, or out of the group loop entirely. It has no group-level precondition.

---

### 4. The one-conversation-one-node invariant lives **only** in the DB, and the guard that does exist cannot see across workspaces. — **MEDIUM**

The domain invariant is enforced at `packages/db/drizzle/0255_boring_leo.sql:28`:

```sql
CREATE UNIQUE INDEX "agent_workspace_nodes_chat_target_idx"
  ON "agent_workspace_nodes" ("targetId") WHERE "targetKind" = 'chat';
```

The brief flags the `bind`/`create` half of this as a known gap being fixed elsewhere. Confirming it, and adding two parts that the same-workspace fix will not cover:

**(a) `validateTree` has no such invariant either.** Executed:

```
validateTree([root, pane a→chat c1, pane b→chat c1])  → { ok: true }
```

So the gap is not only in `bind`/`create`; it is in the function the `put` path runs. A fix confined to the two operations leaves the wire's node-set write open.

**(b) The index is GLOBAL; `nodeShowing` is per-workspace.** `workspace-node-commands.ts:336-341` finds the node showing a target by scanning `nodes` — which *is* one workspace's list, by design (`workspace-node-rows.ts:23-28`). A conversation already bound in a **different** workspace is invisible to it. Executed against the live table:

```
INSERT ... ('x','W2','R',0,'pane','chat','conv-9', now());   -- INSERT 0 1
INSERT ... ('z','W' ,'R',5,'pane','chat','conv-9', now());
  ERROR: duplicate key value violates unique constraint "agent_workspace_nodes_chat_target_idx"
  DETAIL: Key ("targetId")=(conv-9) already exists.
```

The schema's argument for going global (`agent-workspace-nodes.ts:201-212`) is that `conversations.workspaceId` is permanent, so one conversation implies one workspace and the constraint can never fire. That is a sound argument about *correct* data; it is not a defense against a backfill, a fork bug, or a conversation whose workspace was rewritten. When it does fire, no TypeScript layer has anything to say and the client eats a raw `23505` — which is precisely the divergence class the brief asks about.

---

### 5. `validateTree` is O(n²) and costs **217 ms** at `MAX_NODES`, on the serializing write path. — **MEDIUM**

`packages/lib/src/agent-workspaces/workspace-node-validate.ts:113-124, 230, 242, 262` — `childrenOf` (itself a full `filter` + `sort` over the list) is called once per node in `siblingGroups`, once per split for `degenerate_split`, once per pane for `pane_has_children`, and once per node inside `descendantsOf` for the reachability set.

**Measured:**

| shape | nodes | `validateTree` |
|---|---|---|
| flat (one root, all panes as siblings) | 2048 (`MAX_NODES`) | **217.2 ms** |
| balanced binary split tree | 511 | 10.5 ms |
| `create()` end-to-end on the 511-node tree | 511 | 10.2 ms |

The flat shape is the worst case and it is the one the cap was sized for: `MAX_NODES = 2048` is explicitly justified (`:38-47`) as headroom over a migrated `64 × 16` grid, ~1089 nodes. Every write runs this inside the transaction that holds the `agent_workspace_node_revs` row lock (`agent-workspace-nodes.ts:70-77`), so it is 217 ms of pure CPU during which no other edit to that workspace can proceed — and each operation validates twice in practice (`accept` sweeps, then `validateTree` re-sweeps).

Not a correctness bug and not urgent at realistic sizes, but it is a cost the cap's own justification implies someone will reach. Indexing children by `parentId` once at the top of `validateTree` collapses all four passes to O(n).

---

### 6. The "byte-identical round-trip" the modules promise is false — key order differs. — **MEDIUM**

`workspace-node-rows.ts:13-21` and `workspace-node.ts:88-92`:

> "A node rehydrated from rows must be **byte-identical** to the one the algebra built […] any difference — `{}` vs `{fraction: null}` vs `{fraction: undefined}` — makes every write look like a change and puts the two planes permanently out of step."

The property the code actually holds is **deep equality**, which is weaker. Executed — after `resize`, and again after `bind`:

```
algebra:      {"nodeType":"pane","id":"p0","parentId":"s1","position":0,"target":{...},"fraction":0.3}
nodeFromRow:  {"nodeType":"pane","id":"p0","parentId":"s1","position":0,"fraction":0.3,"target":{...}}
JSON.stringify equal: false
```

`withFraction` (`workspace-node-algebra.ts:143-149`) appends `fraction` by spread, so it lands **after** `target`; the row transform (`workspace-node-rows.ts:150-157`) emits it **before**. Same keys, same values, different bytes.

This matters because the docblock names the exact mechanism that would break — and that mechanism is real and adjacent. `workspace-layout-verbs.ts:152-155` documents the existing store's change detection as "a `JSON.stringify` comparison of the grid it just read against the grid it is about to write", and gives quantization as the fix that makes the round-trip an identity. A Phase-3 store that reuses that idiom on nodes will see **every** write as a change: no idempotence, a rev bump per retry, a re-broadcast per unrelated edit. That is the failure the docblock predicts, and the code does not actually prevent it.

Either the claim weakens to "deep-equal, and the change test must not be `JSON.stringify`", or the two producers agree on key order.

---

### 7. At exactly `MAX_NODES`, an eviction that nets zero growth is refused. — **LOW-MEDIUM**

`workspace-node-commands.ts:575-578` — `open`'s eviction path creates the newcomer **before** moving the displaced pane out, deliberately, "so no group momentarily has a hole". `compile` never persists the intermediate, but `create` validates it, and the transient tree is one node over.

**Executed** on a root holding 2047 bound panes (2048 nodes total, exactly at the cap):

```
openConversation(..., preferSplit: true)  → max_nodes_exceeded: 2050 nodes; the cap is 2048
openConversation(...)                     → max_nodes_exceeded: 2049 nodes; the cap is 2048
```

The second is the eviction path, whose net effect on node count is **zero**. A workspace sitting exactly at the cap can never open another conversation, even by swapping one out. `replaceConversation` is unaffected (two moves, no create). Reachable only by deliberately filling a workspace, hence low — but the refusal is an artifact of step ordering, not of the cap, and the message says something untrue about the write that was requested.

---

### 8. `openConversation` refuses a parked target; `replaceConversation` silently un-parks one. — **LOW-MEDIUM**

`workspace-node-commands.ts:531-539` refuses, with a well-argued rationale: bringing a parked node back "is a `move`, and the caller names it."

`replaceConversation` (`:365-408`) does exactly that move on the caller's behalf, without comment. **Executed** on `[root, a→chat c1 (in grid), b→chat c2 (parked)]`:

```
openConversation({ target: chat c2 })          → { ok:false, code:'already_bound', "...is parked; showing it again is a move, not a second mint" }
replaceConversation({ nodeId:'a', target: chat c2 })
  → { ok:true, put:[ b→R pos0, a→parked ] }    -- un-parked b without being asked to
```

Two commands in the layer whose whole job is to carry policy answer "put conversation c2 on screen" with a refusal and a success respectively. One of the two is wrong; the code does not say which, and the asymmetry is undocumented on both sides.

---

### 9. A detached pane keeps a stale `fraction` through the row round-trip. — **LOW**

`workspace-node-validate.ts:276-277` skips the parked group, so `validateTree([root, parkedPane{fraction:0.5}])` → `ok`. The algebra always strips it (`reseat` at `workspace-node-algebra.ts:189-192` maps the parked group to `null`), and `move`-ing such a pane back into the grid does strip it — verified. So it is dead data, not a live fault. But it is a state the algebra cannot produce and the rows can carry, which is a small hole in the "one canonical form" claim, and it is a second-order contributor to finding #6.

---

### 10. The composite self-FK's constraint name is truncated by Postgres. — **LOW**

Applying `0255_boring_leo.sql` verbatim:

```
NOTICE:  identifier "agent_workspace_nodes_rootId_parentId_agent_workspace_nodes_rootId_id_fk"
         will be truncated to "agent_workspace_nodes_rootId_parentId_agent_workspace_nodes_roo"
```

The migration succeeds and the constraint is correct. But the name in the database is not the name in the migration, so any future `ALTER TABLE … DROP CONSTRAINT "…_rootId_id_fk"` written from the schema file will fail. Worth an explicit `.name()` on the `foreignKey()` at `agent-workspace-nodes.ts:186` before anything depends on it.

---

### 11. `put` carries no ordering guarantee, and a row-at-a-time writer would violate the FK. — **LOW**

`writeBetween` (`workspace-node-algebra.ts:220-230`) returns `next.filter(...)`, whose order comes from `upsertNodes`' replace-in-place-then-append. It happens to be parent-first in the cases observed (`split` emits `[container, pane, newPane]`), but nothing establishes it. A Phase-3 writer that loops over `put` issuing one `INSERT … ON CONFLICT` per row will hit the composite self-FK the moment a child precedes its parent. A single multi-row statement is immune (FK triggers fire at end of statement); a loop is not. Worth one sentence in `NodeWrite`'s docblock.

---

### 12. `validateTree` spends the cast that `descendantsOf` refuses to. — **LOW (consistency)**

`workspace-node.ts:174-177` argues the case explicitly, and the loop below it obeys:

> "Drained by the `undefined` `shift()` actually returns when empty, rather than by a length check plus a cast that asserts what the check implied — **this model's whole thesis is that a cast is a lie the type checker vouches for**, and the boundary should not spend one on its own loop."

`workspace-node-validate.ts:222-223`, in the same subsystem, does exactly the condemned thing:

```ts
while (queue.length > 0) {
  const { id, depth } = queue.shift() as { id: string; depth: number };
```

Harmless at runtime. But it is the one place the code contradicts a rule it took a paragraph to state, and the fix is the idiom already written twenty lines away.

---

## The re-parenting hazard — as required

**Failure-path `parentId` assignments across all five modules: ZERO. Confirmed.** No `?? root`, no `|| root`, no "if the parent is missing, use the root" branch exists anywhere in the reviewed files.

Every `parentId` **write** to a node, quoted in full. Reads (`node.parentId === null`, `const parentId = node.parentId`, `childrenOf(nodes, parentId)`, `GroupOrder.parentId`, type declarations, `SiblingGroup` records) are excluded — they are not assignments and are not counted.

| # | Site | Code | Path | Source of the value |
|---|---|---|---|---|
| 1 | `workspace-node-rows.ts:111` | `.transform(({ id, axis }) => ({ nodeType: 'root' as const, id, parentId: null, ... }))` | success | literal; the schema already pinned `parentId: z.null()` |
| 2 | `workspace-node-rows.ts:124-127` | `.transform(({ id, parentId, position, axis, fraction }) => ({ nodeType: 'split' as const, id, parentId, ... }))` | success | pass-through from the row |
| 3 | `workspace-node-rows.ts:150-153` | `.transform(({ id, parentId, position, fraction, targetKind, targetId }) => ({ nodeType: 'pane' as const, id, parentId, ... }))` | success | pass-through from the row |
| 4 | `workspace-node-rows.ts:222` | `parentId: null,` (in `rowFromNode`, `case 'root'`) | success | literal; `RootNode.parentId` is typed `null` |
| 5 | `workspace-node-rows.ts:232` | `parentId: node.parentId,` (`case 'split'`) | success | pass-through from the node |
| 6 | `workspace-node-rows.ts:244` | `parentId: node.parentId,` (`case 'pane'`) | success | pass-through from the node |
| 7 | `workspace-node-algebra.ts:355` | `const minted: PaneNode = { nodeType: 'pane', id: nodeId, parentId, position: at, target };` | success | **the caller's** `input.parentId`, already proven to resolve at `:340-342` |
| 8 | `workspace-node-algebra.ts:403` | `arriving = { ...node, parentId };` (the `parentId === null` branch of `move`) | success | **the caller's** `null` — parking, an intent, not a repair |
| 9 | `workspace-node-algebra.ts:419` | `arriving = { ...node, parentId };` | success | **the caller's** `input.parentId`, proven to resolve at `:409-411` |
| 10 | `workspace-node-algebra.ts:465-468` | `const survivor = withFraction({ ...vacated[0], parentId: container.parentId }, container.fraction ?? null);` | success | the collapsing split's own parent |
| 11 | `workspace-node-commands.ts:200-206` | `const container: SplitNode = { nodeType:'split', id: input.newSplitId, parentId, ... }` | success | the split pane's own parent, passed in at `:253` as `node.parentId` after `:239` proved it non-null |
| 12 | `workspace-node-commands.ts:210` | `{ ...unsized, parentId: input.newSplitId, position: 0 }` | success | the container minted one line above |

**Twelve writes, all on success paths, none on a failure path.** Six are pass-throughs at the row boundary. Four take the caller's value verbatim, each after the operation has already proven the value resolves — and each refuses (`unknown_parent`, `not_a_container`) rather than substituting when it does not.

**Site 10 is the only one that moves a node the caller did not name**, and the code says so at `:447-452`: the survivor of a collapsed split inherits that split's parent, slot and share. It is on a success path, it puts a node exactly where the container that held it was, and it never rescues a pointer that failed to resolve. Mutation **M12** confirms a named test pins the share half of it. This is correct and correctly documented.

`CreateInput.parentId` / `MoveInput.parentId` construction sites (`commands.ts:315, 406, 547, 576, 577`) are **arguments**, not node fields — the command stating where it wants something to go. `parentId: null` there is `closePane` and the eviction path saying "park this", which is the model's own vocabulary for a location.

---

## Mutation table

27 mutations across **five** modules (brief asked for ≥6 across ≥3). Each applied mechanically, suite run, file restored from an in-memory original. Suite: `workspace-node*.test.ts`, 223 tests, green at baseline and after restore.

| # | Module | Mutation | Result |
|---|---|---|---|
| M1 | `workspace-node.ts` | `childrenOf` drops its `.sort()` | killed by 16 |
| M2 | `workspace-node.ts` | `descendantsOf` stops seeding `seen` with the start id | killed by 1 — *`descendantsOf` › should not report the node itself* |
| M3 | `workspace-node.ts` | `upsertNodes` appends instead of replacing in place | killed by 49 |
| M4 | `workspace-node-validate.ts` | `fraction_not_finite` removed | killed by 3 |
| M5 | `workspace-node-validate.ts` | `position_contiguity` removed | killed by 6 |
| M6 | `workspace-node-validate.ts` | reachability stops exempting the parked panes | killed by 32 |
| M7 | `workspace-node-validate.ts` | `degenerate_split` threshold `< 2` → `< 1` | killed by 2 |
| M8 | `workspace-node-validate.ts` | `fraction_mixed` removed | killed by 2 |
| M9 | `workspace-node-validate.ts` | cycle detection `return` → `break` | killed by 2 — *reject a cycle of parent pointers*, *reject a node parented to itself* |
| M10 | `workspace-node-algebra.ts` | `isSlot` drops `Number.isInteger` | killed by 1 — *refuse a fractional index, which slicing would round to somewhere else* |
| M11 | `workspace-node-algebra.ts` | a node moved under a new parent keeps its old share | killed by 1 — *give a node arriving under a new parent an even share* |
| M12 | `workspace-node-algebra.ts` | the collapse survivor stops inheriting the split's share | killed by 1 — *hand the surviving child the split's own share, so the parent still sums to one* |
| M13 | `workspace-node-algebra.ts` | `bind` stops refusing a re-point | killed by 1 — *refuse a pane that is already showing something, because a binding is for life* |
| M14 | `workspace-node-algebra.ts` | `accept()` drops its `not_a_container` gate | killed by 6 |
| M15 | `workspace-node-algebra.ts` | `move` drops its `parent_in_subtree` check | killed by 1 — *refuse a destination inside the moving node's own subtree* |
| M16 | `workspace-node-rows.ts` | the half-bound-pane `.refine` removed | killed by 2 (kind-without-id **and** id-without-kind) |
| M17 | `workspace-node-rows.ts` | `node.fraction ?? null` → `\|\| null` for a split | killed by 3 — incl. *write a zero fraction as zero, not as the absent state* |
| M18 | `workspace-node-rows.ts` | `nodesFromRows` filters foreign rows instead of rejecting | killed by 3 |
| M19 | `workspace-node-rows.ts` | `buildRenderTree` drops its visited set | killed by 1 — *terminate on a list that repeats an id* |
| M20 | `workspace-node-rows.ts` | root transform stops pinning `position` to `0` | killed by 1 — *reject a root row ordered anywhere but first* |
| M21 | `workspace-node-commands.ts` | `parkedSlot` counts the mover itself | killed by 1 — *write nothing for a pane that is already out of the grid* |
| **M22** | `workspace-node-commands.ts` | `replaceConversation` seats the replacement **before** the displaced pane (`+ 1` removed) | **SURVIVED — equivalent mutant** (see below) |
| M23 | `workspace-node-commands.ts` | `replaceConversation` parks the displaced pane **first** | killed by 5 |
| M24 | `workspace-node-commands.ts` | `stageContainer` stops stripping the split pane's share | killed by 1 — *leave the new container unsized, because nobody has sized it yet* |
| **M25** | `workspace-node-commands.ts` | `open()` stops refusing a blank target id | **SURVIVED — real coverage gap** (see below) |
| M26 | `workspace-node-commands.ts` | the ACTIVE pane no longer wins placement | killed by 1 — *prefer the ACTIVE pane over an earlier eligible one* |
| M27 | `workspace-node-commands.ts` | `split` stops refusing a parked pane | killed by 2 — incl. *should not re-attach a parked pane to the root in order to split it* |

**25 of 27 killed.** Most by a single, precisely-named test — the suite is not padding.

**M22 is an equivalent mutant, not a gap.** Verified by direct construction: the displaced pane always leaves the group, so inserting the replacement immediately before it and immediately after it converge on the same final order. Run with and without the mutation across three placements (displaced first / middle / last, replacement parked / already a sibling), the grid order is identical in every case:

```
+1 intact:  ["b@0","x@1","y@2"]  ["x@0","b@1","y@2"]  ["x@0","b@1"]
+1 removed: ["b@0","x@1","y@2"]  ["x@0","b@1","y@2"]  ["x@0","b@1"]
```

The `+ 1` at `commands.ts:401` is therefore unobservable precision. Harmless; a candidate for deletion or for a comment saying it is cosmetic. (Note `commands.ts:574` has the same `+ 1` on the eviction path, where it **is** load-bearing — M26 territory — so they should not be "simplified" together.)

**M25 is a real coverage gap and it guards finding #2.** The guard at `commands.ts:526-528` is the only thing standing between `open`'s split path and a pane bound to `''`. The test that appears to cover it (`workspace-node-commands.test.ts:738`) builds a tree containing an **unbound** pane, so placement takes the *fill* path and is refused by `bind`'s guard instead — it passes with `open`'s guard deleted. The split path needs its own case: a tree whose panes are all terminals (nothing replaceable), forcing `splitInto` → `create(…, { kind:'chat', id:'  ' })`, which `create` accepts.

---

## The SQL — does every TypeScript constraint reach the database?

Migration `0255_boring_leo.sql` applied **verbatim** to PostgreSQL 17.5. **Yes — all nine objects are present.** Nothing is schema-file-only.

| Schema declaration | In `0255`? | Live in PG after apply |
|---|---|---|
| `pk: primaryKey([rootId, id])` (constraint 1) | ✅ `:15` | `agent_workspace_nodes_rootId_id_pk` (`p`) |
| `parentFk` composite self-FK, cascade (constraint 2) | ✅ `:26` | `agent_workspace_nodes_rootId_parentId_agent_workspace_nodes_roo` (`f`) — **name truncated, finding #10** |
| `rootId → agent_workspaces` cascade (constraint 3) | ✅ `:24` | `agent_workspace_nodes_rootId_agent_workspaces_id_fk` (`f`) |
| `oneRootPerWorkspace` partial unique (constraint 4) | ✅ `:27` | `agent_workspace_nodes_one_root_idx` |
| `rootHasNoParent` CHECK (constraint 5) | ✅ `:17` | `agent_workspace_nodes_root_no_parent_chk` (`c`) |
| `oneNodePerChat` partial unique (constraint 6) | ✅ `:28` | `agent_workspace_nodes_chat_target_idx` |
| `nodeTypeValues` CHECK (domain closure) | ✅ `:18` | `agent_workspace_nodes_node_type_chk` (`c`) |
| `targetKindValues` CHECK (domain closure) | ✅ `:19` | `agent_workspace_nodes_target_kind_chk` (`c`) |
| `parentIdx` (FK support index) | ✅ `:29` | `agent_workspace_nodes_parent_idx` |
| `agent_workspace_node_revs` + FK + default | ✅ `:1-4, 23` | present |

The table-qualified column references inside the CHECK expressions and the partial-index predicates (`WHERE "agent_workspace_nodes"."nodeType" = 'root'`) are accepted by Postgres and normalize correctly — worth confirming since Drizzle's generated form is unusual there.

The two domain-closure CHECKs are load-bearing exactly as `agent-workspace-nodes.ts:237-248` argues: without them a `'Root'` or `'Chat'` spelling would **exit** the partial indexes rather than violate them. Good call, and it is in the migration.

---

## Cross-layer coherence — the divergence matrix

What each layer refuses, tested end to end. Every row executed.

| State | `validateTree` | algebra `accept()` | row parse | Postgres | divergence |
|---|---|---|---|---|---|
| two panes → one chat, same workspace | ✅ accepts | ✅ accepts | ✅ accepts | ❌ **23505** | **finding #4** (known gap + `validateTree` + put path) |
| same chat, **different** workspaces | ✅ accepts | ✅ accepts | ✅ accepts | ❌ **23505** | **finding #4(b)** — not covered by the same-workspace fix |
| node id `''` | ✅ accepts | ✅ accepts | ❌ throws | ✅ stores | **finding #2** |
| chat target id `''` | ✅ accepts | ✅ accepts | ❌ throws | ✅ stores | **finding #2** |
| chat target id `'   '` | ✅ accepts | ✅ accepts (`create`) / ❌ (`bind`, `open`) | ✅ accepts | ✅ stores | finding #2, milder |
| `fraction: NaN`/`Infinity` on a **parked** pane | ✅ **accepts** | ❌ `invalid_fraction` | ❌ throws | ✅ stores | **finding #3** |
| `fraction: NaN` on an attached pane | ❌ `fraction_not_finite` | ❌ | ❌ | ✅ stores | consistent |
| root with `position ≠ 0` | n/a (typed) | n/a | ❌ throws | ✅ stores | deliberate (`rows.ts:5-11`) |
| pane carrying an `axis`; half-bound pane | n/a (typed) | n/a | ❌ throws | ✅ stores | deliberate (`schema:57-65`) |
| parent-pointer cycle | ❌ `cycle` | ❌ | ✅ per row | ✅ stores | deliberate (`schema:47-56`) |
| node parented to a pane | ❌ `pane_has_children` | ❌ `not_a_container` | ✅ per row | ✅ stores | deliberate |
| write applied **drop-then-put** | — | — | — | ❌ **cascades away a live subtree** | **finding #1** |

The bottom four rows are documented, argued, and correct: they are set-level properties a table cannot state, or single-row shape the parse deliberately owns. The top six are not.

---

## Scope, purity, vocabulary

- **No `any`, no `@ts-ignore`, no `@ts-expect-error`, no eslint suppressions** in any reviewed file. `bun run --filter @pagespace/lib --filter @pagespace/db typecheck` is clean for both packages (the only errors observed came from my own probe files and are gone).
- **Purity:** all five modules are total functions over their inputs — no I/O, no clock, no `Math.random`, no mutation of an argument. `reseat`/`upsertNodes`/`removeNodes` all copy. Confirmed by reading and by the property suite in `workspace-node-rows.test.ts`.
- **One cast**, at `workspace-node-validate.ts:223`, contradicting the rule `workspace-node.ts:174-177` states — finding #12.
- **Vocabulary:** there is no `attach` or `detach` **operation**, in either the algebra or the commands. "Detached" appears only as a state (`detachedOf`, `PaneNode.parentId === null`, `CommandCode.detached_pane`), and every mention of "attach" is prose explaining why the operation does not exist. Correct throughout.
  - One nit: the rejection code `not_detachable` (`algebra.ts:89, 399`) is the only identifier that implies a `detach` verb. It is returned by `move`, whose refusal is really "a split has no target, so it cannot be parked". `not_parkable` would say the same thing in the model's own words.
- **Scope reduction:** nothing dead found beyond the equivalent `+ 1` at `commands.ts:401` (M22). Every exported symbol has a caller or is a documented boundary. `RenderTree.orphaned` is reported-never-repaired as documented, and the three fields do partition the input exactly — verified over seven hostile lists (empty, root-only, duplicate id, two roots, disjoint cycle, node under a parked pane, no root): **PARTITION OK** in all seven.

---

## What earlier passes established — verified, not re-derived

- **"Zero `parentId` assignments on failure paths."** ✅ **Confirmed** — full enumeration above, twelve success-path writes quoted, zero on failure paths. `const parentId = node.parentId` (`commands.ts:379, 573`) correctly identified as a READ.
- **"The row translation takes a required `rootId` and REJECTS foreign rows rather than filtering."** ✅ **Confirmed** — `rows.ts:194-202`, and mutation **M18** (filter instead of reject) is killed by three named tests including one that pins the foreign workspace id appearing in the error message.
- **"validateTree covers thirteen invariants."** ✅ Confirmed: fourteen codes in `TreeViolationCode`, thirteen distinct checks (`no_root`/`multiple_roots` share a step). Each is independently pinned — mutations M4–M9 each killed only their own tests.
- **"A known gap where `bind`/`create` accept an already-shown chat target, being fixed on a separate branch."** ✅ **Present here, as expected.** Recorded as finding #4 with two extensions the same-workspace fix will not cover: `validateTree` has no such invariant either, and the constraint is global while `nodeShowing` is per-workspace.

---

## Recommendation

Fix **#1** and **#2** before merge — both are unrecoverable-state defects and both are small changes. **#3** is one line moved and closes the same class. **#4(b)** and **#6** should be recorded against Phase 3 rather than fixed here, but they must be recorded, because both are landmines that only detonate once a writer exists. **M25**'s missing test should land with the #2 fix; it is the test that would have caught it.

Everything else is a note.

The model is right. The layering is right, the refuse-never-repair discipline holds under adversarial probing, and the tests are real. What is missing is the agreement between the algebra's idea of applying a write and the table's, and a shape check on the two strings that every other layer assumes are non-empty.

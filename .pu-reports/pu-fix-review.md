# Closing the Phase 1 review — the two HIGHs and everything argued around them

**Branch:** `pu/fix-review`, on `pu/workspace-node-model`
**Review of record:** `.pu-reports/pu-rev-phase1.md` on `pu/rev-phase1` (DO NOT MERGE, findings #1 and #2)
**Suite:** `bun run --filter @pagespace/lib test -- src/agent-workspaces` — **532 passed / 15 files** at baseline, **545 passed / 16 files** now. `bun run --filter @pagespace/lib --filter @pagespace/db typecheck` clean; `lint` clean. No `any`, no suppressions.

All three defects are latent — nothing writes these tables yet — so nothing here is a live fix. That is the point: each one is cheap now and needs a hand-written `DELETE` against production later.

---

## Finding 1 (HIGH) — `applyNodeWrite` prescribed an order that destroys subtrees

### What I changed

`workspace-node-algebra.ts` — `applyNodeWrite` is now **put before drop**:

```ts
export function applyNodeWrite(nodes, write) {
  return removeNodes(upsertNodes(nodes, write.put), write.drop);
}
```

The docblock no longer prescribes the dangerous order; it says the order is load-bearing **because of the cascade**, names the constraint, explains that applying `put` first leaves the dropped container childless so the cascade has nothing to reach, and says plainly not to tidy it back. `NodeWrite`'s own docblock now carries the two things a persisting writer owes the type — put-before-drop, and put-as-one-statement (finding #11, below). The schema file carries the same fact from the other side, next to the FK that causes it.

### How I proved it

The order is **unobservable in memory** — `removeNodes` removes exactly the ids it is named, so both orders agree on every disjoint write. The review says this too. A test that only applies the write in memory therefore cannot fail while the bug is live, whatever tree shape it uses. So the test substitutes the storage's delete semantics for the model's and runs the real `applyNodeWrite` against them: `packages/lib/src/agent-workspaces/__tests__/workspace-node-cascade.test.ts` mocks `removeNodes` to a transitive cascade — `ON DELETE cascade` on `(rootId,parentId) → (rootId,id)` — and nothing else.

The shape is the review's, exactly: `R → s1 → { s2 → {a,b}, c }` plus `R → d`, then `move(c → R, index 1)`. It promotes `s2`, drops `s1`, and `a`/`b` are correctly absent from `put`.

Before the fix, red:

```
AssertionError: expected [ 'c', 'd', 'root-1', 's2' ] to deeply equal [ 'a', 'b', 'c', 'd', 'root-1', 's2' ]
```

Three tests: the `move` collapse, the `destroy` collapse (same path, same promoted node), and a `destroy` of a whole subtree — the third is a guard against over-correcting, since a write that genuinely destroys a subtree names every row of it in `drop` and must still remove them. It passes in both orders and is there to stay passing.

**And I ran it against a real database.** Migration `0255`'s shape, PostgreSQL 17.5 (`pagespace-postgres-test`, scratch database created and dropped):

| | surviving rows |
|---|---|
| immediate FK, drop-then-put | `R, c, d, s2` — **`a` and `b` destroyed** |
| immediate FK, put-then-drop | `R, a, b, c, d, s2` — correct |

---

## Finding 2 (HIGH) — `create` accepted an empty `nodeId` and a blank `targetId`

### What I changed

**`create` refuses both**, with typed codes. A new `invalid_id` on `NodeOperationCode` for the node id; `invalid_target` for the target, the same code `bind` already returns, because it is the same fault at the other end of a pane's life. Both use `trim() === ''`, which is how `bind` already spells it — `z.string().min(1)` at the row boundary is satisfied by `'   '`, so a length test would let the whitespace case through. The blank-id check is **first**, ahead of the duplicate check: a blank id is not an id that is taken, it is not an id, and everything below resolves nodes by one. The blank-target check is ahead of `shownElsewhere`, so two panes minted onto nothing are answered with the fault rather than with each other.

**`validateTree` refuses blank node ids and blank target ids**, new code `blank_id`, placed after the node cap and **before** uniqueness. Argued in full below.

**The false comment is corrected.** `bind` no longer claims "This is the only place it can be caught." It now says it is one of two — a pane reaches a target either by being filled here or by being minted already carrying one, `create` states the identical rule for the second, and only `validateTree` sees both plus the `put(nodes[])` write that goes through neither.

**The untested guard is gone, not re-tested.** `open`'s guard at `workspace-node-commands.ts:526` existed for one stated reason: "`bind` refuses a blank target id and `create` does not". That reason no longer exists. Keeping it would leave a branch no test could distinguish from the layer below it — the mutation would still survive, which is the defect, not the test. The comment in its place says why there is nothing there.

While I was in `accept()`'s docblock I corrected it too: it claimed its three checks "are not duplicates of `validateTree` — they are invariants it does not state", and `validateTree` states all three (`duplicate_id`, `pane_has_children`, and — after finding #3 — `fraction_not_finite`). It now says the true thing: they are there for the **order** and the **vocabulary**, so an operation names the fault that is about what the caller asked. The same false claim in a test comment at `workspace-node-algebra.test.ts` is corrected to match.

### How I proved it

The sequence the review asked for, run in that order:

1. Wrote the split-path test — `open` → `splitInto` → `create(…, target)`, forced by a tree whose panes are all terminals so nothing is replaceable. **It passed**, because `open`'s guard caught it first.
2. Removed `open`'s guard. **The split-path test went red and the fill-path test stayed green** — the review's M25, reproduced exactly:

```
× openConversation rejections > should refuse a target with a blank id on the SPLIT path…
  Tests  1 failed | 72 passed (73)
```

3. Fixed `create`. Green.

Six new tests: blank/whitespace `nodeId` and blank target id on `create`; blank node id, whitespace-only node id and blank target id on `validateTree`; and a third command route — `openConversation` into an **empty grid**, which mints straight into the root with no pane for `bind` to refuse through, and which had nothing behind it once `open`'s guard was removed. The existing fill-path test is renamed to say which path it covers.

---

## Finding 3 (MEDIUM-HIGH) — no finiteness check on the parked group

### What I changed

The finiteness sweep is **hoisted out of the group loop entirely**, into its own pass over every node, ahead of the per-container fraction rules. It had no group-level precondition: `fraction_mixed` and `fraction_sum` are questions about a container, and this is a question about one number. The parked group was exempt from it by position rather than by intent — the skip that correctly exempts parked panes from the two container rules was also skipping this one. The comment explaining the NaN reasoning moved with it and now says that parking a pane does not make its share a number.

The sum check's comment now says its terms are already known finite, which is what makes the comparison mean anything.

### How I proved it

`validateTree` on `[root, onscreen, parked{fraction: NaN}]` returned `{ ok: true }` before, `fraction_not_finite` after; same for `Infinity`. Mutation F3 (below) puts the sweep back under the parked skip and exactly that test goes red.

`accept()`'s own sweep in the algebra is kept. It is now a duplicate of a rule `validateTree` states, and it is pinned by an existing test that expects the operation's `invalid_fraction` rather than the validator's `fraction_not_finite` — one operation should not answer with two vocabularies depending on whose share was bad. That is what its docblock now says.

---

## Findings 11 and 12, fixed in passing

**#11 — `put` carries no ordering guarantee.** One sentence, as the review suggested, in `NodeWrite`'s docblock rather than buried: `put`'s order is whatever `upsertNodes` produced and nothing establishes that a parent precedes its children, so a persisting writer must issue **one multi-row statement**, never a row-at-a-time loop. Verified against PostgreSQL 17.5 — see the deferrable-FK argument below, cases D and F.

**#12 — the cast `descendantsOf` refuses to spend.** `validateTree`'s depth walk was `queue.shift() as { id: string; depth: number }`. It now drains by the `undefined` `shift()` actually returns, the idiom written twenty lines away in `workspace-node.ts`, with the comment pointing at the rule it obeys. Mutation F12 confirms the rewritten loop still traverses.

---

## Finding 10, closed as a comment rather than a rename

The composite self-FK's generated name is 72 characters; Postgres truncates identifiers at 63, so the constraint in the database is `agent_workspace_nodes_rootId_parentId_agent_workspace_nodes_roo`. I verified the length and the prefix. Giving it an explicit short name is a **rename**, which needs its own migration and cannot be done by editing `0255` — so the schema now records the truncated form next to the constraint, which is what a future `DROP CONSTRAINT` written from the schema file actually needs.

---

## Mutation table

Each mutation applied mechanically, the full `src/agent-workspaces` suite run, the file restored from a byte copy. Baseline 545 passed.

| # | Module | Mutation | Result |
|---|---|---|---|
| **F1** | `workspace-node-algebra.ts` | `applyNodeWrite` back to drop-then-put | **killed by 2** — the `move` collapse and the `destroy` collapse, both in `workspace-node-cascade.test.ts`. Nothing else moved. |
| **F2a** | `workspace-node-algebra.ts` | `create` stops refusing a blank `nodeId` | **killed by 1** — *create › should refuse a blank node id…* |
| **F2b** | `workspace-node-algebra.ts` | `create` stops refusing a blank target id | **killed by 3** — *create › should refuse a blank target id at the MINT*, plus the **SPLIT path** and **EMPTY grid** command tests. The fill-path test stays green, which is the point: it is refused by `bind`. |
| **F2c** | `workspace-node-validate.ts` | `validateTree` stops refusing a blank node id | **killed by 2** — the blank and the whitespace-only cases |
| **F2d** | `workspace-node-validate.ts` | `validateTree` stops refusing a blank target id | **killed by 1** |
| **F2e** | `workspace-node-algebra.ts` | `bind` stops refusing a blank target id | **killed by 2** — its own test and the **FILL path** command test. The split-path test stays green. The two paths are now pinned separately, each by the layer that refuses it. |
| **F3** | `workspace-node-validate.ts` | finiteness sweep put back under the parked-group skip | **killed by 1** — *should reject a non-finite share on a PARKED pane* |
| **F6** | `workspace-node-rows.ts` | pane transform emits `fraction` always instead of as an absence | **killed by 5**, including the new *should round-trip an UNSIZED node the algebra built with no fraction key at all* |
| **F12** | `workspace-node-validate.ts` | depth walk stops incrementing depth | **killed by 2** — the validator's depth cap and `split`'s |

F2b and F2e together are the finding-2 result worth reading twice: **each path is killed by its own guard and not by the other's.** That is precisely what was not true before — the fill path passed with `open`'s guard deleted, so the guard that stood between the split path and an unreadable row had no test at all.

F6 is honest about what it shows: the two new round-trip tests pin a property that was already true, and one of them dies alongside three pre-existing tests. They are coverage of a producer the property suite never exercised, not a fix.

---

## The deferrable FK — my answer is **no**, and it is not a close call

The proposal: make the composite self-FK `DEFERRABLE INITIALLY DEFERRED` so the ordering stops being load-bearing.

**It does not do that.** I did not want to answer this from memory, so I built the real shape twice — once immediate, once deferrable — on PostgreSQL 17.5 and ran the review's tree through both:

| # | constraint | transaction | surviving rows |
|---|---|---|---|
| A | immediate | `DELETE s1` → upsert `put` | `R, c, d, s2` — **`a`, `b` destroyed** |
| B | immediate | upsert `put` → `DELETE s1` | `R, a, b, c, d, s2` — correct |
| **C** | **DEFERRABLE INITIALLY DEFERRED** | `DELETE s1` → upsert `put` | **`R, c, d, s2` — `a`, `b` destroyed anyway** |

`DEFERRABLE` defers the **check**. It does not defer the **referential action**: the `ON DELETE CASCADE` fires at the statement, takes the subtree, and by commit time there is nothing left to find inconsistent — so the constraint is satisfied and the data is gone. Deferring buys silence, not safety. It would have left finding #1 live while making it look addressed, which is worse than the bug.

Three further reasons I would not want it even if it had worked:

1. **It would make the deleted SET depend on statements issued after the DELETE.** A deferred cascade fires against the state at commit, so what a `DELETE` removes stops being a function of the `DELETE`. "Put before drop" is a rule about one call site; that is a rule about the whole transaction, and it is much harder to hold in your head.
2. **It moves every violation from the statement to `COMMIT`,** where there is no statement context to attribute it to, and it silently launders transient violations that today fail loudly and name the row.
3. **It hides the requirement in a table attribute** that no reader of the write code can see, whereas the fix is one line at the site, documented with the reason, and pinned by a test that models the cascade.

**What deferrability would genuinely buy is finding #11 — and it is not needed for that either.** Same database, same session:

| # | constraint | write | result |
|---|---|---|---|
| D | immediate | child then parent, **one row per statement** | `ERROR: … violates foreign key constraint … Key (rootId, parentId)=(W, box) is not present` |
| E | deferrable | same loop | succeeds |
| F | immediate | child and parent in **one multi-row statement** | succeeds |

So the row-at-a-time hazard the review flagged is real (D), deferring would fix it (E), and so does the thing a writer should be doing anyway (F) — FK triggers fire at end of statement, so a single multi-row upsert is immune. That is now stated on `NodeWrite`. **Recommendation: leave the FK immediate.**

---

## Blank ids in `validateTree` — yes, and here is the argument

I agree with your view, and the reason is stronger than symmetry with uniqueness.

**The wire primitive is `put(nodes[])` — a node SET.** A client that assembles its own nodes never goes through `create` or `bind` at all, so guards on the operations are not a gate for the write path most likely to carry a client-side id bug. `validateTree` is the function every write path runs. Putting the rule only in the algebra would be putting it everywhere except where it is needed.

**The shape of an id is exactly as invariant as its uniqueness, and for the identical reason** — `validateTree` already owns uniqueness because everything below it resolves nodes by id. A blank id fails that test harder: it is not an id that is taken, it is not an id.

**There is a reason to state it here that duplicate ids do not have.** `validateTree`'s one existing domain rule, `duplicate_chat_target`, is justified on the ground that the **table** also enforces it, so the model should refuse first rather than let the client meet a raw `23505`. A blank id is the opposite case: the table does **not** enforce it — `text NOT NULL` is satisfied by `''` — and the **read** does. A rule enforced only on the way out is not a gate, it is an alarm, and it goes off after the row is already stored, on a read path that rejects the whole set rather than filtering (correctly), with the read being the only way in.

**Placement:** after the node cap, before uniqueness. Two blank ids should report the shape fault, not "duplicate".

**Cost:** two string comparisons per node in a function that is already the most expensive thing on the write path. Below the noise.

**The one asymmetry I created on purpose.** `validateTree` uses `trim()`; `workspace-node-rows.ts` keeps `z.string().min(1)`, which accepts `'   '`. So a whitespace-only id would be **readable but unwritable**. That is the safe direction, and I left it deliberately: tightening the parse would make an existing such row *unreadable*, which is the exact failure mode this finding is about. A workspace that loads and refuses writes is recoverable; one that cannot load is not. Nothing can create such a row now, on either side.

---

## Finding 5, the O(n²) validator — **accepted, not fixed here**

Re-measured on this machine, current code (two O(n) passes heavier than the reviewed version):

| shape | nodes | `validateTree` |
|---|---|---|
| flat, unbound | 2048 (`MAX_NODES`) | 69.6 ms |
| flat, all chat-bound | 2048 | 61.8 ms |
| balanced binary split tree | 511 | 7.7 ms |

The review measured 217 ms for the flat worst case; I get ~70 ms on this hardware. Different machine, same shape and same conclusion — `childrenOf` filters and sorts the entire list and is called once per node, so it is quadratic in list length by construction, not by measurement.

**Why I am not fixing it on this branch.** The decisive difference is reversibility. The two HIGHs are cheap now and expensive after a cutover because they put data in a state with no read path back; a performance change has no data at risk and can be made at any time, including after Phase 3 ships, with no migration and no recovery story. It is the one finding in this report where "later" costs nothing.

Against that: the fix rewrites the traversal of the one function whose **violation order is load-bearing** — the module docblock says so, and `accept()`'s docblock cites it as the reason not to extend `validateTree` lightly. Indexing children by `parentId` once collapses four passes plus the reachability walk to O(n), which is a rewrite of `siblingGroups`, `degenerate_split`, `pane_has_children`, the depth walk and `descendantsOf`'s use — five call sites, each of which currently establishes something the next one assumes. Riding that on a branch whose job is two unrecoverable-state defects makes both harder to review, and a subtle reordering introduced there is a correctness bug in the gate itself.

The additions I did make preserve relative order by construction: `blank_id` is a new check placed at a chosen point, and the finiteness sweep moved to a strictly earlier position that the tests pin.

**And the number is not urgent.** 70 ms is the worst case at 2048 nodes, roughly 2× the largest shape production can already contain (a migrated 64 × 16 grid, ~1089 nodes) and ~4× a realistic one, where it is 8 ms. There are no writers today, so there is no lock being held for it today.

**Recorded, with the fix shape:** index children by `parentId` once at the top of `validateTree` and thread the index through all five walks; it is a self-contained change that deserves its own diff and its own reading of the order argument.

---

## Finding 6, the round-trip claim — **corrected, not made true**

First I confirmed the divergence is real, on the current code:

```
algebra : {"nodeType":"pane","id":"a","parentId":"root-1","position":0,"target":{…},"fraction":0.3}
rehydr  : {"nodeType":"pane","id":"a","parentId":"root-1","position":0,"fraction":0.3,"target":{…}}
bytes equal: false
```

I could have made it true. There is exactly one appender: `withFraction` adds `fraction` by spread so it lands after `target`, while the row transform emits it before. Every other construction site (`create`'s literal, `reseat`'s `{...member, position}`, `bind`'s `{...node, target}`, `stageContainer`'s two) writes keys that already exist, so order is preserved. Rebuilding `withFraction` in canonical order is about eight lines.

**I did not, and the reason is that byte identity is a promise this module cannot keep no matter how carefully it is written.** The algebra passes through nodes it did not build — the wire's `put` carries caller-assembled nodes with whatever key order the caller had — so the strongest true form would be "byte-identical for nodes this algebra produced from canonical input". A qualified guarantee that reads as an unqualified one is how the current false claim came to be written in the first place. And nothing would stop the next `{...node, x}` from re-breaking it silently, because no test can range over construction sites that do not exist yet.

**What the claim says now**, in `workspace-node-rows.ts` and echoed at `PaneNode.fraction`/`SplitNode.fraction` and at `withFraction`:

- The guarantee is **structural identity including which keys are present** — `{}` vs `{fraction: null}` vs `{fraction: undefined}` are three different things and the round trip preserves which one you had. That is exactly what the property suite pins with `toStrictEqual`, and it is the property the stated failure mode actually needs.
- **Key order is not part of it**, with the cause named.
- **Therefore the change test must never be a `JSON.stringify` comparison** — and the docblock names the idiom a Phase-3 store would reach for, `workspace-layout-verbs.ts:152-155`, which documents the existing store's change detection as exactly that. A store reusing it on nodes sees every write as a change: no idempotence, a rev bump per retry, a re-broadcast per unrelated edit. Change detection over nodes compares fields; the algebra's own `sameNode` is the shape of it.

That warning is worth more than canonical key order, and unlike key order it survives every future construction site.

**I also closed the coverage gap underneath the claim.** The property suite round-trips only nodes the **row parse** built, so both sides of every comparison come from one producer — it could never have caught a divergence between the two. Two new tests round-trip nodes **the algebra** built, sized and unsized, which is the pair the claim is about (F6 kills them).

---

## Findings 7, 8, 9 and the `not_detachable` nit — left, and why

**#7 — eviction at exactly `MAX_NODES` is refused though it nets zero.** Left. It is not a one-liner: `open`'s eviction path creates the newcomer **before** moving the displaced pane out, deliberately and with the reason written down ("so no group momentarily has a hole"), and `create` validates that transient tree. Fixing it means either reordering a sequence whose order is load-bearing for a different reason, or teaching `compile` that an intermediate need not validate — which would dissolve the property that every step is an accepted operation. Reachable only by deliberately filling a workspace to 2048 nodes. It deserves its own change with its own argument about which invariant gives way.

**#8 — `openConversation` refuses a parked target; `replaceConversation` silently un-parks one.** Left. This is a **product decision**, not a defect: one of the two commands is wrong and the code does not say which, and I am not the right one to pick. `openConversation`'s refusal is argued in the source ("bringing a parked node back is a `move`, and the caller names it"); `replaceConversation` does that move on the caller's behalf without comment. Whichever way it goes, it changes what a user sees. Flagging for a decision, not silently harmonising.

**#9 — a parked pane keeps a stale `fraction` through the row round-trip.** Left, deliberately. It is dead data the algebra always strips on the way back into a grid (`reseat` maps the parked group to `null`, verified in the review), and the validator's acceptance of it is **pinned by an existing test with a stated rationale** — *"should ignore the fractions a parked pane kept from the container it left"* — because judging them would make every detach rewrite them. Finding #3's fix does apply to them: a parked pane may keep a stale share, but no longer a non-finite one. That is the part that mattered.

**The `not_detachable` → `not_parkable` nit.** Left. It is a rename of a public code across the algebra, the commands' `CommandCode`, and the tests, on a branch whose diff should be readable as "the two HIGHs and their arguments". The observation is right — `move` is refusing "a split has no target, so a parked one would be garbage", and the model's word for that is parked.

**Changelog:** nothing user-visible. Every change here is to a model no writer has reached yet.

---

## What is in the diff

| File | Change |
|---|---|
| `workspace-node-algebra.ts` | `applyNodeWrite` put-before-drop + docblock; `NodeWrite` writer contract; `invalid_id`; `create` refuses blank node id and blank target id; `bind`'s false comment corrected; `accept`'s false docblock corrected; `withFraction` key-order note |
| `workspace-node-validate.ts` | `blank_id` code + check (node ids and target ids); finiteness sweep hoisted out of the group loop; depth walk's cast removed; module docblock's violation order updated |
| `workspace-node-commands.ts` | `open`'s compensating blank-target guard removed, with the reason recorded in its place |
| `workspace-node-rows.ts` | the byte-identity claim corrected to structural identity, with the `JSON.stringify` hazard named |
| `workspace-node.ts` | the same claim corrected at `SplitNode.fraction` |
| `packages/db/src/schema/agent-workspace-nodes.ts` | the FK's truncated live name recorded; the cascade's connection to write ordering recorded |
| `__tests__/workspace-node-cascade.test.ts` | **new** — `applyNodeWrite` under the table's cascade, 3 tests |
| `__tests__/workspace-node-algebra.test.ts` | 2 tests; one stale comment corrected |
| `__tests__/workspace-node-validate.test.ts` | 4 tests |
| `__tests__/workspace-node-commands.test.ts` | 2 tests; the existing blank-target test renamed to name its path |
| `__tests__/workspace-node-rows.test.ts` | 2 tests — the algebra's nodes ⟷ rows |

No migration change: the schema edit is a comment, and generates no SQL.

Probe files deleted, scratch database dropped, tree clean.

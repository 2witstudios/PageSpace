# One removal, and no parentless panes

Branch `pu/one-removal`, based on `pu/workspace-node-model` (`28a3bbab4`).

The node-tree cutover exists to delete one bug class — **membership and layout stored as two
structures, reconciled by convention** — and it rebuilt that class twice while removing it, once at
each end of the tree. This corrects both, and the two corrections turn out to be the same
correction: *there is one place a node can be, and one way for it to stop being there.*

---

## 1. What changed, per layer

### `workspace-node.ts` — the model

`PaneNode.parentId` is a `string`. `SplitNode.parentId` already was. `RootNode` keeps `null`, and it
keeps it because it is the root — which `nodeType` already says, which is why `rootOf` still finds
the root by type rather than by the null.

`detachedOf` is **deleted**. It answered "which panes are in the workspace but nowhere in it", a
question that could only be asked while a pane could be in one and not the other.

### `workspace-node-validate.ts` — the validator

- New violation code **`null_parent`**: a non-root node whose `parentId` is null. It has its own
  code rather than folding into `dangling_parent` (a pointer that resolves to nothing) or
  `unreachable` (which describes the *consequence*, not the fault). Reported **before** both, so one
  bad tree yields the more primitive of the two faults.
- The check is unspellable in memory and stated anyway. That is the point: this function's input is
  also nine mostly-nullable columns, a wire payload, and — during the migration window — a node set
  a client assembled. TypeScript narrows `parentId` to `string` after excluding the root, so the
  comparison would be dead code and the compiler would say so; `parentPointerOf` widens it back to
  the type *storage* has. That indirection is deliberate and documented at the function.
- **The empty list is now valid.** This is the top half of the correction arriving in the validator:
  `destroy(rootId)` leaves no nodes, and a validator that called that `no_root` would make the tree
  operation that ends a session an operation the write path refuses. A *non-empty* list with no root
  is still `no_root`.
- Reachability lost its exemption; the parked sibling group is gone from `siblingGroups`; the
  fraction and ordering passes no longer skip a "not a container" group.

### `workspace-node-algebra.ts` — the five operations

- `CreateInput.parentId` and `MoveInput.parentId` are `string`. `create` cannot mint a parentless
  node; `move` has no destination outside the tree.
- `not_detachable` is deleted (it existed only to refuse parking a split).
- **`destroy` accepts the root.** `destroy(paneId)` takes the pane; `destroy(rootId)` takes the
  session, subtree and all. Root-destroy is special-cased only in that there is no parent group to
  reseat: it returns whatever did *not* descend from the root, which in a valid tree is nothing — so
  a set holding an unreachable straggler is REFUSED as `no_root` rather than swept clean. Destroy
  removes what it names, at the top of the tree exactly as at the bottom.
- `root_immutable` survives on `move`, `bind`, `resize`. Those say the operation is meaningless on
  the root, which is not a second mechanism.
- `resize`'s `not_sizable`-for-a-parked-pane branch is gone (unspellable); the lone-member branch
  stays.

### `workspace-node-commands.ts` — the commands

- `closePane` is a **`destroy`**. It refuses the root (`root_immutable`) and a split (`not_a_pane`)
  — see §3 for why that is not a second removal.
- `replaceConversation` destroys the pane it displaces instead of parking it.
- `open`'s placement policy destroys the pane it evicts; its `already_bound` refusal for
  "a parked node already holds this target" is gone — a holder is necessarily on screen, so
  "already showing it" is the whole answer and the correct write is no write.
- `CommandCode` loses `detached_pane` and is now an alias of `NodeOperationCode`. `split`'s
  parked-pane refusal and `parkedSlot` are deleted. `GridPane`/`isGridPane` collapse into `PaneNode`.

### `workspace-node-rows.ts` / `workspace-node-wire.ts` — the boundaries

Both pane members take `parentId: z.string().min(1)`. `nodeFromRow` throws on a non-root row with a
null parent; `nodesFromRows` rejects the whole set (unchanged, and for its stated reason: dropping
the row would be indistinguishable from the user having closed the pane — the very confusion this
change ends). `RenderTree.detached` is deleted; such a node lands in `orphaned`, which is what
`orphaned` is for.

### `workspace-membership.ts` — membership

Four acts became two. `dismiss` (a `move` out of the grid) and `readmit` (the `move` back) existed
*only* because a node could be parked; `expel` is the one removal addressed by target, and it now
answers `not_a_member` rather than silently succeeding, because the caller that asks on a user's
behalf is owed the truth and the caller behind an authorized history-delete says so at its own call
site. `admit` lost its `attach` flag — see §5 — and gained a `place()` dispatch so terminals and
pages get the same policy chat already had (it used to answer `invalid_target` for them, because
every other kind arrived parked). `last_member` / `requireSurvivor` are deleted; see §2.

### The write path

`decideNodeWrite` needed no structural change — but its behaviour changed where it matters:
dropping the root and its subtree is now an accepted write producing `nodes: []`. `commitUnderLock`
gained a `seed` flag, `false` for exactly one caller (§4).

### The backfill

**Unplaced members are PLACED, not detached.** Conversations and shells with no legacy pane row are
seated under the root, after the columns, continuing the root's own `position` run rather than
starting a second 0-based one beside it. `WorkspaceCensus.detachedOut` → `seatedOut`.

One real consequence, found by making the change and handled rather than papered over: a seated
member carries no stored share, and a container is sized or unsized and never both — so the root's
shares are settled over **columns + seated members together**, which reads the group as unsized
wholesale whenever a member has to be seated. A workspace with an unplaced member therefore migrates
with an evenly divided root and a `fractions_read_as_unsized` note, instead of a `fraction_mixed`
refusal. That is `settleGroupShares`' existing rule applied to a group that got one member wider,
not a new one.

### The route and the client

- The sidebar has no detached section, no dimmed "(not open)" row, and one label per row.
  `MemberPlacement` is `'grid' | 'unplaced'`; `conversationPlacement`'s `'parked'` case is gone.
- `showNode` no longer un-parks; `openTarget`'s three cases become two.
- `SessionConversationEntry.attached` and `ChatMembershipRow.attached` are deleted — both were
  `parentId IS NOT NULL`, which is now always true. `isClosed` for a worker verb is the *absence* of
  a membership row.
- `endSession` composes lifecycle + `destroy(root)`; see §4.

---

## 2. Refusal enumeration — what each layer must now refuse, and now permit

### Newly PERMITTED

| Layer | Was refused | Now |
|---|---|---|
| `destroy` | `root_immutable` on the root | takes the root and its whole subtree |
| `validateTree` | `no_root` on `[]` | `[]` is valid — it is what a root-destroy leaves |
| `decideNodeWrite` | `invalid/no_root` for a payload dropping everything | accepted; `nodes: []`, `changed: true` |
| `open` | `already_bound` when a PARKED node held the target | empty write (it is on screen) |
| `split` | `detached_pane` on a parked pane | accepted — every pane has a container |
| `replaceConversation` | `detached_pane` on a parked pane | unreachable; the case does not exist |
| `admit` | `invalid_target` for a non-chat placement | places terminals and pages by the same policy |
| `expel` | `last_member` on a workspace's last conversation | accepted |
| history-delete routes | 409 `last_conversation` | 200, the thread is deleted |

### Newly REFUSED

| Layer | Refusal | Why |
|---|---|---|
| `validateTree` | **`null_parent`** | a non-root node that is nowhere; the invisible half of the failure |
| `nodeFromRow` | throws on a non-root row with a null parent | a row can carry what the type cannot |
| wire schema | 400 on a pane with `parentId: null` | a client still holding the detached model |
| `create` / `move` | type-level — `parentId` is a `string` | detached creation and move-to-nowhere are unspellable |
| `closePane` | `root_immutable`, `not_a_pane` | see §3 |
| `move_pane` (agent tool) | `toParentId` is required | `null` was the parked destination |
| `expel` | `not_a_member` for a thread the workspace does not hold | it used to write nothing silently |
| `isAdoptableTree` (client) | refuses a broadcast carrying a parentless pane | it used to adopt one as truth |

### The three refusals I was asked to re-derive

- **`last_conversation` / `last_member` / `requireSurvivor` — DELETED.** They enforced "a workspace
  is never empty", an invariant with teeth only while a two-level grid could not represent zero
  panes and while "the last one closed" was the inference that ended a session. Neither holds. A
  guard defending a state nobody can reach only ever fires on legitimate work — here, on deleting
  the history of the one thread a workspace happened to be left with.
- **`session_full` — KEPT, untouched.** It is a *ceiling*, not a floor. Nothing about emptiness
  ceasing to mean anything touches it. (It did change *behaviour* indirectly: closing a thread now
  frees its slot and reopening consumes one, because a closed thread is a member of nothing. That is
  the honest reading, and it is pinned by an integration test.)
- **`no_root` — KEPT, narrowed.** It now means "rows exist and their root does not", which is a real
  fault. It stopped meaning "empty", which is a resting state.

---

## 3. Two judgement calls I made that the prompt did not name

**`closePane` refuses the root and refuses a split.** `destroy` takes whatever it is pointed at —
that is the correction. `closePane` is a *command*: a gesture with a name, and the name states its
subject. Handed the root it would end a session nobody asked to end, from a client bug or a
mis-aimed agent call. Refusing a category error at the layer that owns the vocabulary is not a
second removal; the removal underneath is still one function with one meaning. The same reasoning
put the agent-facing `close_pane` through the command rather than straight to the algebra.

**`expel` refuses `not_a_member` instead of writing nothing.** The old pair (`dismiss` refuses,
`expel` is silent) differed *only* in this answer, which is two functions for one act. One function
gives the true answer and the history-delete caller — which is behind an already-authorized
deletion, where "it was not there" is the state it asked for — maps it to success at its own call
site.

---

## 4. `destroy(root)` vs the lifecycle — and the `endedAt` question

### The correction you sent, and why it was right

I was going to build a two-phase commit. Your correction landed before I did, and the code agrees
with it: a Sprite is keyed off the workspace id (`workspace-sprite-key.ts`), `endAgentSession`
stamps `teardownRequestedAt` **before** it kills, and `sprite-orphan-reconcile.ts` reaps anything
carrying that stamp without a confirmed kill. The orphan is *findable*, so the leak I was defending
against is already solved by reconciliation-by-id. Threading an executor through the teardown to
share the tree write's transaction would have put a network call to the sandbox provider inside the
workspace's advisory lock — a slow teardown would then block every layout write for that workspace,
which is strictly worse than the orphan it prevents.

So: **`destroy(root)` is a tree operation and stays one.** `destroyWorkspaceTree` writes the tree in
its own transaction; teardown is requested by id and is idempotent; the reconciler covers the gap.

### What replaced transactionality: an ORDER

`endSession` runs **lifecycle first, tree second**, and that order is the property now under test
(the mutation table's #4). The reasoning is which interrupted state is survivable:

- *Lifecycle → tree.* A crash between leaves an ended row and a tree that outlived it. Visible,
  harmless, cleared by re-issuing the DELETE (`endAgentSession` answers `already_ended` as a no-op
  and the destroy then runs). From `endAgentSession`'s first durable write the reconciler owns the
  VM.
- *Tree → lifecycle.* A crash between leaves the tree gone, the row un-stamped, and a live Sprite
  with **no teardown request against it** — which the reconciler will not touch, because an explicit
  recorded intent is what licenses it to destroy anything. It bills until a human notices. That is
  the one failure that costs money and that no background process can see.

The tree write is best-effort by design: the session is ended once the row says so, and reporting a
teardown failure because some layout rows outlived it would tell the caller the compute is still
running when it is not.

### Stamp `endedAt`, or delete the row?

**Stamp.** I agree with you, and after your second message the reasoning is a different one from the
one I would have given first — so here it is on the footing you asked for.

Your principle is right: the sandbox belongs in a `workspace_sandboxes` row FK'd to the workspace,
and the eight nullable sprite/billing columns on `agent_workspaces` are the same "nullable columns
for a thing that may not exist" smell this epic used to justify keeping `agent_workspaces` out of
the node row. Grant that extraction. `agent_workspaces` is then close to a pure identity +
lifecycle row, and "stamp or delete" stops being about tidying sandbox fields. It becomes a
retention question, and it still answers *stamp*, for three reasons that survive the extraction:

1. **The row is re-provisionable identity, and the identity is derived from the id.** `spriteKey` is
   a function of the workspace id. Delete the row and a later `ensure` cannot re-provision *the same
   workspace* — it can only mint a new one. "Ended" and "gone" are different states for a user who
   comes back, and only one of them is what "end session" means.
2. **Billing and audit are about a period, not a present.** Storage is billed on a watermark
   (`storageLastBilledAt`) and the audit trail records `end_session` against `resourceId:
   workspaceId`. A deleted row makes the last billing interval unreconcilable and every prior audit
   entry point at nothing. Retention of a settled financial period is not something a UI action
   should be able to end.
3. **Deleting cascades into things nobody asked to delete.** `agent_workspace_nodes.rootId` and
   `agent_workspace_node_revs.rootId` are `ON DELETE cascade` (fine — the tree is going anyway), but
   `conversations.workspaceId` is `ON DELETE set null`, and the AFTER-DELETE reclaim trigger would
   fire a sandbox pointer into the outbox for a Sprite the ordinary path has already killed. Delete
   is the strictly larger blast radius for no gain.

The counter-argument for delete is that a stamped row is a tombstone the tree no longer describes —
"a session that looks open and cannot work". It does not hold: after `destroy(root)` the row carries
`endedAt`, which is exactly what says it is not open, and the tree is genuinely empty rather than
stale. The one thing to watch is §7's finding about re-seeding.

### The sandbox extraction: not cheap from here — do not ride it along

`agent_workspaces` has ~10 sandbox/billing columns with CAS writes against them in
`agent-workspace-sprite.ts`, `agent-workspaces-store.ts`, `sandbox-storage-*`, the orphan reconciler
(which selects on `teardownRequestedAt IS NOT NULL AND spriteTornDownAt IS NULL`), the AFTER-DELETE
reclaim trigger, and the tenant-export column registry. The extraction is a migration plus a rewrite
of every CAS to target a second table plus a decision about what happens to a workspace whose
sandbox row does not exist yet (today: `sandboxId IS NULL`). It is a clean change and I would make
it — as its own PR. Riding it along here would double a diff that already touches 65 files.

---

## 5. `attach` is gone, and why the trap it dodged is not reachable

`AdmitInput.attach` chose between a placed node and a parked one. `false` was the default, and its
stated reason was real: the pane picker mints its own unbound pane and binds it after the POST
returns, so an *attached* admission would place a SECOND pane for one thread.

That trap is not reachable, because the placement policy an admission runs is `preferSplit: true` —
**it fills an unbound pane before it will split**. The picker's waiting pane *is* the unbound one, so
the admission lands in it. The client's own follow-up then asks for a state the node is already in.

For shells the old behaviour was in fact the buggier one: `spawnShell` parked a node bound to the
shell *and* the client bound its own pane to the same shell, so two nodes held one terminal
(terminals carry no uniqueness index, so nothing complained). One of them was invisible. That is
fixed by the same collapse.

**Residual risk, stated rather than hidden.** With two or more unbound panes the server fills the
first in render order, which may not be the one the user clicked. The fix is to pass the waiting
node id through as `activeNodeId` (which `admit` already accepts) from the conversations and shells
routes. I did not build it: it is a wire change on two routes for an edge case that is cosmetic for
chat (the client's own `openConversation` then finds and focuses the node) and now correct for
shells. Recommended as a small follow-up.

---

## 6. Mutation table

Each mutation was applied to the source, the suite run, the failures recorded, and the source
restored from a byte-for-byte backup.

| # | Mutation | Expected to catch | Result |
|---|---|---|---|
| 1 | `destroy` refuses the root again (`root_immutable`) | one removal | **4 red** — incl. `destroy > should take the WHOLE SESSION when pointed at the root` |
| 2 | `null_parent` check disabled (`if (false && …)`) | the validator's new code | **6 red** — incl. `should REFUSE a pane with no parent, and name it null_parent rather than unreachable` |
| 3 | `destroyWorkspaceTree` passes `seed: true` | the root being re-created by the write that ends the session | **2 red** — `does NOT seed a root in order to destroy it`, `is idempotent` |
| 4 | `endSession` reordered: tree first, then lifecycle | the money-losing interrupted state (§4) | **2 red** — `settles the ROW first`, `does NOT destroy the tree when the lifecycle end failed` |
| 5 | pane row schema `parentId` back to `.nullable()` | the row parse | **2 red** — `nodeFromRow REFUSES a non-root row whose parentId is null` |
| 6 | `closePane` back to a move-to-root instead of a destroy | closing is a destroy | **5 red** — incl. `should leave an EMPTY tree when the last pane closes, and NOT end the session` |

Mutation 4 replaces the prompt's original "break the teardown/destroy transactionality" check, which
your correction retired along with the transactionality itself. The property that actually protects
against a leaked VM is the composition order, so that is what is mutated.

---

## 7. Unanticipated findings

### Introduced by this change, and handled

1. **`validateTree` rejecting `[]` would have blocked the whole correction.** `destroy(root)`
   produces an empty node set, which the algebra's own `accept()` and the server's `decideNodeWrite`
   both validate. Without making `[]` valid, the operation that ends a session is an operation the
   write path refuses — the top-half correction is not reachable from the validator alone.
2. **Seeding on the destroy path re-creates the root.** `commitUnderLock` mints a root for any
   command that needs one to place into. On a root-destroy the seed lands in `put` and its id in
   `drop`, which the decision resolves as *put wins* — so ending a session with no tree would have
   **created** one. Hence the `seed` flag; mutation 3 pins it.
3. **Agents lost the ability to close a pane.** `move_pane(toParentId: null)` was their only way to
   take one off the grid. Removing the null destination without a replacement would have left them
   able to rearrange a layout and unable to close anything in it, so I added the `close_pane` tool
   (a `LayoutCommandInput` variant compiling to the `closePane` command). This is a frozen-wire
   contract change: the pin, the fourteen-name assertion, the `WORKSPACE_TOOL_COUNT` registry, the
   renderer-coverage ledger and the evidence manifest are all updated in the same commit.
4. **A behaviour trade worth naming.** The old `dismiss` argument had a real point: the global
   chat-target unique index makes a binding write-once only while the row exists, and a destroy frees
   it — so a thread closed out of one workspace can afterwards be admitted into another. Under the
   parked model that was called "a rebind reached by clicking close" and refused. It is now the
   honest reading: a thread whose node is gone is a member of *no* workspace. History is untouched.
   The changelog says this in the user's words, replacing the entry the previous commit wrote.

### Pre-existing on `pu/workspace-node-model`, found because the suites finally ran

The shared local test Postgres (`pagespace-postgres-test`, port 5433) was **empty — 0 tables — with
a surviving `drizzle` journal**, so every DB-backed suite had been skipping rather than running. I
reset and re-migrated it (132 tables). That is what surfaced the following, each verified against
`HEAD` rather than assumed:

5. **`listSessionConversationsBulk` was broken outright.** Its subquery selected
   `agent_workspace_nodes.id` and `conversations.id`, both of which Drizzle aliases to `"id"`, so
   the outer select failed with `column reference "id" is ambiguous` (42702). The sessions listing
   returned nothing for *every* caller. Fixed with explicit `node_id` / `conversation_id` aliases.
6. **Four suites asserted `conversations.workspaceId`**, a column nothing writes since membership
   moved to the tree (`conversation-repository.ts` inserts `workspaceId: null` unconditionally) —
   so they compared two nulls and passed for no reason. Repointed at the node table.
7. **The worker-spawn emit tests waited for a `conversation:updated` frame** carrying
   `{workspaceId, closedInWorkspaceAt}` — both columns retired — so they timed out at 5 s. The
   binding announces itself as `workspace:nodes-updated` to two rooms; the tests now assert that.
8. **`applyWorkspaceMembershipWrite`'s `bound_elsewhere` translation was dead code.** Its local
   detector checks only the top-level error, while `commitUnderLock`'s backstop matches the same
   index *and unwraps the driver's `cause` chain* — so the backstop always won and the refusal had
   not fired since Drizzle began wrapping query errors. Removed rather than duplicated; the
   membership caller reads `conflict` and gives it its own name.
9. **`knip:check` was red.** Commit `7e8097c65` removed the `ConversationEventName` union that was
   the only consumer of `ConversationContentEventName` / `ConversationDirectoryEventName`, leaving
   two dead exports. Removed (a consumer derives either in one line from the const map).
10. **The evidence manifest had a dangling citation** — `create-conversation-in-workspace.test.ts`
    declares no test named "a title travels to the creator AT BIRTH…" at `HEAD` either. Repointed.

### Pre-existing, and NOT fixed — the one gate still red

11. **`scripts/__tests__/tenant-export-columns.test.ts` fails**: `agent_workspace_nodes` and
    `agent_workspace_node_revs` have no carry-or-exclude decision. Red at `HEAD`
    (neither table appears in `migration-types.ts` or `tenant-export-columns.ts`).

    I did not close it, and I did not want to close it the cheap way. **This correction changes the
    right answer.** Under the parked model you could argue the tree was ergonomics and exclude it as
    `agent_workspace_panes` was excluded. You cannot now: the tree *is* the membership, so excluding
    `agent_workspace_nodes` would migrate a tenant's sessions and conversations with **no
    membership** — every session showing an empty tree and no threads listed, which is precisely the
    ghost this epic deletes. Writing an exclusion reason I do not believe, to turn a ratchet green,
    is the paper-over that ratchet exists to prevent.

    The work, precisely: `agent_workspace_node_revs` **exclude** (same reasoning as
    `agent_workspace_layout_revs` — with no tree carried a non-zero rev makes the tenant reject its
    own first write as stale). `agent_workspace_nodes` **carry**, which needs an entry in
    `TABLE_IMPORT_ORDER` after `agent_workspaces`, a `TENANT_EXPORT_COLUMNS` spec, an export query
    and `buildInsert` in `tenant-export.ts`, and a `tenant-validate.ts` query. Two subtleties make it
    more than mechanical and are why it wants its own change: the PK is compound `(rootId, id)` so
    the validator's `SELECT id` shape does not apply, and `targetId` is polymorphic with no FK — the
    exact reason `agent_workspace_panes` was excluded — so a node bound to a page outside the bundle
    needs a decision (drop the binding and carry an unbound pane, or drop the node).

### Not fixed, environmental

12. `packages/lib/src/compliance/erasure/__tests__/gdpr-eraser.integration.test.ts` needs
    `ADMIN_DATABASE_URL` pointed at a **separate** database. Not set locally, and deliberately not
    pointed at the shared test DB (those suites `DROP SCHEMA public`).
13. `apps/web/src/app/api/version/__tests__/version-sdk-contract.test.ts` cannot resolve
    `@pagespace/sdk` until that package's dist exists. Passes after
    `bun run --filter @pagespace/sdk build`; verified.

---

## 8. Gate table

Run in this worktree with `DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test`.

| Gate | Result |
|---|---|
| `@pagespace/lib` — `src/agent-workspaces` | **695 pass** (22 files) |
| `@pagespace/lib` — full | **9339 pass**; 1 suite needs `ADMIN_DATABASE_URL` (#12) |
| `web` — `src/lib/agent-workspaces` | **209 pass** |
| `web` — `src/stores/agent-workspace` | **92 pass** |
| `web` — `src/components/layout/left-sidebar` | **94 pass** |
| `web` — `src/components/agents/panes` | **109 pass** |
| `web` — full | **16795 pass**, 0 failed tests; 1 file = #13 |
| `@pagespace/db` | **636 pass** (42 files) |
| `realtime` | **961 pass** (25 files) |
| `scripts` | 1 suite red = #11 (pre-existing) |
| `bun run typecheck` | **17/17** |
| `bun run lint` | **15/15** |
| `bun run knip:check` | **green** (4 issues, all baseline) |
| security-audit route coverage | **4 pass** |

New suite: `packages/lib/src/agent-workspaces/__tests__/workspace-one-removal.test.ts` (22 tests) —
the two corrections stated as one argument, written before the source changed and red on all ten of
its new-behaviour assertions at that point. Also new:
`apps/web/src/lib/agent-workspaces/__tests__/end-session-composition.test.ts` (5).

---

## 9. What I did not touch

- **No migration.** The `agent_workspace_nodes` schema *comments* are corrected (several described
  the detached case as legal, and one said the converse CHECK was "deliberately absent" for that
  reason). The CHECK itself — `nodeType = 'root' OR parentId IS NOT NULL` — would state the new
  invariant in the table and I recommend it, but it needs its own migration and this file's own rule
  is that row/type agreement belongs to the parse. Noted in the schema, at the constraint.
- **No `workspace_sandboxes` extraction** (§4).
- **No compensating "unplaced" list anywhere.** #2373 cannot recur under this model for the reason
  the model gives: there are no unplaced members, so a thread that is in a workspace is in its tree.

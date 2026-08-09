# pu-fix-xws — a cross-workspace chat bind is a typed refusal, not a 502

**Branch:** `pu/fix-xws`, based on `pu/workspace-node-model` @ `bea764908`.
**Closes:** Sanity verdict 1, Finding 2 (`.pu-reports/sanity-verdict-1.md` on `pu/wnt-sanity1`).
No PR opened, nothing merged.

---

## What was wrong

`agent_workspace_nodes_chat_target_idx` is `UNIQUE (targetId) WHERE targetKind = 'chat'`. The key
is `targetId` **alone**. It is the only constraint on the node table whose scope is the whole table
— every other one (compound PK, composite self-FK, single-root index) carries `rootId`.

`validateTree` is handed **one workspace's** node list. For a `rootId`-scoped key that list is the
whole domain, which is why the validator settles every other constraint. For this one it is not,
and `authorize-pane-scope.ts:177-180` actively waves the cross-workspace case through when the
caller owns the conversation. So the write reached Postgres, the index refused it, and
`route.ts` answered **502 `{error: 'Could not apply the layout write'}`** — a body with no `rev`
and no `nodes`, which leaves an optimistically-applied client with nothing to rebase on and a
phantom pane on screen until an unrelated poll corrects it.

Nothing was ever corrupted: the transaction aborts. The damage was the error surface.

---

## What was done

### 1. A pre-flight, at the write path where the table is

New pure module `packages/lib/src/agent-workspaces/workspace-node-chat-binding.ts` —
`conflictingChatTargets`, `isChatTargetUniqueViolation`, and the two detail wordings.

New store query `readChatTargetHolders` in
`packages/lib/src/services/agent-workspaces/workspace-node-store.ts` — the one query in that module
deliberately unscoped by `rootId`, mirroring `loadClaimedChatTargets` in
`scripts/backfill-agent-workspace-nodes.ts:182`, which asks the identical question of the identical
index for historical rows. It returns the *holder*, not a boolean, so "held here" vs "held
elsewhere" is discriminated in a readable line rather than inside a `WHERE` clause.

Wired into `commitUnderLock` (`apps/web/src/lib/agent-workspaces/workspace-node-runtime.ts`),
**after** the ACL gate. The order is load-bearing: reversed, the pre-flight is an existence oracle —
"that conversation is already shown somewhere" about a conversation id the caller has no authority
over. The 403 has to win, and a test pins that the lookup does not even run when the gate denies.

It asks only about **chat** targets (the index is predicated on the kind; one page in two panes is
legitimate) and only about targets the write **introduces** (a resize of a bound pane costs no
table-wide query).

### 2. The backstop, because the pre-flight has a TOCTOU window no lock closes

`withWorkspaceLayoutLock` is **per workspace**, and the two writers racing for one conversation are
in two different workspaces by definition. A pre-flight alone converts a rare 502 into a rarer 502.

`commitUnderLock` now catches out of the transaction and maps
`isChatTargetUniqueViolation(error)` to the same typed refusal. Matched by **constraint name**, not
by the driver's message text, and walking drizzle's `.cause` chain. Deliberately **not** widened to
all `23505`: the single-root index failing is a structurally broken workspace, and reporting that as
"the conversation is shown elsewhere" would send a client rebasing over an unrelated fault.

Letting the error escape the transaction (rather than catching inside it) means drizzle rolls back
cleanly and the advisory lock — `pg_advisory_xact_lock` — releases with it. The refusal body is then
read **fresh**, which is also the newest base the loser can rebase onto.

### 3. The refusal shape — the actual point of the fix

`ApplyWorkspaceNodeWriteResult` gains `{status: 'conflict', code: 'target_already_shown', detail,
snapshot}`. `code` reuses the algebra's existing vocabulary (`workspace-node-algebra.ts:111`)
rather than coining a second word for one fault.

The route answers **409** carrying `{rev, nodes, targets, code, detail}` — the stale 409 body plus
two keys. New wire type `WorkspaceNodeConflictResponse`. A client that already handles 409 handles
this one by ignoring two extra keys; a stale 409 carries no `code`, which is how the two are told
apart without a second status. The snapshot goes through the **same** per-viewer target resolution
as `stale`, so the 409 never says more or less than a GET would.

`applyLayoutCommandForWorkspace` (the agent-tool path) now names `conflict` explicitly. Without
that it would have fallen through to the branch that reports `stale`, telling an agent to retry a
write that can never succeed.

### 4. The false premise, corrected

`workspace-node-validate.ts` justified the per-workspace check with "a conversation belongs to
exactly one workspace, so one conversation → one workspace → at most one pane." The branch's own
backfill contradicts it (`workspace-node-backfill.ts:122-126`: "a pane naming a conversation in
another session is reachable today"), which is exactly why that migration arbitrates chat claims
globally. A pane's target is free-form in the payload and is held to `conversations.workspaceId` by
nothing.

The check's comment now says what it actually covers (the within-set half), names the layer that
covers the rest, states why the missing half is *not* unreachable, and says **do not close it by
giving this function IO** — it is pure and it runs on the client. The module docblock and the
schema's own constraint-6 comment (which repeated the same derivation) were corrected to match.

---

## Enumeration — what else the write path lets through that the table refuses

Constraint by constraint on `agent_workspace_nodes`:

| Constraint | Covered by | Verdict |
|---|---|---|
| PK `(rootId, id)` | `validateTree` `duplicate_id`; the upsert's own conflict target | closed |
| self-FK `(rootId,parentId)→(rootId,id)` | `validateTree` `dangling_parent`; DB holds exactly `next` at statement end | closed |
| FK `rootId → agent_workspaces` | route's `checkSessionAccess` | closed |
| `..._one_root_idx` | `validateTree` `no_root` / `multiple_roots` | **closed — see below** |
| `..._root_no_parent_chk` | unspellable: `RootNode.parentId: null`, and the wire schema insists on `parentId: z.null()` | closed |
| `..._node_type_chk` / `..._target_kind_chk` | the wire schema's discriminated union | closed |
| `..._chat_target_idx` | **nothing, before this branch** | fixed here |

**The single-root index is closed**, and the reason is worth stating: `validateTree` runs against
the *applied result* (`upsertNodes(removeNodes(nodes, drop), incoming)`), which is the whole
workspace, not the payload. A payload adding a second root produces a two-root tree → 400
`multiple_roots`. A payload that drops the old root and adds a new one produces a one-root tree, and
is a legal (destructive) write. There is no path to a second root reaching Postgres. That is the
general rule: **`rootId` in the key ⇒ one workspace's list is the whole domain ⇒ the validator
settles it.** The chat index is the sole exception.

### FINDING — a second, WITHIN-workspace path to the same index, and it is reachable

The pre-flight by design does not cover it, and it is not hypothetical. Verified against a real
Postgres (throwaway probe, not committed):

```
VALIDATOR SAYS: {"ok":true}
TAKER-FIRST:    RAISED 23505 on agent_workspace_nodes_chat_target_idx
SWAP:           RAISED 23505 on agent_workspace_nodes_chat_target_idx
```

`writeWorkspaceNodes` issues **one** multi-row `INSERT ... ON CONFLICT DO UPDATE`, and a
non-deferrable unique index is checked per row *within* the statement. So:

- **Unbind-and-rebind.** A payload sending `n2 → chat C` and `n1 → unbound` in one `put`, where
  `n1` currently holds C. The result tree is valid (one holder), so `validateTree` passes; C is not
  *introduced* (the workspace already holds it), so the pre-flight skips it; and if the taker is
  ordered before the releaser, the index fires mid-statement.
- **Swap.** `n1: C→D`, `n2: D→C`. **No ordering of a single statement can satisfy this** — it needs
  a statement that releases before the one that takes.

The store's delete-before-upsert ordering (documented at `workspace-node-store.ts`) covers the case
where the old holder is *dropped*; it does not cover either of these, where both nodes survive.

Both are unreachable from the algebra — a binding is for life, so a pane never loses its target —
and reachable from a hand-assembled payload, which is exactly what `POST /nodes` accepts.

**Status: improved, not closed.** The backstop turns both from 502 into a typed 409 carrying the
truth, with wording that is accurate for them (`chatIndexRefusalDetail` states the fact — "a
conversation cannot be shown by two nodes at once" — rather than guessing at a cause it did not
observe, and names no id when nothing was introduced, which is precisely the unbind-and-rebind
case). Pinned by an integration test.

**But the refusal is STABLE, not transient**, so a client that rebases and re-sends the identical
payload gets the identical answer. Closing it properly means splitting the upsert so chat targets
are *released* in a statement before the one that *takes* them. That is a change to the store's
write path, deliberately left out of scope here and flagged rather than smuggled in; the test
carries a comment telling whoever makes it to expect the assertion to change.

---

## Gates

Run with the test Postgres on `localhost:5433`. Note: the shared `pagespace_test` database had a
stale drizzle journal (`drizzle` schema present, `public` empty) so migrations refused to apply. I
did **not** repair the shared database — I created a separate `pagespace_test_xws` and migrated
that, leaving `pagespace_test` exactly as found.

| Gate | Result |
|---|---|
| `bun run --filter @pagespace/lib typecheck` | **exit 0** |
| `bun run --filter @pagespace/lib lint` | **exit 0** |
| `bun run --filter web typecheck` | **exit 0** |
| `bun run --filter web lint` | **exit 0** (see note below) |
| `bun run --filter @pagespace/lib test -- src/agent-workspaces` | **640 passed / 640**, 19 files (was 625/625, 18 files) |
| `bun run --filter @pagespace/lib test -- src/services/agent-workspaces` | **199 passed / 199** |
| `bun run --filter web test -- src/lib/agent-workspaces src/app/api/agent-workspaces` | **444 passed, 3 failed** (34 files) |

**`web lint` was failing at HEAD**, not because of this work:
`workspace-node-runtime.ts` imported `readWorkspaceNodeSnapshots` and never used it (confirmed via
`git show HEAD:` — the only other mentions are in comments). Since the file is one I was already
editing, the dead import is removed and web lint is now clean.

**The 3 web failures are pre-existing.** All in
`agent-workspaces-runtime.integration.test.ts > createConversationInSession — the placeInGrid gate`,
all failing with `Server-side worker-pane placement was refused … "reason": "no_root"` — the
placement path now goes through the node model, the seeded workspace has no node tree, and the test
still asserts a row in the legacy `agent_workspace_panes`. **Verified by restoring pristine HEAD
sources, rebuilding `@pagespace/lib`, and re-running: the same 3 tests fail identically.** Not
touched here; reported.

### New tests

- `packages/lib/src/agent-workspaces/__tests__/workspace-node-chat-binding.test.ts` — 15 tests.
- `apps/web/.../__tests__/workspace-node-runtime.test.ts` — +9 (the pre-flight, its ordering against
  the ACL gate, and the backstop).
- `apps/web/.../__tests__/workspace-node-chat-binding.integration.test.ts` — 6, against a real
  Postgres.
- `apps/web/src/app/api/agent-workspaces/[workspaceId]/nodes/__tests__/route.test.ts` — +2.

The refusal **shape** is asserted, not just the refusal: `result.snapshot.rev`,
`.nodes` and `.targets` are checked at the runtime layer, at the route layer, and against a real
database; and one test asserts the conflict body equals what a fresh `readWorkspaceNodes` returns.

The integration suite exists for the two claims no mock can make. One: the pre-flight query really
does find a row in another workspace's rows (and `readWorkspaceNodeSnapshot` for that workspace
really does not — which is the whole reason `validateTree` cannot settle the rule). Two: **the
constraint name the detector hard-codes is the one Postgres actually reports.** A mock asserting
that string asserts only that the test and the code agree with each other, so the violation is
triggered directly and the raised error is fed to the real detector. The single-root violation is
triggered directly too, and the detector correctly declines it.

### Mutation checks

| Mutation | Result |
|---|---|
| Pre-flight disabled (`if (false)`) | **RED** — 2 runtime tests fail |
| Backstop removed (unconditional `throw error`) | **RED** — the TOCTOU test fails |
| Backstop widened to any `23505` (constraint-name half dropped) | **RED** — the single-root test fails |
| Route's `conflict` branch disabled | **RED** — the 409-body test fails |

Note on the first: the *integration* refusal test stays green under that mutation, because the real
database raises the violation and the backstop catches it. That is the two halves doing their job —
the outcome is correct either way, which is what matters to the client — and it is why the unit
tests exist to isolate the pre-flight.

---

## Files

**New:** `packages/lib/src/agent-workspaces/workspace-node-chat-binding.ts` (+ its test),
`apps/web/src/lib/agent-workspaces/__tests__/workspace-node-chat-binding.integration.test.ts`.

**Changed:** `workspace-node-runtime.ts` (pre-flight + backstop + `conflict` result),
`workspace-node-store.ts` (`readChatTargetHolders`), `workspace-node-wire.ts`
(`WorkspaceNodeConflictResponse`), `nodes/route.ts` (409), `workspace-node-placement.ts`
(`conflict` named), `workspace-node-validate.ts` (comments only — no behaviour change),
`agent-workspace-nodes.ts` (comment only), `packages/lib/package.json` (export subpath),
`CHANGELOG.md`.

**No migration.** The constraint already exists and is correct; what was missing was a layer that
knew about it.

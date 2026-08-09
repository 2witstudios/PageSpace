# Delete the model this epic replaced

Acts on `.pu-reports/audit-simplicity.md`, Finding 1 and Finding 5. The branch carried three
structures — the node tree, the whole old layout model, and the membership columns on
`conversations`. It now carries one.

| | before | after |
|---|---|---|
| Tables in the domain | 8 | **4** (`agent_workspaces`, `agent_workspace_shells`, `agent_workspace_nodes`, `agent_workspace_node_revs`) |
| Old-model source lines | 2,553 | **0** |
| Old-model test lines | 2,839 | **0** |
| `conversations` membership columns | 2 | **0** |
| Net | | **89 files, +527 / −6,916** |

---

## 1. The new→old dependency, cut first

Two of them, not one. The audit named the first; the compiler found the second.

**Fractions.** `workspace-node-backfill.ts`, `workspace-node-write.ts`, `workspace-node-algebra.ts`,
`workspace-node-validate.ts` and `workspace-node-store.ts` imported `FRACTION_EPSILON`,
`readFraction`, `currentShares`, `rebalanceFractions` and `resizeShare` **from
`workspace-layout-verbs.ts`**. Moved — not copied — to a new
`packages/lib/src/agent-workspaces/workspace-fractions.ts` (227 lines), together with the private
helpers they need (`quantizeFraction`, `settleToOne`, `scaleToTotal`, `MIN_FRACTION`,
`FRACTION_PRECISION`/`SCALE`). There is one epsilon.

**The lock and the executor type.** `DbExecutor` and `withWorkspaceLayoutLock` lived in
`workspace-layout-store.ts` and were imported by `workspace-node-store.ts`,
`workspace-membership-store.ts`, `workspace-shells-store.ts`, `workspace-node-runtime.ts` and
`message-repository.ts`. Neither was ever about layout: `DbExecutor` names "the pooled client or a
transaction", and the lock serializes writes for one workspace whatever is writing. Moved to
`packages/lib/src/services/agent-workspaces/workspace-lock.ts` (59 lines) and renamed
`withWorkspaceLock`. The node store's doc explained at length that it imported "the OLD lock
deliberately… for the whole of the migration window"; there is no second model and no window, so
the name now says what it does.

---

## 2. Symbol classification

### `workspace-layout-verbs.ts` (1,173 lines)

| Symbol | Verdict |
|---|---|
| `FRACTION_EPSILON`, `MIN_FRACTION`, `quantizeFraction`, `readFraction`, `rebalanceFractions`, `currentShares`, `resizeShare` | **moved** → `workspace-fractions.ts` |
| `MAX_GRID_COLUMNS` | **moved** → `workspace-node-validate.ts` as `MAX_SIBLINGS` (same value, 64; sole surviving consumer is `session-tools.ts`'s zod bounds, which were already borrowing it from the model they replaced) |
| `MAX_PANES_PER_COLUMN` | **dead** — only the deleted split verbs read it |
| `PaneState`, `ColumnState`, `WorkspaceState` | **superseded by** `WorkspaceNode` / `RootNode` / `SplitNode` / `PaneNode` (`workspace-node.ts`) |
| `newWorkspace` | **superseded by** `admit`'s no-root branch (`workspace-membership.ts`) |
| `assignPane`, `assignPaneShowing`, `resetPane`, `dismissPicker` | **superseded by** `bind` (`workspace-node-algebra.ts`) |
| `splitRight`, `splitDown` | **superseded by** `create` |
| `closePane`, `isLastPane` | **superseded by** `destroy` |
| `movePane`, `reorderColumns` | **superseded by** `move` |
| `resizeColumn`, `resizePane` | **superseded by** `resize` |
| `selectPane` | **dead** — focus is client-local (`useAgentWorkspaceStore.selectNode`) |
| `panesOf`, `paneShowing` | **superseded by** `childrenOf` / `findNode` / `memberNode` |
| `workspaceLayoutVerbSchema`, `WorkspaceLayoutVerb`, `WorkspaceLayoutVerbOutcome`, `applyVerbLocal` | **superseded by** the node write payload parsed at `/nodes` |
| `isReplaceable`, `OpenPlacement`, `resolveOpenPlacement` | **superseded by** `resolvePlacement` (`workspace-node-commands.ts`) |
| `LayoutGridPane`, `LayoutGridColumn`, `WorkspaceLayoutGridDTO`, `gridFromWorkspaceState`, `workspaceStateFromGrid` | **superseded by** `workspace-node-rows.ts` / `workspace-node-wire.ts` |

### `contract.ts` (127 lines) — deleted entirely; nothing survived it

| Symbol | Verdict |
|---|---|
| `PANE_KINDS`, `paneKindSchema`, `PaneKind` | **superseded by** `PaneTargetKind` (`workspace-node.ts`) |
| `paneScopeSchema`, `PaneScope` | **superseded by** `PaneTarget` — the node model resolves titles beside the tree, so the scope's `name`/`agentPageId` display fields have no successor and need none |
| `persistedPaneStateSchema`/`PersistedPaneState`, `persistedColumnStateSchema`/`PersistedColumnState`, `persistedWorkspaceStateSchema`/`PersistedWorkspaceState` | **superseded by** `workspace-node-wire.ts` |

The file is now gone. Its other two concerns had already moved out (`shells-contract.ts`,
`session-contract.ts`) in the earlier split.

### `workspace-layout-wire.ts` (43 lines) — not in the brief, found by following imports

`WorkspaceLayoutSnapshot`, `WorkspaceLayoutVerbResponse`, `WorkspaceLayoutStaleResponse` — all
**dead** with the two routes that returned them.

### `workspace-layout-store.ts` (317 lines)

| Symbol | Verdict |
|---|---|
| `DbExecutor`, `withWorkspaceLayoutLock` | **moved** → `workspace-lock.ts` (`withWorkspaceLock`) |
| `WorkspaceLayoutStore`, `createDbWorkspaceLayoutStore`, `getWorkspaceGrid`, `getWorkspaceGridsBulk`, `replaceWorkspaceGrid`, `currentRev` | **superseded by** `readWorkspaceNodeSnapshots` / `writeWorkspaceNodes` |
| `WorkspaceLayoutOpRecord`, `findOp`, `recordOp` | **dead** — a node write is an upsert of a set, so a retry re-applies to the same state |

### `workspace-layout-runtime.ts` (514 lines)

`applyWorkspaceLayoutVerb`, `readWorkspaceLayoutSnapshot`, `readWorkspaceGridsBulk`,
`workspaceListEntryFromGrid`, `resolvePaneLabels` — all **superseded by**
`workspace-node-runtime.ts`'s `applyWorkspaceNodeWrite` / `readWorkspaceNodes` /
`readWorkspaceNodesBulk` / `resolveTargets`.

### Partial deletions

| Module | Died | Kept |
|---|---|---|
| `authorize-pane-scope.ts` | `paneScopesOfVerb`, `authorizeVerbScopes` | `authorizePaneScope`, `authorizePaneTargets`, `introducedPaneTargets`, `paneScopeDeps` — the node route's gate, unchanged in what it asks |
| `agent-workspace-events.ts` | `WorkspaceUpdatedPayload`, `broadcastWorkspaceUpdated`, `workspace:updated` | `broadcastWorkspaceNodesUpdated` |
| `session-tools.ts` | nothing | re-pointed at `PaneTargetKind` + `MAX_SIBLINGS` |
| `contract.test.ts` | the layout third | renamed `session-and-shells-contract.test.ts` — its session and shells cases outlive the module it was named for |

### Routes

`GET`/`PUT /agent-workspaces/[workspaceId]/workspace` and
`POST /agent-workspaces/[workspaceId]/workspace/verbs` deleted. The sessions-list route's
`workspace` field — self-described in the source as "LEGACY… stays for the rolling-deploy window" —
went with them; no client read it.

---

## 3. The migration

**`packages/db/drizzle/0256_dapper_groot.sql`**, generated with `bun run db:generate` (no
hand-written DDL; a header comment was prepended, which the repo's migration tests strip).

Drops `agent_workspace_panes`, `agent_workspace_pane_columns`, `agent_workspace_layout_revs`,
`agent_workspace_layout_ops`, the FK and index on `conversations.workspaceId`, and the columns
`conversations.workspaceId` and `conversations.closedInWorkspaceAt`.

### What would be lost against a database the backfill had NOT been run on

Written into the migration's own header as well as here, because that is the failure mode.

Everything dropped is superseded **only on a database where
`scripts/backfill-agent-workspace-nodes.ts` (migration 0255) already ran.** Against one where it did
not — a restored old snapshot, a long-lived branch database, a tenant image that skipped the 0255
window — this migration does not migrate anything. It **deletes every workspace's pane grid and
every thread's workspace membership outright**, with no second home to recover from. The failure is
quiet: each workspace afterwards opens empty and each thread appears in past-conversation history
alone, because `listSessionConversationsBulk` joins membership through `agent_workspace_nodes` and
finds nothing.

The header carries two `SELECT count(*)` pre-flight checks, both of which must return 0.

**Verified**: the full 256-migration chain applies cleanly to an empty Postgres 17, and afterwards
the four tables and both columns are absent and the two node tables present.

---

## 4. What I found living in those modules that did not belong to them

1. **`DbExecutor` and the per-workspace advisory lock** were in the layout store, and five
   node-model modules imported them from it. A second new→old dependency the audit had not spotted;
   nothing could be deleted until it moved either.

2. **The fraction primitives had no test of their own.** They were exercised only through the old
   verbs (`workspace-layout-rearrange.test.ts`), so deleting the old model would have silently
   deleted their only direct coverage. Added
   `__tests__/workspace-fractions.test.ts` (223 lines, 21 cases incl. a seeded property run).
   **Mutation-checked**: six mutations of `workspace-fractions.ts` — residual onto the last member
   instead of the largest, `readFraction` admitting zero/negatives, a lone member keeping its share,
   `currentShares` half-trusting a mixed container, the floor removed from `scaleToTotal`, and
   `quantizeFraction` in its off-grid divide-then-multiply form — each turned the suite red.

3. **The directory listener's `created`/`closed`/`deleted` handlers were already dead.** All three
   keyed on `payload.workspaceId`, and nothing had written a non-null `conversations.workspaceId`
   since the membership chokepoint landed — so a worker an agent spawned reached `handleCreated`
   with a null and took the early return, back onto the 120s poll. That is the exact problem the
   listener exists to solve, so the epic had quietly reintroduced it. They are now unconditional
   re-reads: one request instead of a two-minute poll. `upsertConversationInCache`, whose only
   caller was the dead branch, is deleted.
   *This was caught by the repo's own guard* — `conversation-events-audience.test.ts` asserts every
   name in `CONVERSATION_EVENTS` has a client subscriber, and my first pass (deleting the handlers)
   failed it. The guard was right; I did not edit it.

4. **`conversations.workspaceId` and `closedInWorkspaceAt` were already write-dead.** Every INSERT
   wrote `null`; the only UPDATE (`claimConversation`) and the two listing writers
   (`closeConversationListing`/`reopenConversationListing`) had been deleted earlier in the epic. So
   removing them from the `conversation:*` wire is not a behaviour change — it removes a field that
   was constantly `null`. Removed from `ConversationEventBase`, `ConversationChangedFields`,
   `ConversationEmitContext`, the `created` payload, `BumpedConversationRow`, `ConversationStats`,
   `ConversationSummary` and `Conversation`.

5. **The tenant export's session selection read the dropped column in RAW SQL**, in
   `workspaceSelectionWhere` (`scripts/lib/migration-utils.ts`) and `tenant-export.ts`. Invisible to
   `tsc` — string SQL — and caught only by running the tenant suites against a real Postgres.
   Re-pointed at `agent_workspace_nodes` (`targetKind = 'chat'`). **If this had shipped, every
   tenant migration would have aborted at export time.**

---

## 5. Two things I did not do, and why

**`agent_workspace_nodes` / `agent_workspace_node_revs` are unregistered in the tenant export, and
that suite is still one test red.** `scripts/__tests__/tenant-export-columns.test.ts` →
"records a carry-or-exclude decision for every table hanging off a session or a thread".

**This is pre-existing, not mine.** `git show HEAD:scripts/lib/tenant-export-columns.ts | grep -c
agent_workspace_nodes` is `0` while both tables exist at HEAD; the guard derives its FK closure from
the live schema, so it was already failing on this branch before I touched anything.

I did not settle it, and deliberately left the alarm ringing rather than writing an exclusion line.
The decision is not the formality it was for the pane tables: those held arrangement only, so
dropping them cost a user their column widths. `agent_workspace_nodes` holds **membership**, so a
bundle without it hands the migrated user workspaces that list no threads. Carrying it is not a copy
either — `targetId` is polymorphic with no FK, so every node naming a conversation, page or shell
outside the bundle must be pruned or unbound on the way out, and the global
`UNIQUE (targetId) WHERE targetKind = 'chat'` turns a mistake there into a failed import. That is a
real piece of export logic, not a registry line. The reasoning is recorded in
`TENANT_EXPORT_EXCLUDED_TABLES`' note so the next reader finds the decision, not the omission.

**`workspace-node-backfill.ts` (818 lines) and its 912-line suite are now callerless.** I deleted
`scripts/backfill-agent-workspace-nodes.ts` — it SELECTs from all four dropped tables, so it can no
longer run, and keeping it would be a lie. But the brief's step 1 explicitly directs the pure
derivation to be *re-pointed*, not removed, so I re-pointed it and left it. It is the obvious next
deletion; it is not mine to make.

---

## 6. Gates

| Gate | Result |
|---|---|
| `bun run build` | 14/14 |
| `bun run typecheck` (monorepo, post-build) | **17/17** |
| `bun run --filter @pagespace/lib test -- src/agent-workspaces` | **594 passed** (19 files) |
| `bun run --filter @pagespace/lib lint` | clean |
| `bun run lint` (monorepo) | 15/15 |
| `bun run lint:scripts` | clean |
| `node scripts/knip-ratchet.mjs` | within baseline (4/4) |

Run against a throwaway Postgres 17 with the full migration chain applied (the shared
`pagespace-postgres-test` container is owned by another checkout and was left untouched):

| Suite | Result |
|---|---|
| `@pagespace/lib test` | **9,229 passed**, 0 failed |
| `web test` | **16,730 passed**, 0 failed |
| `@pagespace/db test` | **620 passed** (incl. the live 0247→0252 migration chain) |
| `scripts` | 272 passed, **1 failed** — the pre-existing tenant-registry decision above |

`gdpr-eraser.integration.test.ts` needs `ADMIN_DATABASE_URL`, which is unset here; environment, not
code.

The node model's behaviour is unchanged. No test covering it was weakened; three guards
(the broadcast-subscriber invariant, the `conversation:created` wire-payload capture, and the
evidence manifest's test-name citations) caught real consequences of the deletion and were updated
to state what is now true rather than relaxed.

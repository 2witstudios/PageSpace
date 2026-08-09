# Simplicity audit — are we doing the thing, or violating it?

Four passes over the branch as merged, against the code rather than the reports.

## Finding 1 (CRITICAL) — the branch has THREE structures, not one

The epic exists to replace two structures with one. It is currently at three.

| | |
|---|---|
| Tables in this domain | 8 — including `agent_workspace_panes`, `agent_workspace_pane_columns`, `agent_workspace_layout_revs`, `agent_workspace_layout_ops`, all superseded |
| Old model code present | 1,618 lines (`workspace-layout-verbs.ts`, `contract.ts`) |
| Files still importing it | 26 |
| `conversations.workspaceId`, `closedInWorkspaceAt` | still present |

**Cause, and it is an orchestration error not an engineering one.** Phase 5 was dropped as "rolling-deploy machinery" when the delivery shape changed to one cutover PR. But Phase 5's content was *"drop the shadow tables, columns and shim"*. The **shim** was rolling-deploy machinery. **Deleting the model we replaced was not.** Both were dropped in one move.

The lesson generalises: when a phase is dropped, its leaves must be re-read individually. A phase is a container, and dropping a container silently drops things that had nothing to do with the reason.

## Finding 2 (HIGH) — the self-FK cascade is redundant, and it caused the data-loss bug

`destroy` already names every node it removes: `removeNodes(nodes, [nodeId, ...descendantsOf(nodes, nodeId)])`.

So `ON DELETE CASCADE` on the composite self-FK — justified in the schema doc as "deleting a container removes its whole subtree for free" — is a convenience **the algebra never takes**. What it actually did:

- deleted nodes that were being **reparented, not removed** (the HIGH finding in `pu-rev-phase1.md`, verified against PostgreSQL 17.5)
- forced the cascade-rescue mechanism in `workspace-node-write.ts` to exist
- made `applyNodeWrite`'s statement ordering load-bearing

Removing the cascade makes the bug unspellable, deletes the rescue, and makes ordering irrelevant. **A constraint was added for a convenience nobody used, then a module was written to defend against it.**

## Finding 3 — assumptions inherited rather than required

- **`node_revs` as its own table.** Inherited from the old model's reason: keep the rev off `agent_workspaces` so layout writes never contend with sandbox CAS writes. If sandbox state moves to its own FK'd table, that contention does not exist and the rev can be a column. The justification outlived what justified it.
- **`WireWorkspaceNode = WorkspaceNode & { rootId?: string }`.** The wire re-adds the field the model deliberately omits, while `workspace-node-rows.ts` already owns exactly that translation. Two modules, one job.
- **`workspace-node-chat-binding.ts` (175 lines).** Exists only because the model is deliberately `rootId`-blind, so a global constraint cannot be checked locally. A real trade, worth keeping — but it is the *cost of workspace-blindness*, not something inherent, and should be documented as such.
- **`targets[]` separate from nodes.** Genuinely required: titles are per-viewer redacted, so they cannot ride inside a structural broadcast. Keep.

## Finding 4 — separation of concerns

- `agent_workspaces` mixes identity, lifecycle, sandbox and billing. A sandbox should relate to a workspace the way a conversation relates to a user: an FK, not coupling. Referential integrity instead of coordination — the row then cannot orphan, and only the external VM needs reconciliation, which is already id-keyed and reaped by `sprite-orphan-reconcile.ts`.
- `workspace-node-write.ts` mixes persistence shaping with cascade compensation. Dies with Finding 2.

## Order of correction

1. **One removal, no parentless panes** (in flight) — `destroy` works on any node; ending a session is destroying the session node; `parentId` non-null for every non-root node.
2. **Delete the old model** — restores the epic's premise. Nothing else matters while three structures exist.
3. **Drop the redundant cascade** — deletes a bug class and a module.
4. **Extract the sandbox table**, then revisit `node_revs` and the wire/rows overlap.

Sequenced, not parallel. Two clusters run concurrently over `apps/web` earlier produced an eight-region semantic merge where one region required both sides interleaved; the cost exceeded the saving.

---

## Pass 5 — the old model is far less entangled than the import count suggests

"26 files import the old model" overstates the deletion. What they import:

**`contract.ts` — 19 importers, and it is a grab-bag of three unrelated concerns:**

| Symbols | Concern | Dies with the old model? |
|---|---|---|
| `ShellDTO`, `SHELL_BRIDGE_ROUTES`, `ShellAgentType`, `shellDtoSchema`, `clampShellDimensions`, `ShellConnectPayload`, `SHELL_AGENT_TYPES` | shells | **no** |
| `MAX_ACTIVE_WORKSPACES_PER_OWNER`, `AgentSessionDTO`, `agentSessionDtoSchema`, `SandboxStatus` | session identity + lifecycle | **no** |
| `PaneScope`, `PaneKind`, `PersistedWorkspaceState` | layout | yes — 5 uses across 3 files |

The old model looked entangled across 26 files because **one module holds three concerns**, not because the layout model reached everywhere. That is a module-boundary problem masquerading as coupling, and splitting `contract.ts` by concern is most of the deletion's cost.

**`workspace-layout-verbs.ts` — 8 importers**, genuinely layout: `LayoutGridColumn`, `WorkspaceLayoutVerb`, `resolveOpenPlacement`, `isReplaceable`, `WorkspaceState`, `MAX_GRID_COLUMNS`, `workspaceLayoutVerbSchema`.

## Finding 5 (ORDERING CONSTRAINT) — the successor depends on what it replaces

`FRACTION_EPSILON` and `readFraction` are imported **by the new node model from the old layout model**. The old model cannot be deleted until they move. Anyone starting the deletion without knowing this hits it mid-change, with the tree half-converted.

It is also a smell in its own right: a fraction primitive is not layout-model-specific, and living in `workspace-layout-verbs.ts` is why the successor had to reach backwards for it.

## Revised order for step 2 (deleting the old model)

1. Move `FRACTION_EPSILON` / `readFraction` to the node model — cuts the new→old dependency.
2. Split `contract.ts` by concern: shells, session lifecycle, layout. The first two are keepers that were never layout; only the third dies.
3. Delete `workspace-layout-verbs.ts` and its ~3 real consumers (`workspace-layout-runtime.ts`, the old verbs route, the layout half of `session-tools`).
4. Drop `agent_workspace_panes`, `_pane_columns`, `_layout_revs`, `_layout_ops`, and `conversations.workspaceId` / `closedInWorkspaceAt`.

Steps 1 and 2 are safe to do BEFORE the one-removal correction lands — they touch the old module's boundaries, not the node model's behaviour.

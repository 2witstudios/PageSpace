import { pgTable, text, integer, real, timestamp, bigint, index, uniqueIndex, primaryKey, foreignKey, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { agentWorkspaces } from './agent-workspaces';

/**
 * Agent Workspace Nodes / Node Revs
 *
 * The storage half of the workspace NODE model — see
 * `@pagespace/lib/agent-workspaces/workspace-node.ts` for the model itself and
 * `workspace-node-rows.ts` for the rows ⟷ nodes translation whose
 * `WorkspaceNodeRow` these columns mirror one-for-one.
 *
 * **Why it supersedes `agent_workspace_pane_columns` / `agent_workspace_panes`.**
 * Those two tables store a workspace's MEMBERSHIP (which panes exist) and its
 * LAYOUT (where they sit) as two facts kept in correspondence by convention
 * across every write path — which is the bug class this model deletes. Here
 * there is ONE flat list per workspace in which `parentId` says where a node
 * sits, and nothing decides membership but presence in the list: "in the
 * session" and "on screen" are the same sentence.
 *
 * **ONLY THE ROOT CARRIES A NULL `parentId`.** An earlier cut of this model let
 * a non-root row carry one and called it DETACHED — in the workspace, off the
 * grid — which rebuilt the same split one level down: a permanent population of
 * parentless rows existed by design, so a row that lost its parent to a defect
 * was indistinguishable from a pane a user had closed. Closing a pane DELETES
 * its row now, and `workspace-node-rows.ts` refuses to parse a non-root row
 * whose `parentId` is null (`validateTree` calls the same fault
 * `null_parent`).
 *
 * **Additive and inert on arrival.** Nothing reads or writes these tables at
 * the migration that creates them; the old tables stay live. That is the
 * repo's expand→cutover→contract shape (the same one `workspaceState` went
 * through — kept a release as the rolling-deploy shim, dropped at 0252), so
 * the constraints below reach production ahead of any code that depends on
 * them rather than alongside it.
 *
 * **The inherited decisions.** `id`s are CLIENT-MINTED, exactly as the pane
 * tables' are (the browser authors ids so an optimistic local edit needs no
 * server round-trip for identity), so two workspaces can legitimately mint the
 * same id and the primary key must be the compound `(rootId, id)`.
 * `targetKind`/`targetId` are polymorphic and deliberately carry NO foreign
 * key: a node pointing at a deleted conversation, shell, or page repairs at
 * read time, and deleting a conversation must never take a layout row with it.
 * `position` is a plain contiguous 0-based integer — deliberately NOT
 * `pages.position`'s fractional `real`, because sibling groups here are tiny
 * (renumbering is O(siblings) inside the transaction that made the edit) and
 * contiguity is an invariant `validateTree` asserts, which is precisely what
 * fractional ordering trades away.
 *
 * **What the DB refuses, and what it deliberately does not.** Six constraints
 * below make six illegal states unrepresentable — read each one's own comment
 * for why it exists. Two things stay outside them ON PURPOSE:
 *
 *   * Properties of a SET of rows — a parent-pointer CYCLE (`a → b → a`, or a
 *     node parented to itself), contiguous `position`, fractions that settle,
 *     depth and count caps. No table constraint can state any of them, and
 *     refusing one shape of cycle while the validator must still refuse every
 *     other shape buys no invariant, so this is `validateTree`'s territory in
 *     full — the price the model's docblock says is paid deliberately, once,
 *     for a flat list. (A cycle is also unreachable from the root, so it
 *     survives a subtree cascade as an island; only the workspace-level
 *     cascade of constraint 3 collects it.)
 *   * Agreement between a row and its own `nodeType` — a half-bound pane
 *     (`targetKind` without `targetId`), a pane carrying an `axis`, a split
 *     without one, a root with a non-zero `position`. These ARE single-row
 *     properties a CHECK could state, and they are left out because
 *     `workspace-node-rows.ts` says where they belong: "the union's invariants
 *     are re-established HERE, at the one place untyped storage becomes a
 *     node, rather than trusted from the column types." Mirroring the parse in
 *     the column constraints would put the same rule in two places, which is
 *     the drift this epic exists to remove.
 *
 * The two domain checks below are the ONE exception, and for a different
 * reason — see their comment.
 *
 * `agent_workspace_node_revs` is the per-WORKSPACE monotonic mutation counter,
 * carried over unchanged from `agent_workspace_layout_revs`. The rev lives in
 * its OWN table — NOT as a column on `agent_workspaces` — so the write's
 * `INSERT ... ON CONFLICT ("rootId") DO UPDATE SET rev = rev + 1 RETURNING rev`
 * (which doubles as the serializing row lock) never takes a lock on the
 * `agent_workspaces` row that sandbox teardown/ensure CAS writes contend on: a
 * layout edit must never queue behind a Sprite provisioning transaction, or
 * vice versa.
 *
 * There is deliberately NO successor to `agent_workspace_layout_ops`. That
 * table was the verb route's idempotency memory, and it existed for one
 * reason: a replayed `split_right` would re-insert its own client-minted pane
 * id and violate the primary key. The write primitive here is an UPSERT of a
 * node set (`upsertNodes` — replace by id where present, append where not), so
 * a replayed write is a no-op by construction and there is nothing left for an
 * idempotency table to remember.
 */
export const agentWorkspaceNodes = pgTable('agent_workspace_nodes', {
  /** Client-minted node id — unique per workspace only (compound PK). */
  id: text('id').notNull(),

  /**
   * The owning workspace (`agent_workspaces.id`). Scoping only — deliberately
   * NOT part of the `WorkspaceNode` model, which is what makes cross-workspace
   * parenting unspellable rather than merely unlikely: a node list IS one
   * workspace's, so no node can name another session to move into.
   *
   * CONSTRAINT 3 of 6 — the direct FK with `onDelete: 'cascade'`. The pane
   * tables cascaded only through the column FK, which leaves any row outside
   * the self-FK — the ROOT, whose `parentId` is null — with no cascade path at
   * all. Naming `agent_workspaces` directly gives every row one.
   */
  rootId: text('rootId')
    .notNull()
    .references(() => agentWorkspaces.id, { onDelete: 'cascade' }),

  /**
   * The containing node, or NULL — and NULL means exactly one thing: this row is
   * the ROOT. `nodeType`, never this column, is what says so; the null is a
   * consequence of being the root rather than a definition of it, which is why
   * every reader finds the root by type.
   *
   * A non-root row carrying NULL is CORRUPT, not detached. It used to be legal
   * (see the module docblock), and the parse in
   * `@pagespace/lib/agent-workspaces/workspace-node-rows.ts` now refuses it —
   * which is where the refusal lives, per this file's own rule that row/type
   * agreement belongs to the parse rather than to a duplicated CHECK.
   */
  parentId: text('parentId'),

  /**
   * Contiguous 0-based position among siblings; renumbered by whichever write
   * changes sibling order. Named `position` and not `orderIndex` because PageSpace's
   * other tree — `pages` — already names it that, and under this name a
   * `WorkspaceNode` structurally satisfies the generic `{id, parentId,
   * position?}` builder in `content/tree-utils.ts`.
   */
  position: integer('position').notNull(),

  /**
   * `'root' | 'split' | 'pane'` — the discriminator, and the thing that
   * identifies the root. NOT a null `parentId`: a ROW can carry one without
   * being a root, and reading the null as the definition is how a corrupt row
   * gets crowned.
   */
  nodeType: text('nodeType').notNull(),

  /** A container's split direction (`'row' | 'column'`). NULL on a pane. */
  axis: text('axis'),

  /**
   * This node's share of its parent. NULL means UNSIZED (the parent's children
   * split it evenly) — the state the model spells by OMITTING the key, never
   * by an explicit null, so a tree the algebra built and one rehydrated from
   * these rows are byte-identical. `real` to match the fractions the pane
   * tables reserved.
   */
  fraction: real('fraction'),

  /**
   * `'chat' | 'terminal' | 'page'` — what a bound pane is a viewport onto.
   * NULL (together with `targetId`) is an unbound pane rendering the picker.
   */
  targetKind: text('targetKind'),

  /**
   * conversationId | shellId | pageId by `targetKind` — polymorphic, and
   * deliberately with NO foreign key, exactly as the pane rows this replaces:
   * a node pointing at a deleted target repairs at read/bind time, and
   * deleting a conversation must never take a layout row with it.
   */
  targetId: text('targetId'),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  /**
   * CONSTRAINT 1 of 6 — the compound primary key. Ids are client-minted, so
   * two workspaces minting the identical id is legitimate rather than a
   * collision; scoping identity by `(rootId, id)` makes it impossible for such
   * an id to be misdirected into another workspace's list. It is also the
   * target the self-FK below references, and its leading column is why this
   * table needs no separate `rootId` index — reading a workspace's nodes is a
   * prefix scan of this key.
   */
  pk: primaryKey({ columns: [table.rootId, table.id] }),

  /**
   * CONSTRAINT 2 of 6 — the composite self-FK, cascading. Two things at once:
   * deleting a container removes its whole subtree for free, and a parent in
   * ANOTHER workspace becomes a database error rather than a convention. The
   * `rootId` column appears on both sides, so a row can only ever name a
   * parent inside its own workspace.
   *
   * A NULL `parentId` sits outside this constraint naturally: under Postgres's
   * default `MATCH SIMPLE`, a composite FK with any NULL column is not checked.
   * That is the ROOT's row — and it is why constraint 3 above exists to give it
   * its own cascade path.
   *
   * It is also why a non-root row carrying NULL is invisible HERE: the FK cannot
   * refuse what it is not checking, so that refusal lives in the row parse and
   * in `validateTree` (`null_parent`). The converse CHECK — `nodeType = 'root'
   * OR parentId IS NOT NULL` — would state it in the table as well; it is not
   * added here because it needs its own migration, and this table's rule is that
   * row/type agreement belongs to the parse.
   *
   * ITS NAME IN THE DATABASE IS TRUNCATED. Drizzle derives
   * `agent_workspace_nodes_rootId_parentId_agent_workspace_nodes_rootId_id_fk`,
   * which is 72 characters, and Postgres cuts every identifier to 63 — so the
   * constraint actually present is
   * `agent_workspace_nodes_rootId_parentId_agent_workspace_nodes_roo`. The
   * migration applies fine (Postgres only NOTICEs). Any future
   * `ALTER TABLE … DROP CONSTRAINT` must name the truncated form, and giving it
   * an explicit short name is a rename that needs its own migration.
   *
   * The cascade is also why `applyNodeWrite`
   * (`packages/lib/src/agent-workspaces/workspace-node-algebra.ts`) applies
   * `put` before `drop`: a collapse drops a container whose children are being
   * REPARENTED, and dropping first would take them with it.
   */
  parentFk: foreignKey({
    columns: [table.rootId, table.parentId],
    foreignColumns: [table.rootId, table.id],
  }).onDelete('cascade'),

  /**
   * CONSTRAINT 4 of 6 — exactly one root per workspace, as a constraint rather
   * than a comment. `rootOf` finds the root by TYPE and returns the first
   * match; a second root would make that answer arbitrary and silently hide
   * half a workspace behind whichever row the scan reached first.
   */
  oneRootPerWorkspace: uniqueIndex('agent_workspace_nodes_one_root_idx')
    .on(table.rootId)
    .where(sql`${table.nodeType} = 'root'`),

  /**
   * CONSTRAINT 6 of 6 — a conversation is bound to at most one node ANYWHERE.
   * Global on purpose, not per-workspace: a conversation belongs to exactly
   * one workspace (`conversations.workspaceId`, set at creation and permanent
   * — "moving a thread elsewhere is a FORK, never a rebind"). Scoping this per
   * workspace would permit the very state that rule forbids, in which the same
   * thread renders in two sessions and each believes it owns the history.
   *
   * **It is the only constraint here whose key omits `rootId`, and that has a
   * consequence one layer up.** A pane's `targetId` is free-form in the write
   * payload and is NOT held to `conversations.workspaceId` by anything — a pane
   * naming a conversation in another session is reachable, which is why the
   * backfill arbitrates chat claims across the whole table. So `validateTree`,
   * which is handed one workspace's nodes, can only settle the within-workspace
   * half; the global half is a pre-flight lookup plus a catch on THIS index by
   * name, in `apps/web/src/lib/agent-workspaces/workspace-node-runtime.ts`.
   * Every other constraint above carries `rootId` and is therefore settled by
   * the validator alone.
   *
   * Pages and terminals carry NO such constraint, deliberately: opening the
   * same page in two panes is a legitimate thing a user does.
   */
  oneNodePerChat: uniqueIndex('agent_workspace_nodes_chat_target_idx')
    .on(table.targetId)
    .where(sql`${table.targetKind} = 'chat'`),

  /**
   * Not a correctness constraint — an index the composite self-FK needs.
   * Postgres indexes the REFERENCED side of a foreign key, never the
   * referencing side, so every cascading delete (and every subtree read that
   * goes child-first) would otherwise scan this table across ALL workspaces.
   */
  parentIdx: index('agent_workspace_nodes_parent_idx').on(table.rootId, table.parentId),

  /**
   * CONSTRAINT 5 of 6 — a root never carries a parent. Written as
   * `nodeType <> 'root' OR ...` rather than a CASE so every other type is left
   * unconstrained rather than accidentally forbidden (the form conversations'
   * type checks use).
   *
   * BICONDITIONAL, and that is the whole of it: root IF AND ONLY IF parentless.
   * An implication in one direction only (`nodeType <> 'root' OR parentId IS
   * NULL`) constrains a root to be parentless but says nothing about a `pane`
   * or `split` that carries no parent — and the composite self-FK does not
   * close that half either, because `MATCH SIMPLE` skips the check entirely
   * when any referencing column is NULL.
   *
   * That gap was not academic. A parentless non-root is exactly the "detached"
   * state this epic deleted: `validateTree` returns `null_parent` for it and
   * `nodeFromRow` throws on it, so the row the database would have accepted is
   * one every reader crashes on. A workspace holding it cannot be read at all —
   * strictly worse than the write being refused. The invariant the model
   * already depends on is now stated where it can be violated.
   */
  rootHasNoParent: check(
    'agent_workspace_nodes_root_no_parent_chk',
    sql`(${table.nodeType} = 'root') = (${table.parentId} IS NULL)`,
  ),

  /**
   * Beyond the six, and NOT an exception to "row/type agreement belongs to the
   * parse" (see the module docblock): these two are what make constraints 4
   * and 6 mean what they say. Both are PARTIAL indexes predicated on
   * `nodeType = 'root'` / `targetKind = 'chat'`, and a partial index is silent
   * about every row outside its predicate — so without a closed domain a
   * value of `'Root'` or `'Chat'` does not violate the single-root or
   * one-node-per-conversation rule, it EXITS it, and a second root or a second
   * binding lands unnoticed. The domains are already closed by the model
   * (`WorkspaceNode['nodeType']`, `PaneTargetKind`); stating them here is what
   * keeps the two indexes above total rather than conditional on a spelling.
   */
  nodeTypeValues: check(
    'agent_workspace_nodes_node_type_chk',
    sql`${table.nodeType} IN ('root', 'split', 'pane')`,
  ),
  targetKindValues: check(
    'agent_workspace_nodes_target_kind_chk',
    sql`${table.targetKind} IS NULL OR ${table.targetKind} IN ('chat', 'terminal', 'page')`,
  ),
}));

/**
 * The per-workspace monotonic mutation counter. Its own table, not a column on
 * `agent_workspaces` — see the module docblock for the lock-contention reason,
 * which is the same one `agent_workspace_layout_revs` was built on.
 */
export const agentWorkspaceNodeRevs = pgTable('agent_workspace_node_revs', {
  rootId: text('rootId')
    .primaryKey()
    .references(() => agentWorkspaces.id, { onDelete: 'cascade' }),
  /** Monotonic per-workspace mutation counter; 0 = no write has ever applied. */
  rev: bigint('rev', { mode: 'number' }).notNull().default(0),
});

export const agentWorkspaceNodesRelations = relations(agentWorkspaceNodes, ({ one, many }) => ({
  workspace: one(agentWorkspaces, {
    fields: [agentWorkspaceNodes.rootId],
    references: [agentWorkspaces.id],
  }),
  // Self-relation over the compound key. `parent` is optional in the data — the
  // ROOT has none — which is the relational shape of the same NULL the self-FK
  // skips.
  parent: one(agentWorkspaceNodes, {
    fields: [agentWorkspaceNodes.rootId, agentWorkspaceNodes.parentId],
    references: [agentWorkspaceNodes.rootId, agentWorkspaceNodes.id],
    relationName: 'agentWorkspaceNodeParent',
  }),
  children: many(agentWorkspaceNodes, { relationName: 'agentWorkspaceNodeParent' }),
}));

export const agentWorkspaceNodeRevsRelations = relations(agentWorkspaceNodeRevs, ({ one }) => ({
  workspace: one(agentWorkspaces, {
    fields: [agentWorkspaceNodeRevs.rootId],
    references: [agentWorkspaces.id],
  }),
}));

export type AgentWorkspaceNodeRow = typeof agentWorkspaceNodes.$inferSelect;
export type NewAgentWorkspaceNodeRow = typeof agentWorkspaceNodes.$inferInsert;
export type AgentWorkspaceNodeRevRow = typeof agentWorkspaceNodeRevs.$inferSelect;

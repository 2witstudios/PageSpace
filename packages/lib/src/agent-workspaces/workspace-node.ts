/**
 * The workspace NODE model — one flat list of nodes in which `parentId`
 * decides visibility and location, and nothing decides membership but presence.
 *
 * **Why flat and not a nested tree.** The rows are flat, the wire is flat, and
 * a flat list is the only shape in which a DETACHED node — present in the
 * workspace, absent from the rendered tree — is not a second bucket sitting
 * beside the tree. The whole point of this model is that "in the workspace" and
 * "on screen" stop being two structures, so the canonical form may not
 * reintroduce the split at the type level. Nesting is derived for rendering.
 *
 * The price is that a flat parent pointer can express a cycle, which a nested
 * type cannot. That is paid once, deliberately, in `validateTree` — the single
 * function every write path runs — rather than by giving the model a shape that
 * fights its own storage.
 *
 * **Why a discriminated union.** Everything a `nodeType` can rule out is ruled
 * out here rather than in the validator: a root cannot carry a parent, a split
 * cannot be detached, and a pane cannot carry an axis. `validateTree` is then
 * left with exactly the invariants a type cannot state — one root, no cycles,
 * no dangling parent, depth and count caps, fractions that settle.
 *
 * **Why `position` and not `orderIndex`.** PageSpace already has a tree — the
 * page tree — and it already names this field `position` (`pages.position` in
 * `packages/db/src/schema/core.ts`). The generic builder in
 * `content/tree-utils.ts` is constrained on `{id, parentId, position?}`, so
 * under this name a `WorkspaceNode` satisfies it structurally and the kinship
 * with the page tree is visible in the types instead of being something a
 * reader has to notice. One concept called two names in one codebase is the
 * drift this model exists to remove.
 *
 * **Why it stays a contiguous integer.** Deliberately NOT pages' fractional
 * `real` positioning. Sibling groups here are tiny, so renumbering is
 * O(siblings) inside the same locked transaction that made the edit — and
 * contiguity is an invariant `validateTree` can assert, which is exactly what
 * fractional ordering gives up in exchange for avoiding a renumbering cost
 * this model does not have.
 *
 * Successor to the two-level `columns[].panes[]` model in
 * `workspace-layout-verbs.ts`, which keeps its own `orderIndex` — it is on its
 * way out, and renaming there would be churn. Both exist during the migration
 * window.
 */

/** A container's split direction. A row of columns; a column of stacked panes. */
export type NodeAxis = 'row' | 'column';

/** What a bound pane is a viewport onto. Polymorphic, exactly as the rows are. */
export type PaneTargetKind = 'chat' | 'terminal' | 'page';

/**
 * A pane's binding. Held as one object rather than two loose columns so a
 * half-bound pane — a kind with no id, an id with no kind — cannot be spelled.
 */
export interface PaneTarget {
  kind: PaneTargetKind;
  id: string;
}

/**
 * The workspace's sole structural root. `parentId` is `null` because it is the
 * root, NOT because it is detached — which is exactly why `nodeType` and not a
 * null parent is what distinguishes the two.
 */
export interface RootNode {
  nodeType: 'root';
  id: string;
  parentId: null;
  position: 0;
  axis: NodeAxis;
}

/**
 * A split container. Never detached: a split has no durable target of its own,
 * so a parked one would be garbage rather than a member of anything. Destroying
 * a container takes its subtree with it, so orphaned splits have no way to
 * arise.
 */
export interface SplitNode {
  nodeType: 'split';
  id: string;
  parentId: string;
  position: number;
  axis: NodeAxis;
  /**
   * This node's share of its parent. ABSENT when the parent is unsized (its
   * children split it evenly) — the absence IS the state, never an explicit
   * null, so a tree the algebra built and one rehydrated from rows are
   * byte-identical. Carried over verbatim from the model this replaces.
   */
  fraction?: number;
}

/**
 * A leaf: the thing a user calls a pane. `parentId === null` means DETACHED —
 * in the workspace and in the sidebar, not on screen. `target === null` means
 * unbound: the pane renders the picker.
 */
export interface PaneNode {
  nodeType: 'pane';
  id: string;
  parentId: string | null;
  position: number;
  fraction?: number;
  target: PaneTarget | null;
}

export type WorkspaceNode = RootNode | SplitNode | PaneNode;

/**
 * One node by id. Total: an unknown id is `undefined`, never a throw — a stale
 * click racing a close is not an error, the stance the transitions this
 * replaces already took.
 */
export function findNode(nodes: readonly WorkspaceNode[], id: string): WorkspaceNode | undefined {
  return nodes.find((node) => node.id === id);
}

/**
 * A parent's children, ordered. Total: an id that resolves to nothing has no
 * children, which is not an error — a stale click racing a close must never
 * throw, the same stance the transitions this replaces took.
 *
 * A detached node is a child of nothing, so it can never appear here.
 */
export function childrenOf(nodes: readonly WorkspaceNode[], parentId: string): WorkspaceNode[] {
  return nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.position - b.position);
}

/**
 * The workspace's root, found BY ITS TYPE.
 *
 * The root and a detached pane both carry a null parent, so a null parent is
 * not what identifies either of them. Every reader goes through here rather
 * than re-spelling the rule, because "the node with no parent" is the shape of
 * the bug this model exists to remove.
 */
export function rootOf(nodes: readonly WorkspaceNode[]): RootNode | undefined {
  return nodes.find((node): node is RootNode => node.nodeType === 'root');
}

/**
 * The panes parked outside the tree, ordered — present in the workspace, absent
 * from the grid. Only a pane can be here: a detached split is unspellable
 * (`SplitNode.parentId` is a `string`), which is the type carrying an invariant
 * so the validator does not have to.
 */
export function detachedOf(nodes: readonly WorkspaceNode[]): PaneNode[] {
  return nodes
    .filter((node): node is PaneNode => node.nodeType === 'pane' && node.parentId === null)
    .sort((a, b) => a.position - b.position);
}

/**
 * Everything beneath a node, at any depth. Excludes the node itself, so a
 * caller destroying a subtree passes `[id, ...descendantsOf(nodes, id)]` and
 * says what it means.
 *
 * TOTAL ON CYCLIC INPUT. A flat parent pointer can express a cycle that a
 * nested type could not, and this walk is what `validateTree` uses to FIND
 * one — so it has to terminate on exactly the input that is not yet known to
 * be valid. Visited-tracking, not a depth guard: the answer on a cycle should
 * be every reachable node once, not a truncated prefix.
 */
export function descendantsOf(nodes: readonly WorkspaceNode[], id: string): WorkspaceNode[] {
  const collected: WorkspaceNode[] = [];
  const seen = new Set<string>([id]);
  const queue = [id];
  // Drained by the `undefined` `shift()` actually returns when empty, rather
  // than by a length check plus a cast that asserts what the check implied —
  // this model's whole thesis is that a cast is a lie the type checker vouches
  // for, and the boundary should not spend one on its own loop.
  for (let parentId = queue.shift(); parentId !== undefined; parentId = queue.shift()) {
    for (const child of childrenOf(nodes, parentId)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      collected.push(child);
      queue.push(child.id);
    }
  }
  return collected;
}

/**
 * Apply a set of changed nodes: replace by id where present, append where not.
 *
 * IDEMPOTENT BY CONSTRUCTION, and that is the whole point. The wire's write is
 * `put(nodes[])`, so a retried POST or a duplicate delivery re-applies the same
 * nodes to the same result — which is what makes the `(workspaceId, opId)`
 * idempotency memory the old verb algebra needed unnecessary. That table
 * existed because a replayed `split_right` would re-insert its own minted id
 * and violate the primary key; an upsert simply cannot.
 *
 * Replace-in-place, append-at-end: the order is deterministic, so equal inputs
 * give equal outputs rather than merely equivalent ones.
 */
export function upsertNodes(
  nodes: readonly WorkspaceNode[],
  changed: readonly WorkspaceNode[],
): WorkspaceNode[] {
  const byId = new Map(changed.map((node) => [node.id, node]));
  const replaced = nodes.map((node) => byId.get(node.id) ?? node);
  const present = new Set(nodes.map((node) => node.id));
  return [...replaced, ...changed.filter((node) => !present.has(node.id))];
}

/**
 * Drop the named nodes. Ignores ids that are not there, for the same reason
 * every other helper here is total.
 *
 * Removes ONLY what it is given: a subtree is the caller's to name, as
 * `[id, ...descendantsOf(nodes, id)]`. Making this walk the tree implicitly
 * would hide the difference between detaching a pane and destroying a column.
 */
export function removeNodes(
  nodes: readonly WorkspaceNode[],
  ids: readonly string[],
): WorkspaceNode[] {
  const dropping = new Set(ids);
  return nodes.filter((node) => !dropping.has(node.id));
}

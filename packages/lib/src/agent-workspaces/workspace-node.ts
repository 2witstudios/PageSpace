/**
 * The workspace NODE model — one flat list of nodes in which `parentId`
 * decides visibility and location, and nothing decides membership but presence.
 *
 * **Why flat and not a nested tree.** The rows are flat and the wire is flat,
 * so the canonical in-memory form is flat too: one list, one translation, no
 * shape that fights its own storage. Nesting is derived for rendering.
 *
 * The price is that a flat parent pointer can express a cycle, which a nested
 * type cannot. That is paid once, deliberately, in `validateTree` — the single
 * function every write path runs.
 *
 * **THERE IS ONE PLACE A NODE CAN BE, AND IT IS UNDER ITS PARENT.** An earlier
 * cut of this model gave a non-root node a nullable `parentId` and called it
 * DETACHED — in the workspace, off the screen — which was the very split this
 * model exists to delete, rebuilt at the bottom of the tree. Two consequences
 * made it untenable and both are worth stating, because nothing else in the
 * file records them:
 *
 *  - A permanent population of parentless nodes existed BY DESIGN, so a node
 *    that lost its parent through a genuine defect was indistinguishable from
 *    one a user had closed. In the sibling system where this failure was
 *    actually observed (PurePoint), panes restructuring to top level was
 *    corruption — detectable precisely because it was never legal.
 *  - `validateTree` could reject a DANGLING parent (an id that resolves to
 *    nothing) but never a NULL one, because null was legal. Half the failure
 *    shape was invisible to the one function every write path runs.
 *
 * So `parentId` is a `string` on everything except {@link RootNode}, whose null
 * is a consequence of being the root — which `nodeType` already says.
 *
 * **Why a discriminated union.** Everything a `nodeType` can rule out is ruled
 * out here rather than in the validator: a root cannot carry a parent, a
 * non-root cannot lack one, and a pane cannot carry an axis. `validateTree` is
 * then left with exactly the invariants a type cannot state — one root, no
 * cycles, no dangling parent, depth and count caps, fractions that settle — plus
 * the one a type states in memory and a ROW can still break, which is why
 * `null_parent` is a violation code and not merely a compile error.
 *
 * **Why `position` and not `orderIndex`.** PageSpace already has a tree — the
 * page tree — and it already names this field `position` (`pages.position` in
 * `packages/db/src/schema/core.ts`). More to the point, the repo already has a
 * GENERIC builder in `packages/lib/src/content/tree-utils.ts`:
 *
 *     buildTree<T extends { id: string; parentId: string | null; position?: number }>
 *
 * Under that name a `WorkspaceNode` satisfies the constraint STRUCTURALLY, so
 * the kinship with the page tree is visible in the types instead of being
 * something a reader has to notice. One concept called two names in one
 * codebase is the drift this model exists to remove.
 *
 * **Why it stays a contiguous integer.** Deliberately NOT pages' fractional
 * `real` positioning. Sibling groups here are tiny, so renumbering is
 * O(siblings) inside the same locked transaction that made the edit — and
 * contiguity is an invariant `validateTree` can assert, which is exactly what
 * fractional ordering gives up in exchange for avoiding a renumbering cost
 * this model does not have.
 *
 * Successor to the two-level `columns[].panes[]` model, which spelled the same
 * field `orderIndex`. That model and its tables are deleted; this is the only
 * ordering in the domain.
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
 * The workspace's sole structural root, and THE ONLY NODE THAT CARRIES A NULL
 * PARENT. It carries one because it is the root — which `nodeType` already
 * says, so the null is a consequence and never a definition. Every reader finds
 * the root through {@link rootOf}, by type.
 */
export interface RootNode {
  nodeType: 'root';
  id: string;
  parentId: null;
  position: 0;
  axis: NodeAxis;
}

/**
 * A split container. Destroying one takes its subtree with it, so an orphaned
 * split has no way to arise.
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
   * null, so a tree the algebra built and one rehydrated from rows agree on
   * which keys are there and not merely on what they render as. Key ORDER is
   * not part of that agreement; see `workspace-node-rows.ts`. Carried over
   * verbatim from the model this replaces.
   */
  fraction?: number;
}

/**
 * A leaf: the thing a user calls a pane. `target === null` means unbound — the
 * pane renders the picker.
 *
 * `parentId` is a `string`, so a pane is always somewhere. Closing one is a
 * {@link destroy}, not a move to nowhere, and "in the workspace but off the
 * screen" is a state this model deliberately cannot spell.
 */
export interface PaneNode {
  nodeType: 'pane';
  id: string;
  parentId: string;
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
 */
export function childrenOf(nodes: readonly WorkspaceNode[], parentId: string): WorkspaceNode[] {
  return nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.position - b.position);
}

/**
 * The workspace's root, found BY ITS TYPE and never by "the node with no
 * parent".
 *
 * Those two now select the same node, and this function still exists because
 * they are not the same STATEMENT. `nodeType` is what a row asserts and what
 * the union discriminates on; a null parent is a consequence of it. A reader
 * that went looking for the null would be re-deriving the rule from its
 * side-effect — which is how a null parent came to mean two things the last
 * time, and the reason the parse re-establishes the agreement rather than
 * trusting either column alone.
 */
export function rootOf(nodes: readonly WorkspaceNode[]): RootNode | undefined {
  return nodes.find((node): node is RootNode => node.nodeType === 'root');
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
 * would put the cascade somewhere a reader of `destroy` cannot see it — and
 * `destroy` is the one removal, so what it takes has to be visible at its call
 * site rather than inside a helper's mood.
 */
export function removeNodes(
  nodes: readonly WorkspaceNode[],
  ids: readonly string[],
): WorkspaceNode[] {
  const dropping = new Set(ids);
  return nodes.filter((node) => !dropping.has(node.id));
}

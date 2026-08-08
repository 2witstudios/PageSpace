/**
 * The workspace node model's DB boundary: rows ⟷ nodes.
 *
 * **Why the translation is a parse, not a cast.** A row is nine flat, mostly
 * nullable columns; a `WorkspaceNode` is a discriminated union in which those
 * same columns are either required or unspellable. The columns can therefore
 * say things the union cannot — a root with a parent, a split with no axis, a
 * pane holding half a binding — and a cast would carry every one of them into
 * the model as a lie the type checker then vouches for. So the union's
 * invariants are re-established HERE, at the one place untyped storage becomes
 * a node, rather than trusted from the column types.
 *
 * **Why absence is preserved exactly.** `fraction` on the node side is optional
 * and its absence IS a state ("my parent is unsized"), never an explicit null.
 * A node rehydrated from rows must be byte-identical to the one the algebra
 * built, because the client holds the algebra's version optimistically while
 * the server holds the rehydrated one: any difference — `{}` vs
 * `{fraction: null}` vs `{fraction: undefined}` — makes every write look like a
 * change and puts the two planes permanently out of step. The same holds for
 * `axis` on a pane and `target` on an unbound pane, which is why those columns
 * are dropped rather than nulled through.
 *
 * **Why `rootId` is not on the node, and what that costs.** It scopes a row to
 * its workspace; it says nothing about the node's identity or shape, and no
 * reader of a node list needs it, because the list IS one workspace's. That is
 * what makes cross-workspace parenting unspellable rather than merely unlikely
 * — a pane cannot restructure itself into another session if no node can name
 * one. The cost is that the scope has to be enforced at exactly this boundary,
 * which is one of only two places a node's workspace can change: `rowFromNode`
 * is told which workspace it writes into and never infers it, and
 * `nodesFromRows` is told which workspace it read and rejects any row that
 * disagrees. Whether `rootId` agrees with the root node's own id is a different
 * question — a fact about a SET of rows, and so `validateTree`'s territory
 * alongside the other cross-row invariants.
 *
 * This module defines the row SHAPE and its translation only. The Drizzle table
 * is a later phase's; when it lands, its column types are the mirror of
 * {@link WorkspaceNodeRow}.
 */

import { z } from 'zod';
import {
  childrenOf,
  detachedOf,
  rootOf,
  type NodeAxis,
  type PaneNode,
  type PaneTargetKind,
  type WorkspaceNode,
} from './workspace-node';

/**
 * One persisted node: flat, nullable where the union is optional, and carrying
 * `nodeType` as the discriminator that says which of the nullable columns are
 * meaningful.
 *
 * Written out rather than inferred from the schema below. The schema carries
 * transforms, and `z.infer` through a transform degrades to `any` at a consumer
 * reading this package's emitted `.d.ts` — the same trap
 * `workspace-layout-wire.ts` documents.
 */
export interface WorkspaceNodeRow {
  id: string;
  /** The workspace this row belongs to. Scoping only — never part of the node. */
  rootId: string;
  /** `null` is the root OR a detached pane; `nodeType` is what tells them apart. */
  parentId: string | null;
  orderIndex: number;
  nodeType: WorkspaceNode['nodeType'];
  /** Containers only. Null on a pane. */
  axis: NodeAxis | null;
  /** Null means unsized — the absence the node side spells by omitting the key. */
  fraction: number | null;
  /** Bound panes only, and only ever null or non-null TOGETHER with `targetId`. */
  targetKind: PaneTargetKind | null;
  targetId: string | null;
}

const nodeAxisSchema = z.enum(['row', 'column']);
const paneTargetKindSchema = z.enum(['chat', 'terminal', 'page']);

/**
 * Every column a given `nodeType` must NOT carry is pinned to `z.null()` rather
 * than merely ignored, so a row that contradicts its own type is rejected
 * instead of silently losing the contradictory value. That rejection is the
 * point: such a row means a writer bypassed this module, and reading it as if
 * it were fine is how the two structures this model replaces drifted apart.
 *
 * `rootId` is absent from every member — zod strips it, which is exactly the
 * "not part of the node" rule stated in the module docblock.
 *
 * Fractions are not range-checked here. Whether a container's children sum to
 * one is a property of a SET of rows, so it settles in `validateTree`; a single
 * row cannot know.
 */
const workspaceNodeFromRowSchema = z.discriminatedUnion('nodeType', [
  z
    .object({
      nodeType: z.literal('root'),
      id: z.string().min(1),
      // Not "the node with no parent" — a detached pane has none either. The
      // root is the row whose TYPE says so, and its null parent is then a
      // consequence the schema insists on rather than a definition.
      parentId: z.null(),
      orderIndex: z.literal(0),
      axis: nodeAxisSchema,
      fraction: z.null(),
      targetKind: z.null(),
      targetId: z.null(),
    })
    .transform(({ id, axis }) => ({ nodeType: 'root' as const, id, parentId: null, orderIndex: 0 as const, axis })),
  z
    .object({
      nodeType: z.literal('split'),
      id: z.string().min(1),
      /** Never null: a split has no durable target, so a parked one is garbage. */
      parentId: z.string().min(1),
      orderIndex: z.number().int(),
      axis: nodeAxisSchema,
      fraction: z.number().nullable(),
      targetKind: z.null(),
      targetId: z.null(),
    })
    .transform(({ id, parentId, orderIndex, axis, fraction }) => ({
      nodeType: 'split' as const,
      id,
      parentId,
      orderIndex,
      axis,
      ...(fraction === null ? {} : { fraction }),
    })),
  z
    .object({
      nodeType: z.literal('pane'),
      id: z.string().min(1),
      /** Null here means DETACHED — in the workspace, off the screen. */
      parentId: z.string().min(1).nullable(),
      orderIndex: z.number().int(),
      axis: z.null(),
      fraction: z.number().nullable(),
      targetKind: paneTargetKindSchema.nullable(),
      targetId: z.string().min(1).nullable(),
    })
    // Two columns, one value: the pair is the binding, so half of it is not a
    // partially-bound pane but a corrupt one. `PaneTarget` exists precisely so
    // the half-bound state is unspellable once the row is past this line.
    .refine((row) => (row.targetKind === null) === (row.targetId === null), {
      message: 'a pane target needs both a kind and an id, or neither',
    })
    .transform(({ id, parentId, orderIndex, fraction, targetKind, targetId }) => ({
      nodeType: 'pane' as const,
      id,
      parentId,
      orderIndex,
      ...(fraction === null ? {} : { fraction }),
      target: targetKind === null || targetId === null ? null : { kind: targetKind, id: targetId },
    })),
]);

/**
 * Read one persisted row as a node, or throw.
 *
 * Throws rather than returning a null/result, because there is no sensible
 * degraded reading of a contradictory row: dropping it silently would delete
 * someone's pane, and keeping it would hand the renderer a node whose type is
 * a lie. Reading a whole workspace goes through {@link nodesFromRows}, which
 * adds the scope check this one cannot make from a single row.
 *
 * Takes an already-typed row: the column types are the type checker's job, and
 * what this adds is the `nodeType` agreement a column type cannot state.
 */
export function nodeFromRow(row: WorkspaceNodeRow): WorkspaceNode {
  return workspaceNodeFromRowSchema.parse(row);
}

/**
 * Read one workspace's rows as its node list — the READ path, and the only one
 * that should be used for a whole workspace.
 *
 * **`rootId` is required, and every row must match it.** A node deliberately
 * carries no workspace: a node list IS one workspace's list, which is what
 * makes cross-workspace parenting unspellable in the model rather than merely
 * unlikely. That guarantee is worth exactly as much as this check — the
 * translation is one of only two places a node's workspace can change, so a
 * mixed set is refused here or it is never refused at all.
 *
 * **Rejects, never filters.** Dropping the foreign rows would be two bugs at
 * once: it hides a corrupt read (a query joined wrong, a cache keyed wrong) and
 * it silently deletes panes from the rendered workspace, which is
 * indistinguishable from the user having closed them. The same goes for a
 * single row that contradicts its own type — a partial workspace is a lie about
 * what the user has, so the whole read fails and says why.
 */
export function nodesFromRows(rows: readonly WorkspaceNodeRow[], rootId: string): WorkspaceNode[] {
  const foreign = rows.find((row) => row.rootId !== rootId);
  if (foreign !== undefined) {
    throw new Error(
      `workspace node rows: expected rows for workspace ${rootId}, but row ${foreign.id} belongs to ${foreign.rootId}`,
    );
  }
  return rows.map((row) => nodeFromRow(row));
}

/**
 * Write a node as a persisted row — the exact inverse of {@link nodeFromRow},
 * which the property suite next door pins over generated lists.
 *
 * `rootId` is a parameter because the node does not carry it: the caller is
 * writing INTO a known workspace and is the only one who knows which.
 *
 * Total, and needs no validation of its own: every contradiction the parse
 * rejects is one the union already made unspellable, so there is nothing here
 * that could be wrong.
 */
export function rowFromNode(node: WorkspaceNode, rootId: string): WorkspaceNodeRow {
  const scope = { id: node.id, rootId, orderIndex: node.orderIndex };
  switch (node.nodeType) {
    case 'root':
      return {
        ...scope,
        nodeType: 'root',
        parentId: null,
        axis: node.axis,
        fraction: null,
        targetKind: null,
        targetId: null,
      };
    case 'split':
      return {
        ...scope,
        nodeType: 'split',
        parentId: node.parentId,
        axis: node.axis,
        // `??`, never `||`: zero is a legal share, and a falsy check would
        // unsize the container on every save.
        fraction: node.fraction ?? null,
        targetKind: null,
        targetId: null,
      };
    case 'pane':
      return {
        ...scope,
        nodeType: 'pane',
        parentId: node.parentId,
        axis: null,
        fraction: node.fraction ?? null,
        // Both columns move together or neither does — the binding is one
        // value, and splitting it across two columns is the only reason the
        // half-bound state is representable in storage at all.
        targetKind: node.target === null ? null : node.target.kind,
        targetId: node.target === null ? null : node.target.id,
      };
  }
}

/**
 * One node with its children beneath it — the nesting a recursive renderer
 * walks, derived from the flat list and owned by nobody.
 */
export interface RenderNode {
  node: WorkspaceNode;
  children: RenderNode[];
}

/**
 * What a workspace draws: one tree, and the panes that are in the workspace but
 * not in it.
 *
 * SEPARATE FIELDS ON PURPOSE. A detached pane is a member of the workspace with
 * no place in the layout, so a projection that returned only the tree would
 * leave "and also render the parked ones" as something every caller has to
 * remember — which is how a pane came to take two minutes to appear in the
 * sidebar in the first place. Here the sidebar's list is handed over with the
 * grid, from the same single pass over the same single list, and the three
 * fields partition the input exactly: every node is in one of them.
 */
export interface RenderTree {
  /** `null` when the list has no root — a workspace mid-hydration draws nothing. */
  root: RenderNode | null;
  /** In the workspace, off the grid. Ordered, because the sidebar lists them. */
  detached: PaneNode[];
  /**
   * Nodes that claim a parent the list cannot resolve. Reported, never
   * repaired: re-parenting one onto the root would put a pane somewhere the
   * user never placed it, and a projection has no business inventing a
   * location. Empty for every well-formed workspace — a non-empty list means
   * the read or the write that produced it is broken, and the point of
   * surfacing it is that this is visible instead of merely plausible.
   */
  orphaned: WorkspaceNode[];
}

/**
 * Derive the render tree from the flat list. ONE-WAY BY NATURE: the list stays
 * canonical and every write goes to it, so there is deliberately no inverse
 * here — a tree that could be written back would be a second source of truth,
 * which is the whole disease.
 *
 * Total on any list, including one no validator has seen. The visited set is
 * for a duplicated id specifically: a repeated id makes one parent pointer
 * resolve to two rows and lets the descent re-enter what it just left. (A pure
 * parent-pointer CYCLE cannot be reached from here — every node in one has an
 * ancestor chain that never arrives at the root — so unlike `descendantsOf`,
 * which starts anywhere, that is not the case being guarded.)
 */
export function buildRenderTree(nodes: readonly WorkspaceNode[]): RenderTree {
  const seen = new Set<string>();
  // Membership of the two lists is tracked by IDENTITY, not by id: with a
  // duplicated id, "which node did I render" is a question ids cannot answer,
  // and the answer decides whether a node is reported as orphaned or lost.
  const placed = new Set<WorkspaceNode>();

  const descend = (node: WorkspaceNode): RenderNode => {
    seen.add(node.id);
    placed.add(node);
    const children: RenderNode[] = [];
    for (const child of childrenOf(nodes, node.id)) {
      if (seen.has(child.id)) continue;
      children.push(descend(child));
    }
    return { node, children };
  };

  // Found by TYPE, never by "the node with no parent" — a detached pane has no
  // parent either, and conflating the two is the bug this model deletes.
  const root = rootOf(nodes);
  const rendered = root === undefined ? null : descend(root);

  const detached = detachedOf(nodes);
  for (const pane of detached) placed.add(pane);

  return { root: rendered, detached, orphaned: nodes.filter((node) => !placed.has(node)) };
}

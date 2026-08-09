/**
 * THE COMMANDS — `split`, `openConversation`, `openPage`,
 * `replaceConversation`, `closePane`.
 *
 * This is the layer where the UI's vocabulary is allowed to live, and it is the
 * only one. Underneath it there are exactly two others: `put(nodes[])` /
 * `drop(ids[])` at a `baseRev` on the wire, and the five operations of
 * `workspace-node-algebra.ts` — `create`, `move`, `bind`, `resize`, `destroy` —
 * which describe THE DATA MODEL. The twelve wire verbs this replaces had no
 * such separation, which is why that reducer reads like a description of the
 * toolbar: every ergonomic gesture was treated as a fundamental one.
 *
 * `split` is the clearest case. Structurally it is *insert container →
 * reparent the existing pane → insert a sibling*, three edits to the data that
 * the UI happens to call one gesture. It belongs here for exactly the reason
 * `open_conversation` did: it is a shape a toolbar wants, not a fact about the
 * data. So does the choice of WHERE something opens, which is policy about
 * users (do not evict a running shell, do not let an agent eat its own
 * invoker) and not a property of a tree.
 *
 * **A command is atomic.** It either produces a write whose result satisfies
 * `validateTree`, or it produces a rejection and writes NOTHING. There is no
 * partial command: a `split` that staged its container and then lost the pane
 * that fills it would hand the caller a split holding one child.
 *
 * **A command compiles to the algebra; it does not touch node rows.** It has
 * no `parentId` assignment of its own on any failure path — the count is zero,
 * and it must stay zero. An unresolvable node or parent is a REFUSED command,
 * never a node quietly re-attached to the root. That fallback is how a pane
 * ends up restructured into a session the user never put it in, and a caller
 * holding a stale snapshot needs to be told to rebase instead.
 *
 * There is one exception to the sentence above, and it is a gap in the layer
 * below rather than a liberty taken here: {@link create} mints only PANES, so
 * the container `split` inserts is the single node in this file built by hand.
 * See {@link stageContainer}.
 *
 * **There is no "attach" here either.** A node's location is one column and
 * `move` is the only thing that changes it: "opening" a pane is a move to
 * somewhere visible and "closing" one is a move to no parent. `detachedOf`
 * asks where a node is; it performs nothing. Attach is the vocabulary of
 * joining two independently existing systems, and having two systems to join
 * is the bug this epic deletes.
 */
import {
  applyNodeWrite,
  bind,
  create,
  move,
  type NodeOperationCode,
  type NodeOperationResult,
  type NodeWrite,
} from './workspace-node-algebra';
import {
  childrenOf,
  detachedOf,
  findNode,
  rootOf,
  type NodeAxis,
  type PaneNode,
  type PaneTarget,
  type PaneTargetKind,
  type SplitNode,
  type WorkspaceNode,
} from './workspace-node';

/**
 * Why a command was refused.
 *
 * A superset of {@link NodeOperationCode}, which is itself a superset of the
 * validator's codes — the same widening at each layer, so a caller handles ONE
 * result type no matter how deep the refusal came from. Only one condition is
 * new at this layer: every command here operates on the GRID, and a pane that
 * is parked is in the workspace without being in the grid. That is a state the
 * operations below have no opinion about and a command must refuse.
 */
export type CommandCode = NodeOperationCode | 'detached_pane';

/** Mirrors {@link NodeOperationResult} deliberately: a command and an operation are interchangeable. */
export type CommandResult =
  | { ok: true; write: NodeWrite }
  | { ok: false; code: CommandCode; detail: string };

function refuse(code: CommandCode, detail: string): CommandResult {
  return { ok: false, code, detail };
}

/** One edit in a compiled command, applied to whatever the edits before it produced. */
export type Step = (nodes: readonly WorkspaceNode[]) => NodeOperationResult;

/**
 * Run a command's operations in order and return ONE write for all of them.
 *
 * **The atomicity is here.** A step that is refused ends the command with that
 * refusal and no write at all, so a caller either applies every edit or none.
 * The rejection is returned verbatim rather than re-worded: a command adds
 * policy, not a second vocabulary for the same failure, and a caller rebasing
 * on `unknown_parent` needs the code the operation actually produced.
 *
 * The composite is the UNION of what the steps said they were writing — a put
 * supersedes an earlier put or drop of the same id, and a drop supersedes an
 * earlier put — rather than a fresh diff against the original tree. That is the
 * honest composition of writes the algebra produced, but it is not the minimal
 * one: a sibling an early step renumbered and a later step renumbered back
 * still appears in `put`. Deriving the minimal write would need the algebra's
 * own `writeBetween`, which is private to it. Harmless (the wire's `put` is an
 * upsert, so re-writing an unchanged row changes nothing), and noted in the
 * report rather than papered over with a second definition of "same node".
 *
 * A drop of an id the caller never had is discarded: a node minted by one step
 * and removed by a later one never existed as far as the caller is concerned.
 *
 * EXPORTED, because atomicity is not a property only the five commands need. An
 * agent's "reorder these four containers" is four `move`s and exactly one write:
 * a caller that applied them as four writes would publish three intermediate
 * trees nobody asked for, and would leave the grid half-rearranged if the third
 * were refused. The alternative — a second composer beside this one — is the
 * duplication this epic exists to remove.
 */
export function compile(nodes: readonly WorkspaceNode[], steps: readonly Step[]): CommandResult {
  const put = new Map<string, WorkspaceNode>();
  const drop = new Set<string>();
  let current: readonly WorkspaceNode[] = nodes;

  for (const step of steps) {
    const result = step(current);
    if (!result.ok) return result;
    for (const id of result.write.drop) {
      put.delete(id);
      drop.add(id);
    }
    for (const node of result.write.put) {
      drop.delete(node.id);
      put.set(node.id, node);
    }
    current = applyNodeWrite(current, result.write);
  }

  const present = new Set(nodes.map((node) => node.id));
  return {
    ok: true,
    write: { put: [...put.values()], drop: [...drop].filter((id) => present.has(id)) },
  };
}

/** A step that writes exactly what it is given, for the one edit the algebra cannot express. */
function staged(write: NodeWrite): Step {
  return () => ({ ok: true, write });
}

/**
 * The slot at the end of the parked group, with `nodeId` not counted among it.
 *
 * Leaving the grid is an arrival like any other, and it arrives LAST: the
 * sidebar's order is then the order things left. Discounting the node itself is
 * what makes a re-sent close write nothing — `move` measures its destination
 * with the mover removed, so a pane already parked at the end lands back where
 * it was.
 */
function parkedSlot(nodes: readonly WorkspaceNode[], nodeId: string): number {
  return detachedOf(nodes).filter((parked) => parked.id !== nodeId).length;
}

// ---------------------------------------------------------------------------
// split
// ---------------------------------------------------------------------------

/**
 * What `split` inserts. Both ids come from the CALLER, like every id in this
 * model: the client mints them so it can apply the write optimistically
 * without a round trip to learn what it just drew.
 */
export interface SplitInput {
  /** The pane being split. It keeps its identity and its binding; only its parent changes. */
  nodeId: string;
  /** The new container's direction — `row` beside, `column` below. */
  axis: NodeAxis;
  /** The new, UNBOUND pane that lands beside it. */
  newNodeId: string;
  /** The container that takes the split pane's place. */
  newSplitId: string;
}

/**
 * Stage the container: it takes the pane's slot, and the pane moves under it.
 *
 * **THE ONE HAND-BUILT WRITE IN THIS FILE, and it is a gap in the algebra
 * rather than a liberty taken here.** `create` mints panes and nothing else
 * (`CreateInput` carries a `PaneTarget | null`, and it returns a `PaneNode`),
 * so there is no operation that can bring a container into being — which is
 * reported rather than worked around by editing the algebra from this layer.
 *
 * It is also unstageable as a sequence of operations, whatever the order. Every
 * operation validates the tree it produces, a split holding fewer than two
 * children is `degenerate_split`, and a container is born holding none — so
 * "insert the container" and "put something in it" cannot be two accepted
 * operations. They are ONE edit, and this is its first half: the second is the
 * `create` in {@link splitInto}, which validates the whole result. Nothing
 * observes the transient one-child tree in between, because `compile` returns
 * a single write.
 *
 * The container inherits the pane's slot AND its share, so the parent group
 * neither renumbers nor re-sums. The pane arrives as an only child and is
 * stripped of its share on the way: a lone member owns its whole container, and
 * a stored share there would make a container nobody sized look sized.
 */
function stageContainer(pane: PaneNode, parentId: string, input: SplitInput): NodeWrite {
  const { fraction: _inherited, ...unsized } = pane;
  const container: SplitNode = {
    nodeType: 'split',
    id: input.newSplitId,
    parentId,
    position: pane.position,
    axis: input.axis,
    ...(pane.fraction === undefined ? {} : { fraction: pane.fraction }),
  };
  return { put: [container, { ...unsized, parentId: input.newSplitId, position: 0 }], drop: [] };
}

/**
 * The compiled split, with the new pane's binding left to the caller: `split`
 * leaves it unbound so the pane renders its picker, and the open commands mint
 * it already showing what they were asked to show.
 *
 * Binding at the MINT rather than after it is the whole reason `create` carries
 * a target: a create-then-bind pair has a moment where the first landed and the
 * second did not, and that moment is the state production is in today.
 */
function splitInto(
  nodes: readonly WorkspaceNode[],
  input: SplitInput,
  target: PaneTarget | null,
): CommandResult {
  const node = findNode(nodes, input.nodeId);
  if (node === undefined) return refuse('unknown_node', `no node "${input.nodeId}" to split`);
  if (node.nodeType === 'root') {
    return refuse('root_immutable', `node "${input.nodeId}" is the root; the workspace is not a pane in itself`);
  }
  if (node.nodeType !== 'pane') {
    return refuse('not_a_pane', `node "${input.nodeId}" is a split; a split divides space rather than occupying it`);
  }
  // A parked pane is in the workspace and not in the grid, so there is no
  // container for a new one to sit in — and `SplitNode.parentId` is a `string`,
  // which makes a parked container unspellable. There is nothing to repair this
  // into; showing the pane first is a `move` the caller makes deliberately.
  if (node.parentId === null) {
    return refuse('detached_pane', `pane "${input.nodeId}" is parked, so there is no container for a split to divide`);
  }
  // `create` catches a `newNodeId` the workspace already holds; the container's
  // id has no operation to catch it, and an id already in the set would be
  // UPSERTED over its sitting node rather than minted beside it.
  if (findNode(nodes, input.newSplitId) !== undefined) {
    return refuse('duplicate_id', `the workspace already holds a node "${input.newSplitId}"`);
  }
  if (input.newSplitId === input.newNodeId) {
    return refuse('duplicate_id', `the container and the pane cannot both be "${input.newNodeId}"`);
  }

  return compile(nodes, [
    staged(stageContainer(node, node.parentId, input)),
    // The `create` that completes the container is also what VALIDATES it: the
    // staged half above passed through no gate, so every invariant of the
    // result — the depth the new nesting reaches, the node cap, the shares of
    // the group the pane left — is settled right here or not at all.
    (staging) => create(staging, { nodeId: input.newNodeId, target, parentId: input.newSplitId, index: 1 }),
  ]);
}

/**
 * Split a pane: give it a sibling by putting a container where it was.
 *
 * Replaces `split_right` and `split_down`, which differed by an axis and
 * nothing else — one of the clearest cases of the old model spending a verb on
 * a rendering direction.
 *
 * The new pane arrives UNBOUND, rendering its picker. It is a rectangle the
 * user has not yet said anything about, and minting it bound to something would
 * be the toolbar deciding what the user meant.
 *
 * It always NESTS, even when the pane's parent already runs along the requested
 * axis — where `split_down` appended to the existing column instead. That is a
 * deliberate consequence of compiling one gesture into the data model's own
 * terms, and it is why the depth cap is reachable by repeating one gesture; see
 * the report.
 */
export function split(nodes: readonly WorkspaceNode[], input: SplitInput): CommandResult {
  return splitInto(nodes, input, null);
}

// ---------------------------------------------------------------------------
// closePane
// ---------------------------------------------------------------------------

/** Which pane leaves the grid. */
export interface ClosePaneInput {
  nodeId: string;
}

/**
 * Close a pane: take it out of the grid, and leave it in the workspace.
 *
 * **A `move` to no parent, never a `destroy`.** The node keeps its identity and
 * its binding, stays a member of the workspace and keeps appearing in the
 * sidebar; only its location changes. "Closed" and "parked" were two different
 * structures in the model this replaces — `close_pane` deleted the pane and a
 * conversation reachable nowhere else went with it — and collapsing them into
 * one location is the whole point of the flat model.
 *
 * **Closing the LAST pane leaves an empty grid and does not end the workspace.**
 * A deliberate behaviour change: that decision used to live half in the reducer
 * (which no-oped on the last pane, because a two-level grid could not represent
 * zero) and half in browser code that ended the session. `validateTree` is
 * explicit that a root holding nothing is an ordinary state, and ending a
 * workspace is an explicit lifecycle act elsewhere.
 *
 * A split left holding one child collapses, because `move` collapses it — not
 * because this command noticed. A pane already out of the grid writes nothing.
 */
export function closePane(nodes: readonly WorkspaceNode[], input: ClosePaneInput): CommandResult {
  return compile(nodes, [
    (current) =>
      move(current, { nodeId: input.nodeId, parentId: null, index: parkedSlot(current, input.nodeId) }),
  ]);
}

// ---------------------------------------------------------------------------
// replaceConversation
// ---------------------------------------------------------------------------

/** Which pane is being swapped out, and what should be in its place. */
export interface ReplaceConversationInput {
  /** The pane in the grid whose slot is being taken. */
  nodeId: string;
  /**
   * What should show there. Addressed by TARGET rather than by node id because
   * that is how a caller thinks about it — "show me this conversation here" —
   * and this is the layer where the caller's vocabulary is allowed to live.
   */
  target: PaneTarget;
}

/** The node showing this target, if the workspace holds one. Kind and id both, so id spaces cannot collide. */
function nodeShowing(nodes: readonly WorkspaceNode[], target: PaneTarget): PaneNode | undefined {
  return nodes.find(
    (node): node is PaneNode =>
      node.nodeType === 'pane' && node.target?.kind === target.kind && node.target.id === target.id,
  );
}

/**
 * Swap what a pane displays.
 *
 * **TWO MOVES, NEVER A REBIND.** A bound node's target is fixed for the whole
 * of its life — `bind` refuses to re-point one, and that refusal is the design
 * rather than an omission. So this does not change what a rectangle shows; it
 * changes which node occupies the slot. The displaced node moves to no parent,
 * which leaves it a member of the workspace and in the sidebar, and the node
 * already showing the target moves in.
 *
 * That is what keeps "this pane" and "this conversation" separable. A pane that
 * could be re-pointed is the same object as its conversation, and then closing
 * a view reads as discarding what it showed.
 *
 * It follows that this command can only move in a node the workspace ALREADY
 * holds: ids are minted by the caller, and this one is given none to mint a
 * replacement with. A target nothing shows is a rejection, not a create.
 *
 * The replacement arrives BEFORE the displaced node leaves, so no intermediate
 * ever has a hole in it — in particular a two-child split does not momentarily
 * drop to one and collapse under the very command that was refilling it.
 */
export function replaceConversation(
  nodes: readonly WorkspaceNode[],
  input: ReplaceConversationInput,
): CommandResult {
  const { nodeId, target } = input;

  const displaced = findNode(nodes, nodeId);
  if (displaced === undefined) return refuse('unknown_node', `no node "${nodeId}" to replace what is in`);
  if (displaced.nodeType === 'root') {
    return refuse('root_immutable', `node "${nodeId}" is the root, which shows nothing of its own`);
  }
  if (displaced.nodeType !== 'pane') {
    return refuse('not_a_pane', `node "${nodeId}" is a split; only a pane is a viewport onto anything`);
  }
  const parentId = displaced.parentId;
  if (parentId === null) {
    return refuse('detached_pane', `pane "${nodeId}" is parked, so there is nothing displayed there to swap`);
  }

  const replacement = nodeShowing(nodes, target);
  if (replacement === undefined) {
    return refuse(
      'invalid_target',
      `no node shows ${target.kind} "${target.id}"; a replacement is moved in, never minted`,
    );
  }
  // Already there. A re-sent request must not bump a rev or broadcast, and the
  // two moves below would not survive it anyway: the same node cannot both
  // arrive in a slot and vacate it.
  if (replacement.id === nodeId) return { ok: true, write: { put: [], drop: [] } };

  // Immediately after the pane it displaces, so that once that pane leaves the
  // replacement is standing exactly where it stood. Measured with the
  // replacement itself taken out, because that is the group `move` will index
  // into when the replacement is already a member of it.
  const group = childrenOf(nodes, parentId).filter((sibling) => sibling.id !== replacement.id);
  const index = group.findIndex((sibling) => sibling.id === nodeId) + 1;

  return compile(nodes, [
    (current) => move(current, { nodeId: replacement.id, parentId, index }),
    // Indexed against the tree the arrival produced, not against the original.
    (current) => move(current, { nodeId, parentId: null, index: parkedSlot(current, nodeId) }),
  ]);
}

// ---------------------------------------------------------------------------
// openConversation / openPage — the placement policy
// ---------------------------------------------------------------------------

/**
 * What "show me this" needs to know beyond the thing itself.
 *
 * Generic in the target's KIND so `openConversation` cannot be handed a page
 * and `openPage` cannot be handed a conversation. Both run the identical
 * policy — the difference is only which caller is asking, which is exactly the
 * kind of distinction this layer exists to carry.
 */
export interface OpenInput<Kind extends PaneTargetKind> {
  /** The thing to show. */
  target: { kind: Kind; id: string };
  /** The pane minted if nothing suitable is already open. */
  newNodeId: string;
  /** The container minted if the placement has to split. */
  newSplitId: string;
  /** The split's direction when it comes to that. Defaults to `row` — beside, as `split_right` was. */
  axis?: NodeAxis;
  /**
   * Where the user is looking. A PREFERENCE and never the subject of the
   * command: it is supplied by the caller because focus is client-local and no
   * row carries it, and one that does not resolve is simply not honoured.
   */
  activeNodeId?: string;
  /** An agent ADDS a surface: with this set, only an unbound pane may be filled. */
  preferSplit?: boolean;
  /** The invoking conversation. Its pane is never a candidate — a tool call must not eat its own invoker. */
  excludeTargetId?: string;
  /**
   * The caller's OWN refusals, ANDed with the shared ones. The client refuses to
   * evict a pane with unsaved edits or one showing a page; the server cannot see
   * either fact. Shared structure here, caller-specific refusals injected.
   */
  isReplaceable?: (pane: PaneNode) => boolean;
}

export type OpenConversationInput = OpenInput<'chat'>;
export type OpenPageInput = OpenInput<'page'>;

/** A pane that is IN the grid. The type states what {@link gridPanes} guarantees, so no reader re-checks. */
type GridPane = PaneNode & { parentId: string };

function isGridPane(node: WorkspaceNode): node is GridPane {
  return node.nodeType === 'pane' && node.parentId !== null;
}

/**
 * The grid's panes in RENDER order — depth first from the root, which is the
 * order a reader's eye takes and the order `panesOf` produced when the model
 * was two levels deep and the distinction could not arise.
 *
 * Total on cyclic input, like every other walk over this model: a flat parent
 * pointer can express a cycle, and placement runs before the write that would
 * have rejected one.
 */
function gridPanes(nodes: readonly WorkspaceNode[]): GridPane[] {
  const root = rootOf(nodes);
  if (root === undefined) return [];
  const panes: GridPane[] = [];
  const seen = new Set<string>([root.id]);
  const walk = (parentId: string): void => {
    for (const child of childrenOf(nodes, parentId)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (isGridPane(child)) panes.push(child);
      else if (child.nodeType === 'split') walk(child.id);
    }
  };
  walk(root.id);
  return panes;
}

/**
 * The SHARED half of the replaceable predicate: an unbound pane, or one showing
 * something that is not a running shell. A terminal is never evictable — the
 * PTY loses its only surface and there is no reattach UI.
 *
 * The old predicate carried a third clause, `scope.targetId !== null`, for a
 * pane whose mint was still in flight. That state is UNSPELLABLE here: a node
 * is bound or it is not, and `PaneTarget.id` is a string. The bug it guarded
 * (a server placement racing the picker into a second pane) cannot be written.
 */
function isReplaceablePane(pane: PaneNode): boolean {
  return pane.target === null || pane.target.kind !== 'terminal';
}

/**
 * WHERE DOES "SHOW ME THIS" GO? — the placement policy, once, for both callers.
 *
 * Ported rule for rule from `resolveOpenPlacement`, which the server verb and
 * the browser store already shared: a target already on screen is left alone,
 * the active pane wins when it qualifies, an agent adds rather than navigates,
 * the invoking conversation is never evicted, and nothing replaceable means
 * SPLIT rather than take something away.
 *
 * Two cases are new, and both are new because the flat model can express what
 * the two-level one could not:
 *
 *  - **The grid is empty.** A workspace used to be guaranteed at least one
 *    pane; closing the last one now leaves an empty grid, so "place it in the
 *    root" is an ordinary answer rather than the `create` of a whole workspace.
 *  - **A PARKED node already holds the target.** Minting a second node for it
 *    would put one conversation in two places, which is the duplicate the focus
 *    rule exists to prevent — so this is refused. Bringing a parked node back is
 *    a `move`, and the caller names it.
 */
function open(nodes: readonly WorkspaceNode[], input: OpenInput<PaneTargetKind>): CommandResult {
  const { target, newNodeId, newSplitId } = input;

  // No blank-target guard here, deliberately. This layer used to carry one,
  // because `bind` refused a blank target id and `create` did not — so the fill
  // path and the split path answered the same request differently, and the
  // command had to paper over the difference. `create` now refuses it at the
  // mint, which is where a pane minted already bound can be caught, so every
  // path below reaches the same refusal from the layer that owns the rule.
  // A guard here would be a second statement of it that no test could tell
  // apart from the first.

  const already = nodeShowing(nodes, target);
  if (already !== undefined) {
    // On screen already: focus is client-local — no row carries it and it does
    // not restore across devices — so the correct write is no write at all.
    if (already.parentId !== null) return { ok: true, write: { put: [], drop: [] } };
    return refuse(
      'already_bound',
      `node "${already.id}" already shows ${target.kind} "${target.id}" and is parked; showing it again is a move, not a second mint`,
    );
  }

  const root = rootOf(nodes);
  if (root === undefined) return refuse('no_root', 'no node of type "root" to place anything into');

  const panes = gridPanes(nodes);
  if (panes.length === 0) {
    return compile(nodes, [
      (current) => create(current, { nodeId: newNodeId, target, parentId: root.id, index: 0 }),
    ]);
  }

  const canReplace = (pane: GridPane): boolean =>
    isReplaceablePane(pane) &&
    (input.preferSplit !== true || pane.target === null) &&
    (input.excludeTargetId === undefined || pane.target?.id !== input.excludeTargetId) &&
    (input.isReplaceable === undefined || input.isReplaceable(pane));

  // The ACTIVE pane wins when it qualifies — "show me this" means "here, where
  // I am looking", not "in the leftmost slot that happens to fit".
  const active = panes.find((pane) => pane.id === input.activeNodeId);
  const chosen = active !== undefined && canReplace(active) ? active : panes.find(canReplace);

  if (chosen !== undefined && chosen.target === null) {
    // An empty slot: the pane is already the right rectangle in the right place,
    // and filling it is what `bind` is for.
    return compile(nodes, [(current) => bind(current, { nodeId: chosen.id, target })]);
  }

  if (chosen !== undefined) {
    // A bound pane the policy is willing to give up. The old model REPOINTED it;
    // a target is fixed for a node's life here, so the new node takes the slot
    // and the old one parks — still in the workspace, still in the sidebar.
    // It arrives before the other leaves, so no group momentarily has a hole.
    const parentId = chosen.parentId;
    const index = childrenOf(nodes, parentId).findIndex((sibling) => sibling.id === chosen.id) + 1;
    return compile(nodes, [
      (current) => create(current, { nodeId: newNodeId, target, parentId, index }),
      (current) => move(current, { nodeId: chosen.id, parentId: null, index: parkedSlot(current, chosen.id) }),
    ]);
  }

  // Nothing may be given up, so ADD instead: split beside the pane the user is
  // looking at, and mint the newcomer already showing what was asked for.
  const from = active ?? panes[0];
  return splitInto(nodes, { nodeId: from.id, axis: input.axis ?? 'row', newNodeId, newSplitId }, target);
}

/** Place a conversation. See {@link open} for the policy, which is shared with {@link openPage}. */
export function openConversation(
  nodes: readonly WorkspaceNode[],
  input: OpenConversationInput,
): CommandResult {
  return open(nodes, input);
}

/** Place a page. Same policy as {@link openConversation}; the kind is fixed so the two cannot be confused. */
export function openPage(nodes: readonly WorkspaceNode[], input: OpenPageInput): CommandResult {
  return open(nodes, input);
}

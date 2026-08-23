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
 * `move` is the only thing that changes it. Attach is the vocabulary of joining
 * two independently existing systems, and having two systems to join is the bug
 * this epic deletes.
 *
 * **And "closing" is a `destroy`.** It was a move to no parent, which made a
 * closed pane and a pane that lost its parent through a defect the same state.
 * A pane that is in the workspace is on the screen; taking it off the screen
 * takes it out of the workspace, and that is one act with one name.
 */
import {
  applyNodeWrite,
  bind,
  create,
  destroy,
  move,
  type NodeOperationCode,
  type NodeOperationResult,
  type NodeWrite,
} from './workspace-node-algebra';
import {
  childrenOf,
  findNode,
  rootOf,
  type NodeAxis,
  type PaneNode,
  type PaneTarget,
  type PaneTargetKind,
  type RootNode,
  type SplitNode,
  type WorkspaceNode,
} from './workspace-node';
import { readFraction } from './workspace-fractions';
import { splitAxisFor, splitHostPane } from './workspace-node-packing';

/**
 * Why a command was refused.
 *
 * Exactly {@link NodeOperationCode}, and the aliasing is the point: this layer
 * adds POLICY (where a thing opens, what a gesture compiles to) and it no longer
 * adds a refusal of its own. It used to carry `detached_pane` — "this pane is in
 * the workspace but not in the grid", a condition that only existed because a
 * pane could be in one and not the other. There is one place a pane can be now,
 * so the code has nothing left to describe. The alias stays so every caller's
 * `CommandCode` annotation keeps meaning "however deep the refusal came from".
 */
export type CommandCode = NodeOperationCode;

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

// ---------------------------------------------------------------------------
// The root seed
// ---------------------------------------------------------------------------

/**
 * A workspace's root, minted deterministically FROM THE WORKSPACE'S OWN ID.
 *
 * **Why the id is not random.** Two clients — or a client and an agent tool —
 * can reach an unseeded workspace at the same instant, and each would mint its
 * own root. Both writes validate in isolation and the second upserts a SECOND
 * root row, which `oneRootPerWorkspace` refuses and `validateTree` calls
 * `multiple_roots`: a workspace that becomes unwritable on a race. A
 * deterministic id makes the two writes the SAME write, so they converge
 * through the upsert exactly like every other retried node write.
 *
 * The workspace id is the natural choice and not merely a convenient one: the
 * row's key is `(rootId, id)`, so a root keyed `id === rootId` says in the table
 * what it says in the model. It cannot collide with a client-minted node id
 * either, because {@link seedRoot} refuses to mint over an id that is already
 * there.
 *
 * `axis: 'row'` — a row of columns, which is the shape `split_right` gave the
 * grid this replaces.
 */
export function rootSeedFor(workspaceId: string): RootNode {
  return { nodeType: 'root', id: workspaceId, parentId: null, position: 0, axis: 'row' };
}

/**
 * THE WORKSPACE'S BIRTH, and the reason the client no longer seeds a grid on
 * mount.
 *
 * A workspace row can exist with no node rows at all — a fresh spawn, or one the
 * backfill has not reached — and every command here needs a root to place into
 * (`open` refuses `no_root`, and `create` needs a parent that resolves). Under
 * the model this replaces, that gap was filled by the BROWSER: `ensureWorkspace`
 * posted an `ensure` verb on mount, which is precisely the create-then-attach
 * shape the flat model exists to delete — two successful transitions before
 * anything is on screen, and production is full of the state where only the
 * first landed.
 *
 * So the root is minted by whatever write first needs one, on the server, inside
 * the lock, as part of that write. Not a repair: nothing here rescues a pointer
 * that failed to resolve or moves a node the caller did not name. It is the
 * empty grid becoming spellable, which is a legal resting state
 * (`validateTree` accepts a root holding nothing) rather than a fault.
 *
 * Total and idempotent: a workspace that already has a root — under ANY id, not
 * just the seeded one — gets `{nodes, seed: null}` and nothing is written.
 */
export function seedRoot(
  nodes: readonly WorkspaceNode[],
  workspaceId: string,
): { nodes: readonly WorkspaceNode[]; seed: RootNode | null } {
  if (rootOf(nodes) !== undefined) return { nodes, seed: null };
  const seed = rootSeedFor(workspaceId);
  // An id already taken by something that is NOT a root leaves the workspace
  // where it was: refusing beats upserting a root over a live pane, and the
  // caller's command then answers `no_root` — which is true, and says so.
  if (findNode(nodes, seed.id) !== undefined) return { nodes, seed: null };
  return { nodes: [...nodes, seed], seed };
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
 *
 * **IT PACKS BEFORE IT NESTS — under two conditions, and both of them are
 * about not moving something somebody chose.** A pane whose container already
 * runs along the requested axis gets its sibling IN THAT CONTAINER; a split
 * that changes direction still mints one. Two containers running the same way
 * are ONE container as far as the renderer is concerned (`ContainerGroup` lays
 * out any number of children), so the nested form is a strictly deeper spelling
 * of the identical picture — deeper against `MAX_DEPTH`, one node heavier
 * against `MAX_NODES`, and harder to drag, because a handle between two
 * containers resizes a group rather than the panes either side of it. Four
 * shells spawned into one session used to become four levels of that
 * (issue #2469).
 *
 * **The conditions, and why packing is not simply better.** Joining a container
 * means joining its sibling group, and `create` rebalances a group it joins:
 * the newcomer takes an even share and the survivors keep their proportions
 * inside what is left. So a packed split does not divide the pane it was
 * pointed at — it divides the whole container. Where nobody has sized that
 * container that IS the intent (its members were sharing it evenly anyway, and
 * an unsized group stays unsized through the rebalance, so no share nobody
 * chose is written). Where somebody has DRAGGED it, it is a change nobody asked
 * for: splitting one of two panes would move the other. Hence:
 *
 * How often this fires is worth knowing, because the direction is chosen from
 * the RECTANGLE (`splitAxisFor`) rather than from the container: on a fresh
 * workspace it is the first split of a lone pane, and after that it is whenever
 * a pane's longer edge happens to agree with the way its container already runs
 * — a narrow pane in a column, a short one in a row. Every other placement
 * nests, which is why the depth that matters is bounded by
 * {@link splitHostPane} choosing the roomiest pane rather than by this.
 *
 *  - **`pack` is asked for by the PLACEMENT path only.** `split` — the toolbar's
 *    two buttons — keeps nesting, so "split right" still divides the pane the
 *    user pointed at and leaves its neighbours exactly where they were. The
 *    accumulation issue #2469 reports is about panes an agent OPENS, which is
 *    the path that asks.
 *  - **and only into a container NOBODY HAS SIZED.** A group carrying stored
 *    shares is one a user dragged; the nesting form gives the newcomer the split
 *    pane's own slot and share (see {@link stageContainer}) and leaves every
 *    sibling's share untouched, which is the honest answer there.
 */
function splitInto(
  nodes: readonly WorkspaceNode[],
  input: SplitInput,
  target: PaneTarget | null,
  pack = false,
): CommandResult {
  const node = findNode(nodes, input.nodeId);
  if (node === undefined) return refuse('unknown_node', `no node "${input.nodeId}" to split`);
  if (node.nodeType === 'root') {
    return refuse('root_immutable', `node "${input.nodeId}" is the root; the workspace is not a pane in itself`);
  }
  if (node.nodeType !== 'pane') {
    return refuse('not_a_pane', `node "${input.nodeId}" is a split; a split divides space rather than occupying it`);
  }

  // PACK: the container is already going this way and nobody has sized it, so
  // the newcomer is a sibling. `newSplitId` is not consulted at all on this
  // path — no container is minted, so an id for one is neither used nor
  // required to be free, and the checks below belong with the mint they defend
  // rather than with the command.
  const parent = findNode(nodes, node.parentId);
  if (pack && parent !== undefined && parent.nodeType !== 'pane' && parent.axis === input.axis) {
    const group = childrenOf(nodes, parent.id);
    if (isUnsizedGroup(group)) {
      const index = group.findIndex((sibling) => sibling.id === node.id) + 1;
      return compile(nodes, [
        (current) => create(current, { nodeId: input.newNodeId, target, parentId: parent.id, index }),
      ]);
    }
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
 * Has nobody sized this container? — the second half of the packing condition.
 *
 * "Nobody" is read the way the renderer reads it: `currentShares` falls back to
 * an even split the moment ANY member is unsized, so a group that is not wholly
 * sized is one no stored share is currently deciding. Packing into such a group
 * rebalances numbers nobody chose into other numbers nobody chose, and writes
 * none of them (an all-unsized group stays all-unsized through
 * `rebalanceFractions`). Packing into a SIZED one would move a pane the user
 * dragged, so that one nests instead.
 */
function isUnsizedGroup(group: readonly WorkspaceNode[]): boolean {
  return group.every((member) => member.nodeType === 'root' || readFraction(member.fraction) === null);
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
 * It always NESTS, and that is deliberate rather than left over: this is the
 * TOOLBAR's gesture, and a user who points at a pane and asks to divide it has
 * not asked for their other panes to move. The placement path packs instead —
 * see {@link splitInto} for both halves of that condition.
 */
export function split(nodes: readonly WorkspaceNode[], input: SplitInput): CommandResult {
  return splitInto(nodes, input, null);
}

// ---------------------------------------------------------------------------
// closePane
// ---------------------------------------------------------------------------

/** Which pane goes. */
export interface ClosePaneInput {
  nodeId: string;
}

/**
 * Close a pane: THE PANE GOES.
 *
 * **A `destroy`, not a move to nowhere.** It was the latter, and the cost was
 * exact: closing a pane produced a node with no parent, so a permanent
 * population of parentless nodes existed by design and a pane that lost its
 * parent through a defect looked identical to one a user had closed. Nothing
 * could tell them apart — not the validator, which could reject a parent id that
 * failed to resolve but never a null one, and not a reader of the rows.
 *
 * What is given up is named rather than hidden: a closed pane's node is gone,
 * so the conversation it showed is no longer a member of this workspace and its
 * binding is released. That is what closing MEANS under one removal, and it is
 * the same act as `destroy(paneId)` because it is that act.
 *
 * **Closing the LAST pane leaves the session standing with an empty tree.** Not
 * "closing the last pane ends the session" — that inference is gone with the
 * state that motivated it. A root holding nothing is an ordinary resting state,
 * and ending a session is `destroy(rootId)`: an explicit target, never derived
 * from emptiness.
 *
 * A split left holding one child collapses, because `destroy` collapses it —
 * not because this command noticed.
 *
 * **It insists on a PANE, and that is not a second removal.** `destroy` takes
 * whatever it is pointed at, root included, which is the whole correction. This
 * is a COMMAND — a gesture with a name — and the gesture is "close this pane".
 * Handed a split it would close a column the user did not name; handed the root
 * it would end the session. Both are category errors in the caller, and a
 * command whose name states its subject should say so rather than obey. Ending a
 * session is `destroy(rootId)`, asked for by a caller that means it.
 */
export function closePane(nodes: readonly WorkspaceNode[], input: ClosePaneInput): CommandResult {
  const node = findNode(nodes, input.nodeId);
  if (node === undefined) return refuse('unknown_node', `no node "${input.nodeId}" to close`);
  if (node.nodeType === 'root') {
    return refuse(
      'root_immutable',
      `node "${input.nodeId}" is the root; closing a pane is not ending the session, which is a destroy the caller names`,
    );
  }
  if (node.nodeType !== 'pane') {
    return refuse('not_a_pane', `node "${input.nodeId}" is a split; closing a column is not closing a pane`);
  }
  return compile(nodes, [(current) => destroy(current, { nodeId: input.nodeId })]);
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
 * **A MOVE AND A DESTROY, NEVER A REBIND.** A bound node's target is fixed for
 * the whole of its life — `bind` refuses to re-point one, and that refusal is
 * the design rather than an omission. So this does not change what a rectangle
 * shows; it changes which node occupies the slot. The node already showing the
 * target moves in, and the node it displaces is destroyed.
 *
 * That is what keeps "this pane" and "this conversation" separable at the level
 * that still matters: the NODE is what goes, and the conversation's history is
 * untouched by it. What is no longer true is that the displaced node survives
 * somewhere off-screen — there is no off-screen.
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
    // The displaced node goes. Run against the tree the arrival produced, so the
    // container it shared with the replacement is never momentarily a hole.
    (current) => destroy(current, { nodeId }),
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
  /**
   * The split's direction when it comes to that. OMIT IT, and the placement
   * picks the direction from the layout it is placing into
   * (`splitAxisFor` — along the host pane's longer edge). It is here for a
   * caller that genuinely means one direction, which in practice is the human
   * toolbar's two split buttons; every server-side admission leaves it unset,
   * and a `row` default is what made every agent-opened pane a new column
   * (issue #2469).
   */
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
export type OpenShellInput = OpenInput<'terminal'>;

/**
 * The workspace's panes in RENDER order — depth first from the root, which is
 * the order a reader's eye takes and the order `panesOf` produced when the model
 * was two levels deep and the distinction could not arise.
 *
 * There is no longer a second list beside this one. Every pane descends from the
 * root, so "the panes the grid draws" and "the panes the workspace holds" are
 * the same set, differing only in ORDER — which is what this function is for.
 *
 * Total on cyclic input, like every other walk over this model: a flat parent
 * pointer can express a cycle, and placement runs before the write that would
 * have rejected one.
 */
function gridPanes(nodes: readonly WorkspaceNode[]): PaneNode[] {
  const root = rootOf(nodes);
  if (root === undefined) return [];
  const panes: PaneNode[] = [];
  const seen = new Set<string>([root.id]);
  const walk = (parentId: string): void => {
    for (const child of childrenOf(nodes, parentId)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (child.nodeType === 'pane') panes.push(child);
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
 * One case is new, and it is new because the flat model can express what the
 * two-level one could not: **the grid is empty.** A workspace used to be
 * guaranteed at least one pane; closing the last one now leaves an empty tree,
 * so "place it in the root" is an ordinary answer rather than the `create` of a
 * whole workspace.
 *
 * A case that USED to be here is gone with the state it described. When a node
 * could be parked, a target already held by a parked node had to be refused
 * (`already_bound`) rather than shown, because minting a second node for it
 * would put one conversation in two places and bringing the parked one back was
 * a `move` only the caller could name. A node holding this target is now
 * necessarily on the grid, so "already showing it" is the whole answer and the
 * correct write is no write.
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

  // On screen already: focus is client-local — no row carries it and it does
  // not restore across devices — so the correct write is no write at all.
  if (nodeShowing(nodes, target) !== undefined) return { ok: true, write: { put: [], drop: [] } };

  const root = rootOf(nodes);
  if (root === undefined) return refuse('no_root', 'no node of type "root" to place anything into');

  const panes = gridPanes(nodes);
  if (panes.length === 0) {
    return compile(nodes, [
      (current) => create(current, { nodeId: newNodeId, target, parentId: root.id, index: 0 }),
    ]);
  }

  const canReplace = (pane: PaneNode): boolean =>
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
    // and the old one is DESTROYED. It arrives before the other leaves, so no
    // group momentarily has a hole.
    const parentId = chosen.parentId;
    const index = childrenOf(nodes, parentId).findIndex((sibling) => sibling.id === chosen.id) + 1;
    return compile(nodes, [
      (current) => create(current, { nodeId: newNodeId, target, parentId, index }),
      (current) => destroy(current, { nodeId: chosen.id }),
    ]);
  }

  // Nothing may be given up, so ADD instead: split the pane with the most room
  // — the one the user is looking at whenever that is one of them — and mint
  // the newcomer already showing what was asked for.
  //
  // Both halves of that choice live in `workspace-node-packing.ts`, and both
  // used to be constants here: `active ?? panes[0]` for the host and `'row'`
  // for the direction. A constant direction is what gave a session that spawned
  // three shells three columns; a constant host is what made every one of those
  // splits subdivide the SAME pane. See that module for why the rule is the
  // rectangle rather than the count.
  const from = splitHostPane(nodes, panes, input.activeNodeId) ?? panes[0];
  return splitInto(
    nodes,
    { nodeId: from.id, axis: input.axis ?? splitAxisFor(nodes, from.id), newNodeId, newSplitId },
    target,
    // PACK. Placing is the path that accumulates — one pane per shell, per
    // page, per thread an agent opens — and it is the path with no user gesture
    // behind it whose meaning a rebalance could contradict.
    true,
  );
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

/**
 * Place a SHELL — reattaching one this workspace already has, or seating one the
 * caller just spawned.
 *
 * Same policy again, and the third caller is what settles that the policy
 * belongs in {@link open} rather than in `openConversation` with two aliases.
 * Note the asymmetry it inherits and should keep: a shell is never EVICTED
 * (`isReplaceablePane` refuses a terminal — the PTY loses its only surface and
 * there is no reattach UI), but a shell can perfectly well be what displaces
 * something else. "Do not take this away" and "this may be put here" are
 * different questions about the same kind.
 */
export function openShell(nodes: readonly WorkspaceNode[], input: OpenShellInput): CommandResult {
  return open(nodes, input);
}

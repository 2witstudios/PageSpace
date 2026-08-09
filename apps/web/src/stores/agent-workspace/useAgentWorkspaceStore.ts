import { create as createStore } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';
import {
  bind,
  create,
  destroy,
  type NodeWrite,
} from '@pagespace/lib/agent-workspaces/workspace-node-algebra';
import {
  closePane as closePaneCommand,
  compile,
  openConversation as openConversationCommand,
  openPage as openPageCommand,
  openShell as openShellCommand,
  seedRoot,
  split as splitCommand,
  type CommandCode,
  type CommandResult,
} from '@pagespace/lib/agent-workspaces/workspace-node-commands';
import {
  childrenOf,
  findNode,
  rootOf,
  type NodeAxis,
  type PaneNode,
  type PaneTarget,
  type WorkspaceNode,
} from '@pagespace/lib/agent-workspaces/workspace-node';
import type {
  WorkspaceNodeSnapshotResponse,
  WorkspaceNodeTarget,
} from '@pagespace/lib/agent-workspaces/workspace-node-wire';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import {
  emptyWrite,
  isAdoptableTree,
  isEmptyWrite,
  makePending,
  rebasePending,
  unionWrites,
  type PendingWrite,
} from './node-writes';

/**
 * ONE LIVE TREE PER WORKSPACE — the client half of the node cutover.
 *
 * **The equation.** For every workspace this store holds a server snapshot
 * (`base` + `rev` + `targets`) and a FIFO of WRITE-SETS applied locally but not
 * yet acknowledged; what components render is always
 * `rebasePending(base, pending)` (`node-writes.ts`). Every mutating action
 * reduces through the SHARED command layer
 * (`@pagespace/lib/agent-workspaces/workspace-node-commands`, which the server's
 * agent tools run too — one function, two callers), enqueues the write it
 * produced, and POSTs the outstanding queue as ONE `{baseRev, put, drop}`:
 *
 *   - **200** → it landed (or was a no-op). Adopt the returned `{rev, nodes,
 *     targets}` and drop everything that was on the wire.
 *   - **409** → `baseRev` was stale: the body IS the truth. Adopt it, rebase
 *     everything still unacked on top, and re-POST.
 *   - **`workspace:nodes-updated`** (another device, an agent placement, or our
 *     own echo) → drop if `rev <= known`; otherwise adopt and rebase.
 *
 * **What is gone, and why it could go.** The verb queue needed `opId`s, an
 * idempotency table, `verbAlreadyLanded`, and a per-verb list of which ids each
 * verb minted — all of it to make a REPLAY safe. A write-set is an upsert of a
 * node set, so replay is safe by construction and the whole apparatus went with
 * the shape that needed it. `pane-labels.ts` went too: it existed only to
 * re-dress a label-free broadcast, and `targets[]` — resolved and redacted once
 * per viewer on the HTTP reads, riding BESIDE the tree — replaces it. A
 * broadcast still carries no titles, and it no longer needs to: a tree whose
 * targets this client has not resolved renders from the ids it does hold, and
 * the listing read fills the names in.
 *
 * **ONE STRUCTURE, so one cache.** The sidebar and the pane grid are two
 * renderings of what is in here. There is nothing left to synchronise between
 * them, which is the entire point of the epic — and it is why
 * {@link AgentWorkspaceState.hydrateFromServer} is careful to return the SAME
 * object when nothing changed: the sidebar seats every listed workspace on every
 * revalidation, and a fresh `workspaces[id]` on each of those would re-render
 * every tree in the app twice a minute.
 *
 * **Client-only guards stay client-only.** The placement policy is the shared
 * one (`openConversation`'s `open`), but the two refusals a server cannot
 * evaluate — a pane holding unsaved edits, and a pane showing a conversation
 * this caller knows is no longer live — are injected as `isReplaceable`.
 *
 * **What is still client-local**, and the only thing localStorage holds:
 * `activeNodeId` and `pendingPickerNodeId`. Focus is view state no row owns (per
 * #2048, deliberately not restored cross-device), so it is kept beside the cache
 * and overlaid on every snapshot that arrives — a remote edit never steals your
 * focus, and a node that vanished falls back to the first pane in the grid.
 *
 * **A workspace CAN be empty, in both directions.** Closing the last pane leaves
 * an empty grid and does not end the workspace: that decision used to live half
 * in the reducer (which no-oped on the last pane, because a two-level grid could
 * not represent zero) and half in browser code that ended the session. Ending a
 * workspace is an explicit lifecycle act elsewhere.
 */

/** Focus — the only tree state that is still client-local (and still persisted). */
interface WorkspaceFocus {
  activeNodeId: string | null;
  pendingPickerNodeId: string | null;
}

/**
 * WHAT A COMPONENT RENDERS: one workspace's live tree plus the names beside it.
 *
 * `nodes` is the flat list, and it is the WHOLE membership: "in the workspace"
 * and "on screen" are one fact, so a renderer that walks from {@link rootOf}
 * has enumerated every member and there is no second list to remember. That is
 * why #2373 cannot recur here — not because every caller is careful.
 */
export interface WorkspaceTree {
  workspaceId: string;
  /** The rev `base` was read at. Local edits do not advance it. */
  rev: number;
  nodes: WorkspaceNode[];
  /**
   * Resolved, per-viewer titles for the bound nodes — `id`-keyed BESIDE the
   * tree, never inside it. A target this viewer may not read (or that is gone)
   * simply has no entry, which is deliberately indistinguishable.
   */
  targets: WorkspaceNodeTarget[];
  /** `null` on an empty grid — a legal resting state, not a missing value. */
  activeNodeId: string | null;
  pendingPickerNodeId: string | null;
}

/** One workspace's cache bookkeeping. Never read by components; `workspaces` is. */
interface WorkspaceSync {
  /** The last server snapshot's nodes. `null` = never read. */
  base: WorkspaceNode[] | null;
  /** The rev `base` was read at — what the next POST rebases on. */
  rev: number;
  targets: WorkspaceNodeTarget[];
  /** Write-sets applied locally, awaiting their POST. Strictly FIFO. */
  pending: PendingWrite[];
  /** The pending ids currently on the wire — the serial-send guard. */
  inFlight: string[];
  /** Consecutive transport failures; resets on any settled answer. */
  attempts: number;
}

/**
 * Why a workspace's pending layout work was thrown away.
 *
 *   refused        a 4xx that is not a 409 — the server will never accept this
 *                  write. Most often the target gate saying this is not the
 *                  caller's to show.
 *   abandoned      the transport failed MAX_TRANSPORT_ATTEMPTS times running.
 *   stale-display  the abandon happened AND the resync that was supposed to
 *                  replace it also failed.
 *   superseded     new server truth arrived that a local edit can no longer be
 *                  rebased onto — the node it edited is gone. NEW in the node
 *                  model, and it is the honest name for the one thing an upsert
 *                  cannot paper over: re-applying that write would RESURRECT
 *                  what somebody else destroyed. See `node-writes.ts`.
 */
export interface WorkspaceQueueError {
  reason: 'refused' | 'abandoned' | 'stale-display' | 'superseded';
  /** Set once per transition, so a renderer can fire a toast without repeating it. */
  at: number;
}

/** The `workspace:nodes-updated` payload, as it arrives on either room. */
export interface WorkspaceNodesUpdatedEvent {
  workspaceId: string;
  rev: number;
  nodes: WorkspaceNode[];
}

/** The caller-supplied half of "show me this" — see `OpenInput` for the shared half. */
export interface OpenTargetOptions {
  /**
   * Where the user is looking, when the caller knows better than the store's own
   * focus (a pick made inside one particular pane). A PREFERENCE: one that does
   * not resolve is simply not honoured.
   */
  activeNodeId?: string;
  /** An agent ADDS a surface: with this set, only an unbound pane may be filled. */
  preferSplit?: boolean;
  /** The invoking conversation — its node is never a candidate. */
  excludeTargetId?: string;
  /**
   * When supplied, a BOUND chat node whose conversation is not in this set is
   * protected from eviction — a thread closed out of the workspace, which an
   * unrelated later selection has no business displacing (issue #2295).
   */
  liveConversationIds?: ReadonlySet<string>;
}

interface AgentWorkspaceState {
  /** workspaceId → what to render. Derived: `rebasePending(base, pending)` plus the focus overlay. */
  workspaces: Record<string, WorkspaceTree>;
  /** workspaceId → the server snapshot + unacked queue behind it. */
  sync: Record<string, WorkspaceSync>;
  /** workspaceId → client-local focus. The ONLY thing this store persists. */
  focus: Record<string, WorkspaceFocus>;
  /** workspaceId → why its queue was dropped, or null once anything settles cleanly. */
  queueErrors: Record<string, WorkspaceQueueError | null>;

  /**
   * Adopt a `{rev, nodes, targets}` snapshot straight from the server — the
   * mount GET, a resync, or the sessions listing seating every workspace it
   * returned.
   */
  hydrateFromServer(workspaceId: string, snapshot: WorkspaceNodeSnapshotResponse): void;
  /** Apply a `workspace:nodes-updated` broadcast. Structural only; carries no titles. */
  applyRemoteUpdate(payload: WorkspaceNodesUpdatedEvent): void;
  /** Re-read the access-checked snapshot. Resolves false when it could not be read. */
  refreshWorkspaceSnapshot(workspaceId: string): Promise<boolean>;
  /** Drop a workspace's tree entirely (it was ended elsewhere), and orphan anything in flight. */
  forgetWorkspace(workspaceId: string): void;

  /** Focus a node. CLIENT-LOCAL — focus is not a row, so nothing crosses the wire. */
  selectNode(workspaceId: string, nodeId: string): void;
  /** Retire a node's picker focus. CLIENT-LOCAL, like {@link selectNode}. */
  dismissPicker(workspaceId: string, nodeId: string): void;

  /**
   * THE ONE MUTATING FUNNEL: run a command against the live tree, enqueue the
   * write it produced, and POST it. Returns the refusal code, or `null` when the
   * command was accepted (including when it accepted and wrote nothing).
   *
   * EXPORTED on the store rather than kept private, because a caller composing
   * several operations into ONE write — an agent's "rearrange these four" — must
   * not have to publish three intermediate trees to do it. `compile` is the
   * composer; this is where its single write lands.
   */
  runCommand(workspaceId: string, run: (nodes: readonly WorkspaceNode[]) => CommandResult): CommandCode | null;

  /** Give a pane a sibling by putting a container where it was. */
  splitPane(workspaceId: string, nodeId: string, axis: NodeAxis): void;
  /**
   * Close a pane: the pane GOES.
   *
   * A `destroy`, not a move to nowhere. Closing used to park the node — in the
   * workspace, off the screen — which meant a pane a user closed and a pane that
   * lost its parent to a defect were the same row. Closing the last one leaves
   * the session standing with an empty tree; ending the session is a different,
   * explicitly-named act.
   */
  closePane(workspaceId: string, nodeId: string): 'closed' | 'noop';
  /** Make a conversation visible. See {@link OpenTargetOptions} for the caller's half of the policy. */
  openConversation(workspaceId: string, conversationId: string, options?: OpenTargetOptions): void;
  /** Make a page visible — same policy, a kind that cannot be confused with a conversation. */
  openPage(workspaceId: string, pageId: string, options?: OpenTargetOptions): void;
  /** Make a shell visible — reattaching the node already holding it when there is one. */
  openShell(workspaceId: string, shellId: string, options?: OpenTargetOptions): void;
  /**
   * Focus a node, moving it beside where the user is looking if it is somewhere
   * else in the tree.
   *
   * It used to un-park a node — bring one with no parent back onto the grid —
   * which was a parked row's whole affordance in the sidebar. There are no
   * parked rows, so what is left is the ordinary "take me to this", and the
   * move is only ever a reposition.
   */
  showNode(workspaceId: string, nodeId: string): void;
  /** Fill an UNBOUND pane. Refuses a bound one: a binding is for life. */
  bindPane(workspaceId: string, nodeId: string, target: PaneTarget): void;
  /**
   * Send a bound pane back to the picker.
   *
   * A binding is for life, so this is NOT a rebind: the node is destroyed and a
   * fresh unbound one takes its slot. THE NODE ID CHANGES, deliberately — a
   * caller holding the old one is holding a pane that no longer exists, which is
   * exactly what happened, and the model refuses to let that read as "the same
   * rectangle, emptied".
   */
  unbindPane(workspaceId: string, nodeId: string): void;
}

/**
 * Transport give-up threshold. A write that cannot be settled after this many
 * consecutive failures (network down, a 5xx, or a workspace so contended that
 * every rebase 409s again) is ABANDONED and the server's snapshot re-read:
 * showing the user the durable truth beats showing them a local edit that will
 * silently evaporate on the next reload.
 */
const MAX_TRANSPORT_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [300, 900, 2400, 5000];

/**
 * A NEW value on every page load, mixed into the counter fallback below.
 *
 * Without it the fallback restarted at 1 on every load, and node ids are
 * compound-PK'd per workspace — so a reload re-minting `pane-1` into the same
 * workspace would UPSERT over a live pane rather than mint beside it. Taken
 * whenever `crypto.randomUUID` is missing, i.e. any non-secure context — for
 * this product, an onprem deployment reached over plain HTTP on a LAN address.
 */
const FALLBACK_MINT_NONCE = Math.random().toString(36).slice(2, 10);

let nodeCounter = 0;
function mintId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  nodeCounter += 1;
  return `${prefix}-${FALLBACK_MINT_NONCE}-${nodeCounter}`;
}

function emptySync(): WorkspaceSync {
  return { base: null, rev: 0, targets: [], pending: [], inFlight: [], attempts: 0 };
}

/**
 * Bumped whenever a workspace's queue is reset from outside it
 * (`forgetWorkspace`). A response that comes back carrying an older generation
 * is DROPPED rather than applied — otherwise a slow POST could resurrect a tree
 * the user just ended.
 *
 * ENTRIES ARE DELIBERATELY NEVER REMOVED. Deleting would reset the counter to 0,
 * and a response still in flight from before the drop — minted at generation 0,
 * because this workspace had never been reset — would then MATCH the re-hydrated
 * entry's fresh 0 and be applied: precisely the resurrection the generation
 * exists to prevent. The cost is one integer per workspace id the tab has ever
 * opened.
 */
const queueGeneration = new Map<string, number>();

function generationOf(workspaceId: string): number {
  return queueGeneration.get(workspaceId) ?? 0;
}

function bumpGeneration(workspaceId: string): void {
  queueGeneration.set(workspaceId, generationOf(workspaceId) + 1);
}

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Test-only full reset. A real page load never needs it; tests, sharing one
 * module scope, do — and resetting `workspaces` ALONE is not enough: the
 * rendered tree is derived from `sync`, so a leftover queue would replay a
 * previous test's writes into the next one's fresh tree.
 */
export function __resetWorkspaceQueuesForTests(): void {
  queueGeneration.clear();
  registeredEditing.clear();
  for (const timeout of retryTimers.values()) clearTimeout(timeout);
  retryTimers.clear();
  useAgentWorkspaceStore.setState({ workspaces: {}, sync: {}, focus: {}, queueErrors: {} });
}

/**
 * Workspaces currently registered with `useEditingStore` — the repo's
 * refresh-protection rule. Registered while ANY write is unacked (an auth
 * refresh or an SWR clobber mid-queue would be exactly the interruption the rule
 * exists to prevent), released the moment the queue drains. Tracked here rather
 * than called unconditionally so a drained queue does not re-enter the editing
 * store on every subsequent render.
 */
const registeredEditing = new Set<string>();

function syncEditingRegistration(workspaceId: string, queued: boolean): void {
  const editingId = `workspace-nodes:${workspaceId}`;
  if (queued && !registeredEditing.has(workspaceId)) {
    registeredEditing.add(workspaceId);
    useEditingStore.getState().startEditing(editingId, 'other', { componentName: editingId });
    return;
  }
  if (!queued && registeredEditing.has(workspaceId)) {
    registeredEditing.delete(workspaceId);
    useEditingStore.getState().endEditing(editingId);
  }
}

/** Every pane in the grid, depth-first from the root — the order a reader's eye takes. */
function gridPanesOf(nodes: readonly WorkspaceNode[]): PaneNode[] {
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
 * What focus should be after a commit.
 *  - `'preserve'`: keep the user's focus if the node still exists, and fall back
 *    to the first grid pane only if it does not. A remote edit must never steal
 *    focus, and neither must the user's own edit elsewhere in the tree.
 *  - an explicit focus: the two client-local actions, which are nothing BUT a
 *    focus change, and the commands that know where they put something.
 */
type FocusIntent = 'preserve' | WorkspaceFocus;

/** Two trees that would render identically — a shallow identity check over the same list. */
function sameNodeList(left: readonly WorkspaceNode[], right: readonly WorkspaceNode[]): boolean {
  return left.length === right.length && left.every((node, index) => node === right[index]);
}

function sameTargetList(left: readonly WorkspaceNodeTarget[], right: readonly WorkspaceNodeTarget[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((target, index) => {
    const other = right[index];
    return (
      target.id === other.id &&
      target.kind === other.kind &&
      target.title === other.title &&
      target.lastMessageAt === other.lastMessageAt &&
      target.agentPageId === other.agentPageId
    );
  });
}

/**
 * THE single write. Recomputes the rendered tree from `sync`, resolves focus per
 * `intent`, stores all four maps, keeps the editing registration honest, and
 * kicks the send pump.
 *
 * A write that no longer applies to the base it is landing on is DROPPED here
 * and reported — see `node-writes.ts` for why re-applying it would be a
 * resurrection rather than an edit.
 */
function commit(workspaceId: string, sync: WorkspaceSync, intent: FocusIntent): void {
  const rebased = rebasePending(sync.base ?? [], sync.pending);
  const settled: WorkspaceSync = { ...sync, pending: rebased.kept };

  useAgentWorkspaceStore.setState((state) => {
    const previous = state.workspaces[workspaceId];
    const focusNow = state.focus[workspaceId] ?? null;

    // Focus names a node that is STILL THERE. Closing a pane destroys it, so
    // without this the store would keep pointing at a node that no longer
    // exists — which then reaches the placement policy as an `activeNodeId`
    // preference for a rectangle nobody can see.
    const gridPanes = gridPanesOf(rebased.nodes);
    const paneIds = new Set(gridPanes.map((node) => node.id));
    const desired = intent === 'preserve' ? focusNow : intent;
    // Neither the wire nor a saved preference cross-validates that
    // `activeNodeId` names a node inside the tree — normalize HERE, at the one
    // place any tree enters the store, rather than leaving every consumer to
    // grow its own fallback. `null` is a legitimate answer now: an empty grid
    // has nothing to focus, and inventing something would be a lie.
    const fallbackNodeId = gridPanes[0]?.id ?? null;
    const activeNodeId =
      desired?.activeNodeId != null && paneIds.has(desired.activeNodeId) ? desired.activeNodeId : fallbackNodeId;
    const pendingPickerNodeId =
      desired?.pendingPickerNodeId != null && paneIds.has(desired.pendingPickerNodeId)
        ? desired.pendingPickerNodeId
        : null;

    // Referential stability is load-bearing, not an optimisation: the sidebar
    // seats every listed workspace on every revalidation, and a fresh object
    // here re-renders every tree in the app on each of those.
    const unchanged =
      previous !== undefined &&
      previous.rev === settled.rev &&
      previous.activeNodeId === activeNodeId &&
      previous.pendingPickerNodeId === pendingPickerNodeId &&
      sameNodeList(previous.nodes, rebased.nodes) &&
      sameTargetList(previous.targets, settled.targets);

    const tree: WorkspaceTree = unchanged
      ? previous
      : {
          workspaceId,
          rev: settled.rev,
          nodes: rebased.nodes,
          targets: settled.targets,
          activeNodeId,
          pendingPickerNodeId,
        };

    const focusChanged =
      focusNow === null || focusNow.activeNodeId !== activeNodeId || focusNow.pendingPickerNodeId !== pendingPickerNodeId;

    return {
      workspaces: unchanged ? state.workspaces : { ...state.workspaces, [workspaceId]: tree },
      focus: focusChanged
        ? { ...state.focus, [workspaceId]: { activeNodeId, pendingPickerNodeId } }
        : state.focus,
      sync: { ...state.sync, [workspaceId]: settled },
    };
  });

  if (rebased.dropped.length > 0) setQueueError(workspaceId, 'superseded');
  syncEditingRegistration(workspaceId, settled.pending.length > 0);
  void pump(workspaceId);
}

/** Drop every trace of a workspace — tree, focus, queue — and orphan anything in flight. */
function drop(workspaceId: string): void {
  bumpGeneration(workspaceId);
  const timer = retryTimers.get(workspaceId);
  if (timer) {
    clearTimeout(timer);
    retryTimers.delete(workspaceId);
  }
  syncEditingRegistration(workspaceId, false);
  useAgentWorkspaceStore.setState((state) => {
    const { [workspaceId]: _tree, ...workspaces } = state.workspaces;
    const { [workspaceId]: _focus, ...focus } = state.focus;
    const { [workspaceId]: _sync, ...sync } = state.sync;
    const { [workspaceId]: _err, ...queueErrors } = state.queueErrors;
    return { workspaces, focus, sync, queueErrors };
  });
}

function nodesUrl(workspaceId: string): string {
  return `/api/agent-workspaces/${encodeURIComponent(workspaceId)}/nodes`;
}

/**
 * Send the whole outstanding queue as ONE write, and only one at a time.
 *
 * Serial by construction: the wire's `baseRev` is only knowable once the
 * previous POST has been answered. Coalescing is free and correct — the union
 * rule is the same one `compile` applies, and the server's own change detection
 * decides whether any of it mints a rev.
 */
async function pump(workspaceId: string): Promise<void> {
  const sync = useAgentWorkspaceStore.getState().sync[workspaceId];
  if (!sync || sync.inFlight.length > 0 || sync.pending.length === 0) return;
  if (retryTimers.has(workspaceId)) return;

  const sending = sync.pending;
  const write = unionWrites(sending.map((entry) => entry.write));
  const generation = generationOf(workspaceId);
  commit(workspaceId, { ...sync, inFlight: sending.map((entry) => entry.id) }, 'preserve');

  let response: Response | undefined;
  try {
    response = await fetchWithAuth(nodesUrl(workspaceId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseRev: useAgentWorkspaceStore.getState().sync[workspaceId]?.rev ?? sync.rev,
        put: write.put,
        drop: write.drop,
      }),
    });
  } catch {
    // Transport failure — the write is unchanged and still ours to retry.
  }

  await settle(workspaceId, sending.map((entry) => entry.id), generation, response);
}

/** Decide what one POST's answer means for the queue, then commit it. */
async function settle(
  workspaceId: string,
  sentIds: readonly string[],
  generation: number,
  response: Response | undefined,
): Promise<void> {
  // EVERY await happens before the state read. Reading `sync` first and then
  // awaiting the body would drop any write enqueued in that window — a real and
  // routine race (a mint's success callback opens its conversation the instant
  // its POST resolves, which is exactly when the previous body is being
  // parsed), and the queue would silently lose the edit.
  const body = response ? await response.json().catch(() => null) : null;

  if (generationOf(workspaceId) !== generation) return;
  const sync = useAgentWorkspaceStore.getState().sync[workspaceId];
  if (!sync) return;
  const onWire = new Set(sentIds);
  // Somebody else already settled this send (a `forgetWorkspace` and a
  // re-hydrate inside the round trip); nothing here is ours to answer for.
  if (sync.inFlight.length !== sentIds.length || !sync.inFlight.every((id) => onWire.has(id))) return;
  const rest = sync.pending.filter((entry) => !onWire.has(entry.id));

  // Transport failure, or a server that could not answer: retry the SAME write.
  if (!response || response.status >= 500) {
    scheduleRetry(workspaceId, { ...sync, inFlight: [], attempts: sync.attempts + 1 });
    return;
  }

  if (response.status === 409 || response.ok) {
    const snapshot = readSnapshotBody(body);
    if (!snapshot) {
      if (response.status === 409) {
        // Told to rebase and handed nothing to rebase onto. Back off rather
        // than spin: the next answer, or the socket, brings the truth.
        scheduleRetry(workspaceId, { ...sync, inFlight: [], attempts: sync.attempts + 1 });
        return;
      }
      // Acked, but we learned no truth. Fold the sent writes into the base so
      // the rendered tree is unchanged and the equation stays true.
      const folded = rebasePending(sync.base ?? [], sync.pending.filter((entry) => onWire.has(entry.id)));
      commit(workspaceId, { ...sync, base: folded.nodes, pending: rest, inFlight: [], attempts: 0 }, 'preserve');
      return;
    }

    if (response.status === 409) {
      // The 409 body IS the truth. Rebase on it and re-post IMMEDIATELY — the
      // sent write did NOT land, and unlike a transport failure there is
      // nothing to wait for. The attempt still counts, so a permanently
      // contended workspace cannot spin forever.
      retry(
        workspaceId,
        {
          ...sync,
          base: snapshot.nodes,
          rev: snapshot.rev,
          targets: snapshot.targets,
          pending: sync.pending,
          inFlight: [],
          attempts: sync.attempts + 1,
        },
      );
      return;
    }

    // 200 — adopt the returned truth even when nothing changed: a no-op still
    // reports the current rev, and ignoring it would strand us behind forever.
    commit(
      workspaceId,
      {
        base: snapshot.nodes,
        rev: snapshot.rev,
        targets: snapshot.targets,
        pending: rest,
        inFlight: [],
        attempts: 0,
      },
      'preserve',
    );
    clearQueueError(workspaceId);
    return;
  }

  // A 4xx that is not a 409 (a refused target, a tree the validator rejected, a
  // workspace that is gone or no longer ours) will never succeed on retry.
  // Abandon the queue and go read what is durable — and SAY SO: the user's edit
  // is being discarded, and silently reverting it reads as the app ignoring
  // them.
  commit(workspaceId, { ...sync, pending: [], inFlight: [], attempts: 0 }, 'preserve');
  setQueueError(workspaceId, 'refused');
  void resyncAfterAbandon(workspaceId);
}

/**
 * Parse a `{rev, nodes, targets}` body, and REFUSE a tree this client should not
 * adopt.
 *
 * The shape check is deliberately structural rather than a zod mirror of the
 * wire: the authority on what a node is lives in `@pagespace/lib`, and a second
 * schema here is a second thing to keep in step. What matters is that a body
 * which is not a tree — a proxy's error page, a truncated response, a
 * half-applied write — never becomes this client's base, because every
 * subsequent local edit would then be refused by the very gate the server
 * applies, with no way out but a reload.
 */
function readSnapshotBody(body: unknown): WorkspaceNodeSnapshotResponse | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = body as Partial<WorkspaceNodeSnapshotResponse>;
  if (typeof candidate.rev !== 'number' || !Number.isInteger(candidate.rev) || candidate.rev < 0) return null;
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.targets)) return null;
  if (!isAdoptableTree(candidate.nodes)) return null;
  return { rev: candidate.rev, nodes: candidate.nodes, targets: candidate.targets };
}

/** Forget a workspace's queue error — anything settling cleanly supersedes it. */
function clearQueueError(workspaceId: string): void {
  if (!useAgentWorkspaceStore.getState().queueErrors[workspaceId]) return;
  useAgentWorkspaceStore.setState((state) => ({
    queueErrors: { ...state.queueErrors, [workspaceId]: null },
  }));
}

/** Re-post right away (the 409 path), or give up and resync once the budget is spent. */
function retry(workspaceId: string, sync: WorkspaceSync): void {
  if (giveUp(workspaceId, sync)) return;
  commit(workspaceId, sync, 'preserve');
}

/**
 * Back off, then re-pump (the transport-failure path). The timer is registered
 * BEFORE the commit: `commit` kicks the pump, and the pump's `retryTimers` guard
 * is the only thing standing between a failed write and a backoff-free re-send
 * loop.
 */
function scheduleRetry(workspaceId: string, sync: WorkspaceSync): void {
  if (giveUp(workspaceId, sync)) return;
  const delay = RETRY_BACKOFF_MS[Math.min(sync.attempts - 1, RETRY_BACKOFF_MS.length - 1)] ?? 0;
  const timer = setTimeout(() => {
    retryTimers.delete(workspaceId);
    void pump(workspaceId);
  }, delay);
  retryTimers.set(workspaceId, timer);
  commit(workspaceId, sync, 'preserve');
}

/** Spent the attempt budget: abandon the queue and go read what is durable. */
function giveUp(workspaceId: string, sync: WorkspaceSync): boolean {
  if (sync.attempts < MAX_TRANSPORT_ATTEMPTS) return false;
  commit(workspaceId, { ...sync, pending: [], inFlight: [], attempts: 0 }, 'preserve');
  setQueueError(workspaceId, 'abandoned');
  void resyncAfterAbandon(workspaceId);
  return true;
}

/** Record why a workspace's queue was dropped. `at` makes each transition distinct. */
function setQueueError(workspaceId: string, reason: WorkspaceQueueError['reason']): void {
  useAgentWorkspaceStore.setState((state) => ({
    queueErrors: { ...state.queueErrors, [workspaceId]: { reason, at: Date.now() } },
  }));
}

/**
 * Refetch after abandoning the queue, and escalate if that fails too.
 *
 * Abandoning is only defensible because the refetch replaces the discarded work
 * with the server's truth. When the refetch ALSO fails, the rendered tree is
 * neither — it is whatever `base` happened to be, indefinitely, with nothing
 * saying so.
 */
async function resyncAfterAbandon(workspaceId: string): Promise<void> {
  const ok = await useAgentWorkspaceStore.getState().refreshWorkspaceSnapshot(workspaceId);
  if (!ok) setQueueError(workspaceId, 'stale-display');
}

/**
 * Is this node a PAGE pane whose target currently has unsaved edits?
 *
 * Checked against `useEditingStore` by pageId (not by the node's own id — the
 * editing-store componentId carries a per-mount `useId()` suffix the node model
 * knows nothing about), so a dirty document/canvas/sheet page is never silently
 * displaced by the placement policy's replace path.
 *
 * The server's own command layer deliberately does NOT know this predicate — it
 * cannot; only a browser knows what is half-typed in it. That is exactly what
 * `OpenInput.isReplaceable` is for.
 */
function isNodeDirty(node: PaneNode): boolean {
  if (node.target?.kind !== 'page') return false;
  const targetPageId = node.target.id;
  return useEditingStore
    .getState()
    .getActiveSessions()
    .some(
      (session) =>
        (session.type === 'document' || session.type === 'form') && session.metadata?.pageId === targetPageId,
    );
}

/** The caller's own refusals, ANDed into the shared placement policy. */
function clientReplaceable(options: OpenTargetOptions | undefined): (node: PaneNode) => boolean {
  return (node) => {
    if (isNodeDirty(node)) return false;
    if (options?.liveConversationIds === undefined) return true;
    if (node.target === null) return true;
    return node.target.kind === 'chat' && options.liveConversationIds.has(node.target.id);
  };
}

/**
 * "SHOW ME THIS" — the one entry point behind `openConversation` and `openPage`,
 * and the only place the store adds anything to the shared placement policy.
 *
 * TWO cases now, and the one that went is worth naming:
 *
 *  - **Already in the tree** → focus it. Focus is client-local, so the correct
 *    write is no write at all — which is exactly what the command answers too,
 *    but the command cannot move the user's attention and this can.
 *  - **Nowhere** → the shared policy places it, and whatever node ended up
 *    holding it gets the focus.
 *
 * The third case was PARKED: a node holding the target with no parent, which the
 * command refused (`already_bound`) because minting a second node would put one
 * conversation in two places, so this layer had to `move` it back by hand.
 * Nothing is parked, so "a node holds it" and "it is on screen" are the same
 * sentence and the first case covers both.
 */
function openTarget(
  workspaceId: string,
  target: PaneTarget,
  options: OpenTargetOptions | undefined,
  command: (nodes: readonly WorkspaceNode[], input: never) => CommandResult,
): void {
  const store = useAgentWorkspaceStore.getState();
  const existing = findShowing(store.workspaces[workspaceId]?.nodes ?? [], target);
  if (existing !== undefined) {
    // It is in the tree, so it is on screen: the whole answer is focus, which is
    // client-local. The branch this replaces had to un-park a node first.
    store.selectNode(workspaceId, existing.id);
    return;
  }

  const active = options?.activeNodeId ?? store.workspaces[workspaceId]?.activeNodeId ?? undefined;
  const input = {
    target,
    newNodeId: mintId('pane'),
    newSplitId: mintId('split'),
    ...(active === undefined ? {} : { activeNodeId: active }),
    ...(options?.preferSplit === undefined ? {} : { preferSplit: options.preferSplit }),
    ...(options?.excludeTargetId === undefined ? {} : { excludeTargetId: options.excludeTargetId }),
    isReplaceable: clientReplaceable(options),
  };
  const refused = store.runCommand(workspaceId, (nodes) => command(nodes, input as never));
  if (refused !== null) return;

  const landed = findShowing(useAgentWorkspaceStore.getState().workspaces[workspaceId]?.nodes ?? [], target);
  if (landed !== undefined) store.selectNode(workspaceId, landed.id);
}

/** The node showing this target anywhere in the workspace, at any depth. */
function findShowing(nodes: readonly WorkspaceNode[], target: PaneTarget): PaneNode | undefined {
  return nodes.find(
    (node): node is PaneNode =>
      node.nodeType === 'pane' && node.target?.kind === target.kind && node.target.id === target.id,
  );
}

export const useAgentWorkspaceStore = createStore<AgentWorkspaceState>()(
  persist(
    (set, get) => ({
      workspaces: {},
      sync: {},
      focus: {},
      queueErrors: {},

      hydrateFromServer: (workspaceId, snapshot) => {
        const sync = get().sync[workspaceId] ?? emptySync();
        // An older snapshot than what we already hold tells us nothing (a slow
        // GET landing behind a fast ack, say).
        if (snapshot.rev < sync.rev) return;
        // A body that is not a tree never becomes a base. See `readSnapshotBody`.
        if (!isAdoptableTree(snapshot.nodes)) return;

        // THE NO-OP EARLY-OUT, and it is not a micro-optimisation. The sidebar
        // seats every workspace in the listing on every revalidation — twice a
        // minute at the backstop poll, and once per directory event on top —
        // and without this each of those reallocates `workspaces[id]` and
        // re-renders every tree in the app. Same rev, a base we already have,
        // and nothing local outstanding means there is provably nothing to
        // learn; the targets are compared too, so a RENAME at an unchanged rev
        // still lands (a title is not part of the rev, and pretending it were
        // would strand a renamed thread until its next structural edit).
        if (
          snapshot.rev === sync.rev &&
          sync.base !== null &&
          sync.pending.length === 0 &&
          sameTargetList(sync.targets, snapshot.targets)
        ) {
          return;
        }

        commit(
          workspaceId,
          { ...sync, base: snapshot.nodes, rev: snapshot.rev, targets: snapshot.targets },
          'preserve',
        );
      },

      applyRemoteUpdate: (payload) => {
        const { workspaceId } = payload;
        const sync = get().sync[workspaceId];
        // Not tracking this workspace: nothing to update, and inventing an entry
        // here would RESURRECT a tree the user has closed. Whenever it opens
        // next, its own read gets the truth anyway.
        if (!sync) return;
        // Already at or past this rev — which is also how the SECOND copy of
        // one event is dropped. The same write reaches a user who both owns the
        // workspace and has its grid mounted on two rooms, and this guard is
        // armed synchronously by whichever arrives first.
        if (payload.rev <= sync.rev) return;
        if (!Array.isArray(payload.nodes) || !isAdoptableTree(payload.nodes)) return;
        // The broadcast is STRUCTURAL — it carries no titles, because
        // `session:<id>` is a room and per-viewer redaction is not expressible
        // on that wire. The titles this client already resolved are carried
        // forward as-is; a target that is new here simply has no name until the
        // next authorized read, and renders from what the node itself holds.
        commit(workspaceId, { ...sync, base: payload.nodes, rev: payload.rev }, 'preserve');
      },

      refreshWorkspaceSnapshot: async (workspaceId) => {
        try {
          const response = await fetchWithAuth(nodesUrl(workspaceId));
          if (!response.ok) return false;
          const snapshot = readSnapshotBody(await response.json());
          if (!snapshot) return false;
          get().hydrateFromServer(workspaceId, snapshot);
          return true;
        } catch {
          // Still best-effort for its own sake — the socket's own reconnect, or
          // the next write's 409, brings the truth along. But the caller learns
          // it failed, because a refetch that was covering for a DISCARDED queue
          // leaves the user looking at neither their edit nor the server's
          // state, and that is worth saying out loud.
          return false;
        }
      },

      forgetWorkspace: (workspaceId) => {
        if (!get().sync[workspaceId] && !get().workspaces[workspaceId]) return;
        drop(workspaceId);
      },

      selectNode: (workspaceId, nodeId) => {
        const state = get();
        const tree = state.workspaces[workspaceId];
        if (!tree || tree.activeNodeId === nodeId) return;
        if (!tree.nodes.some((node) => node.nodeType === 'pane' && node.id === nodeId)) return;
        commit(workspaceId, state.sync[workspaceId] ?? emptySync(), {
          activeNodeId: nodeId,
          pendingPickerNodeId: tree.pendingPickerNodeId,
        });
      },

      dismissPicker: (workspaceId, nodeId) => {
        const state = get();
        const tree = state.workspaces[workspaceId];
        if (!tree || tree.pendingPickerNodeId !== nodeId) return;
        commit(workspaceId, state.sync[workspaceId] ?? emptySync(), {
          activeNodeId: tree.activeNodeId,
          pendingPickerNodeId: null,
        });
      },

      runCommand: (workspaceId, run) => {
        const state = get();
        const sync = state.sync[workspaceId] ?? emptySync();
        const current = state.workspaces[workspaceId]?.nodes ?? [];

        // THE WORKSPACE'S BIRTH, mirrored from the server's own write funnel and
        // through the SAME function. A workspace read at rev 0 holds nothing, and
        // every command needs a root to place into; seeding it here is what lets
        // the very first click compose into one write instead of needing a
        // round trip to learn what the grid is called. The id is derived from
        // the workspace, so this client's seed and the server's are the same
        // node and converge on the upsert rather than fighting.
        const { nodes: seated, seed } = seedRoot(current, workspaceId);
        const result = run(seated);
        if (!result.ok) return result.code;

        const write: NodeWrite =
          seed === null ? result.write : { put: [seed, ...result.write.put], drop: result.write.drop };
        // A command that asked for the state the tree is already in writes
        // nothing — the "declined" convention, kept honest so a re-sent click
        // does not bump a rev or broadcast.
        if (isEmptyWrite(write)) return null;

        const entry = makePending(mintId('write'), current, write);
        commit(workspaceId, { ...sync, pending: [...sync.pending, entry] }, 'preserve');
        return null;
      },

      splitPane: (workspaceId, nodeId, axis) => {
        get().runCommand(workspaceId, (nodes) =>
          splitCommand(nodes, { nodeId, axis, newNodeId: mintId('pane'), newSplitId: mintId('split') }),
        );
      },

      closePane: (workspaceId, nodeId) => {
        const tree = get().workspaces[workspaceId];
        if (!tree) return 'noop';
        const node = findNode(tree.nodes, nodeId);
        // Never in this workspace, or not a pane: nothing to close. The command
        // refuses either anyway; answering `noop` lets a caller tell "I did
        // that" from "there was nothing to do".
        if (node === undefined || node.nodeType !== 'pane') return 'noop';
        return get().runCommand(workspaceId, (nodes) => closePaneCommand(nodes, { nodeId })) === null
          ? 'closed'
          : 'noop';
      },

      openConversation: (workspaceId, conversationId, options) => {
        openTarget(workspaceId, { kind: 'chat', id: conversationId }, options, openConversationCommand);
      },

      openPage: (workspaceId, pageId, options) => {
        openTarget(workspaceId, { kind: 'page', id: pageId }, options, openPageCommand);
      },

      openShell: (workspaceId, shellId, options) => {
        openTarget(workspaceId, { kind: 'terminal', id: shellId }, options, openShellCommand);
      },

      showNode: (workspaceId, nodeId) => {
        const refused = get().runCommand(workspaceId, (nodes) => {
          const node = findNode(nodes, nodeId);
          if (node === undefined || node.nodeType !== 'pane') {
            return { ok: false, code: 'not_a_pane', detail: `no pane "${nodeId}" to show` };
          }
          // Already in the tree, which is the only place it can be, so showing
          // it is focus and focus is client-local: no write at all. The branch
          // this replaces moved a PARKED node back onto the grid.
          return { ok: true, write: emptyWrite() };
        });
        if (refused === null) get().selectNode(workspaceId, nodeId);
      },

      bindPane: (workspaceId, nodeId, target) => {
        get().runCommand(workspaceId, (nodes) => bind(nodes, { nodeId, target }));
      },

      unbindPane: (workspaceId, nodeId) => {
        get().runCommand(workspaceId, (nodes) => {
          const node = findNode(nodes, nodeId);
          if (node === undefined || node.nodeType !== 'pane') {
            return { ok: false, code: 'not_a_pane', detail: `no pane "${nodeId}" to send back to the picker` };
          }
          const parentId = node.parentId;
          // The replacement arrives BEFORE the old node leaves, so no group
          // momentarily has a hole in it — in particular a two-child split does
          // not drop to one and collapse under the very command refilling it.
          const index = childrenOf(nodes, parentId).findIndex((sibling) => sibling.id === nodeId) + 1;
          return compile(nodes, [
            (current) => create(current, { nodeId: mintId('pane'), target: null, parentId, index }),
            (current) => destroy(current, { nodeId }),
          ]);
        });
      },
    }),
    {
      name: 'agent-workspace-storage',
      // v3 = the node model. `activePaneId`/`pendingPickerPaneId` named PANE
      // ids in a grid that no longer exists; a v2 payload's ids would resolve
      // to nothing and be normalized away anyway, but the version bump is what
      // actually retires it rather than leaving a dead key in storage.
      version: 3,
      partialize: (state) => ({ focus: state.focus }),
      merge: (persisted, current) => ({ ...current, focus: validatePersistedFocus(persisted) }),
    },
  ),
);

/**
 * `persist`'s `merge` hook. Storage is untyped by construction (a previous
 * schema version, an extension, plain corruption), and this is the one place a
 * foreign value could enter the store — so every entry is shape-checked and
 * anything that fails is dropped rather than repaired. A lost focus preference
 * costs the user nothing: the tree focuses its first pane.
 */
function validatePersistedFocus(persisted: unknown): Record<string, WorkspaceFocus> {
  const parsed = z
    .object({
      focus: z.record(
        z.string(),
        z.object({
          activeNodeId: z.string().min(1).nullable(),
          pendingPickerNodeId: z.string().min(1).nullable(),
        }),
      ),
    })
    .safeParse(persisted);
  return parsed.success ? parsed.data.focus : {};
}

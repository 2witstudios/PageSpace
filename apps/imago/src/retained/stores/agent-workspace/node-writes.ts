/**
 * THE OPTIMISTIC WRITE-SET — the client store's pure half, successor to
 * `verb-queue.ts`.
 *
 * The equation the store keeps true is unchanged in shape and simpler in
 * substance:
 *
 *     rendered = pending.reduce(applyNodeWrite, serverNodes)
 *
 * What changed is what a queue entry IS. The verb queue held twelve wire verbs
 * and replayed them through a reducer, which is why it needed
 * `verbAlreadyLanded`: replaying a `split_right` blind re-inserted its own
 * minted column id. A queue entry here is a WRITE-SET — the `{put, drop}` the
 * algebra already produces — and `upsertNodes` is idempotent by construction, so
 * a write applied twice lands on the same tree. The whole `mintedPaneId` /
 * `mintedColumnId` / `verbAlreadyLanded` apparatus is gone with the shape that
 * needed it.
 *
 * **A write can still stop applying, and that is the case this module exists
 * for.** `applyNodeWrite` is `put`-then-`drop` (the cascade order the algebra
 * documents), and `put` is an UPSERT — so a pending resize of node X, rebased
 * onto a server tree in which somebody else closed and destroyed X, would
 * cheerfully append X back. The pane the user destroyed returns, holding a
 * conversation it no longer shows, and nothing in `validateTree` objects: the
 * resurrected node is structurally fine. Idempotence is not the same property as
 * still-applies, and only the second one can be decided against a base.
 *
 * So every pending write records which ids it MINTED (see {@link makePending}),
 * and {@link rebasePending} refuses one whose `put` names a node that is neither
 * in the tree it is landing on nor minted by the write itself. Refuses, never
 * repairs: a write that no longer applies is dropped whole and the user is told,
 * rather than being partially applied to a tree it was not computed against.
 *
 * Everything here is pure — no zustand, no React, no IO — for the same reason
 * `verb-queue.ts` was.
 */

import {
  applyNodeWrite,
  type NodeWrite,
} from '@pagespace/lib/agent-workspaces/workspace-node-algebra';
import { findNode, type WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import { validateTree } from '@pagespace/lib/agent-workspaces/workspace-node-validate';

/**
 * One local edit awaiting its POST.
 *
 * `minted` is the load-bearing field and the only thing here the algebra does
 * not already give us: the ids this write brought into existence, as measured
 * against the tree it was computed against. Everything else in `put` is a node
 * the write EDITED, and an edit to a node that is gone is not an edit.
 */
export interface PendingWrite {
  /** Local identity — for the in-flight set and for saying which write was dropped. */
  id: string;
  write: NodeWrite;
  /** Ids in `write.put` that were absent from the tree this write was computed against. */
  minted: string[];
}

/** The write that changes nothing. */
export function emptyWrite(): NodeWrite {
  return { put: [], drop: [] };
}

export function isEmptyWrite(write: NodeWrite): boolean {
  return write.put.length === 0 && write.drop.length === 0;
}

/**
 * Record a write against the tree it was computed from, measuring what it
 * minted.
 *
 * `before` is the LOCAL tree the user was looking at — not the server's — which
 * is what makes "minted" mean "this write created it" rather than "the server
 * had not heard of it yet". A pane created by pending write A and resized by
 * pending write B is minted by A only; B edits it, and B correctly stops
 * applying if A is ever dropped.
 */
export function makePending(id: string, before: readonly WorkspaceNode[], write: NodeWrite): PendingWrite {
  return {
    id,
    write,
    minted: write.put.filter((node) => findNode(before, node.id) === undefined).map((node) => node.id),
  };
}

/**
 * Fold several writes into one, for the single `{baseRev, put, drop}` the wire
 * takes.
 *
 * The SAME union rule `compile` applies one layer down, and stated the same way:
 * a later `put` supersedes an earlier `put` or `drop` of the same id, and a later
 * `drop` supersedes an earlier `put`. It is the honest composition of what the
 * writes said they were doing, not the minimal diff against a base — re-sending
 * an unchanged row costs nothing, because the server's own change detection
 * decides whether a rev is minted.
 *
 * A `drop` of an id nothing here ever put is KEPT, deliberately: the wire treats
 * a drop of an absent node as a no-op, and filtering it would need a base this
 * function does not have and should not take.
 */
export function unionWrites(writes: readonly NodeWrite[]): NodeWrite {
  const put = new Map<string, WorkspaceNode>();
  const drop = new Set<string>();
  for (const write of writes) {
    for (const id of write.drop) {
      put.delete(id);
      drop.add(id);
    }
    for (const node of write.put) {
      drop.delete(node.id);
      put.set(node.id, node);
    }
  }
  return { put: [...put.values()], drop: [...drop] };
}

/** Does every node this write EDITS still exist in the tree it is landing on? */
function stillApplies(nodes: readonly WorkspaceNode[], pending: PendingWrite): boolean {
  const minted = new Set(pending.minted);
  return pending.write.put.every((node) => minted.has(node.id) || findNode(nodes, node.id) !== undefined);
}

/** What replaying the queue on a base produced, and what it cost. */
export interface RebaseResult {
  /** The tree to render: the base with every surviving write applied, in order. */
  nodes: WorkspaceNode[];
  /** The writes that still apply — the new queue. */
  kept: PendingWrite[];
  /** The writes that no longer do. Their edits are LOST, and the store says so. */
  dropped: PendingWrite[];
}

/**
 * Replay every unacked write on top of a base — the ONE way the store derives
 * what it renders, after a local edit, after an ack, after a 409, and after a
 * broadcast.
 *
 * Two gates per write, in this order, and both refuse rather than repair:
 *
 *  - **It must still apply.** See the module doc: an upsert of a node the server
 *    destroyed is a resurrection, not an edit.
 *  - **The result must validate.** A write whose parent was destroyed, or whose
 *    slot no longer exists, produces a tree the server would refuse anyway — and
 *    a client that renders a tree the server will not accept is a client
 *    reporting a success that never happened.
 *
 * Sequential, so a write is measured against everything before it: a write that
 * depends on a dropped one is dropped in turn rather than applied to a tree that
 * never got its predecessor.
 */
export function rebasePending(
  base: readonly WorkspaceNode[],
  pending: readonly PendingWrite[],
): RebaseResult {
  let nodes: WorkspaceNode[] = [...base];
  const kept: PendingWrite[] = [];
  const dropped: PendingWrite[] = [];

  for (const entry of pending) {
    if (!stillApplies(nodes, entry)) {
      dropped.push(entry);
      continue;
    }
    const next = applyNodeWrite(nodes, entry.write);
    if (!validateTree(next).ok) {
      dropped.push(entry);
      continue;
    }
    nodes = next;
    kept.push(entry);
  }

  return { nodes, kept, dropped };
}

/**
 * Is this list of nodes something a client may adopt as truth?
 *
 * Applied to every tree arriving from OUTSIDE — the HTTP read and the room
 * broadcast alike. The server validates what it stores, so a valid tree is what
 * a correct server sends; adopting an invalid one anyway would put the store in
 * a state from which every local edit is refused by the very gate the server
 * will apply, with no way for the user to get out except a reload.
 *
 * An EMPTY list is admitted deliberately and is not the same as an invalid one:
 * it is what a workspace that has never been written answers, and the store
 * seats it as "read, and holding nothing" so the first write can seed the root.
 */
export function isAdoptableTree(nodes: readonly WorkspaceNode[]): boolean {
  return nodes.length === 0 || validateTree(nodes).ok;
}

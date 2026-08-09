/**
 * THE WIRE of the flat node model: what `POST /nodes` accepts and what every
 * node-model read returns.
 *
 * One request shape, one response shape, and both declared HERE rather than
 * beside the route — the browser cannot import the route's module (it pulls in
 * `@pagespace/db`), and `workspace-layout-wire.ts` exists for exactly the
 * reason its docblock gives: a wire declared twice is a wire that drifts.
 *
 * **The write is `{baseRev, put, drop}` and nothing else.** No `opId`, and
 * deliberately no successor to `agent_workspace_layout_ops`. That table was the
 * verb route's idempotency memory and it existed for one reason: a replayed
 * `split_right` re-inserted its own client-minted pane id and violated the
 * primary key. The primitive here is an UPSERT of a node set (`upsertNodes` —
 * replace by id where present, append where not), so a retried POST re-applies
 * to the same state by construction. A key that remembers nothing is not a key.
 *
 * **`rootId` is optional on the wire, and checked when present.** A
 * `WorkspaceNode` carries no workspace — that is what makes cross-workspace
 * parenting unspellable in the model (see `workspace-node-rows.ts`) — so most
 * payloads simply omit it. But a client that CACHED what it read holds rows,
 * and rows have one; echoing that field back must not be a way to say "put this
 * node in a different session". Accepting it and silently ignoring it would be
 * worse than either refusing or obeying, because the client would then believe
 * it had moved something. So the field is spellable and a disagreement is a
 * refused write — see {@link nodeOfWire}, which is where the field stops.
 *
 * **Absence is preserved exactly, in both directions.** `fraction` is
 * `.optional()` and an explicit `null` is REFUSED: the absence IS the state
 * ("my parent is unsized"), the client holds the algebra's version optimistically
 * while the server holds the parsed one, and `{}` vs `{fraction: null}` makes
 * every subsequent write look like a change. The same rule the rows translation
 * states, restated at the other boundary because it is the other boundary.
 */

import { z } from 'zod';
import type { PaneTargetKind, WorkspaceNode } from './workspace-node';
import { MAX_NODES } from './workspace-node-validate';

/**
 * A node as it crosses the wire: the model's own shape plus the OPTIONAL scope
 * claim. See the module doc for why `rootId` is spellable at all.
 */
export type WireWorkspaceNode = WorkspaceNode & { rootId?: string };

const nodeAxisSchema = z.enum(['row', 'column']);
const paneTargetKindSchema = z.enum(['chat', 'terminal', 'page']);

/**
 * `.finite()`, and not decoration. JSON cannot spell `NaN`, but it can spell
 * `1e999`, which `JSON.parse` hands back as `Infinity` — and a non-finite share
 * walks straight through `validateTree`'s sum check, because every comparison
 * against a non-finite is false. The validator has its own `fraction_not_finite`
 * gate ahead of the sum for the same reason; this is the outer one, so a
 * non-finite never becomes a node at all.
 */
const fractionSchema = z.number().finite();

/**
 * Every column a `nodeType` must NOT carry is left UNSPELLABLE (the object is
 * strict) rather than pinned to null — the wire is authored by a client holding
 * the union, not by a table holding nine nullable columns, so the shape it
 * should send is the union's own. A pane arriving with an `axis` is a client
 * that does not hold this model, and the honest answer is 400.
 */
const workspaceNodeWireSchema = z.discriminatedUnion('nodeType', [
  z
    .object({
      nodeType: z.literal('root'),
      id: z.string().min(1),
      rootId: z.string().min(1).optional(),
      // Insisted on rather than defaulted. The root is the node whose TYPE says
      // so; its null parent is a consequence, and a payload that disagrees is
      // one whose author is using the null parent as the definition — which is
      // the bug this model exists to remove.
      parentId: z.null(),
      position: z.literal(0),
      axis: nodeAxisSchema,
    })
    .strict(),
  z
    .object({
      nodeType: z.literal('split'),
      id: z.string().min(1),
      rootId: z.string().min(1).optional(),
      /** Never null: a split has no durable target, so a parked one is garbage. */
      parentId: z.string().min(1),
      position: z.number().int().min(0),
      axis: nodeAxisSchema,
      fraction: fractionSchema.optional(),
    })
    .strict(),
  z
    .object({
      nodeType: z.literal('pane'),
      id: z.string().min(1),
      rootId: z.string().min(1).optional(),
      /** Null here means DETACHED — in the workspace, off the grid. */
      parentId: z.string().min(1).nullable(),
      position: z.number().int().min(0),
      fraction: fractionSchema.optional(),
      /**
       * The binding as ONE value. `PaneTarget` is an object precisely so a
       * half-bound pane — a kind with no id, an id with no kind — cannot be
       * spelled; splitting it across two wire fields would hand that state back.
       */
      target: z
        .object({ kind: paneTargetKindSchema, id: z.string().min(1) })
        .strict()
        .nullable(),
    })
    .strict(),
]);

/**
 * `POST /api/agent-workspaces/[workspaceId]/nodes`.
 *
 * Both arrays are bounded by {@link MAX_NODES} — the same cap `validateTree`
 * enforces on the RESULT, applied to the payload so a request that could not
 * possibly produce a valid tree is refused before it is parsed into one.
 */
export const workspaceNodeWriteRequestSchema = z
  .object({
    /** The rev the caller reduced against; anything but the current rev answers 409 + truth. */
    baseRev: z.number().int().min(0),
    put: z.array(workspaceNodeWireSchema).max(MAX_NODES),
    drop: z.array(z.string().min(1)).max(MAX_NODES),
  })
  .strict();

/**
 * Drop the scope claim, producing the node the model actually holds.
 *
 * Written as a switch rather than a rest-destructure, for the reason
 * `rowFromNode` is: a rest over a discriminated union loses the discrimination,
 * and the resulting cast would be a lie the type checker vouches for. Every
 * field is named, and `fraction`'s ABSENCE survives — which is the whole point
 * of the boundary.
 *
 * This is where `rootId` stops. A node's workspace is decided by the URL and
 * carried by {@link rowFromNode}'s parameter, never by anything the payload
 * said — so even a caller whose scope claim was somehow not checked cannot
 * write into another session.
 */
export function nodeOfWire(wire: WireWorkspaceNode): WorkspaceNode {
  switch (wire.nodeType) {
    case 'root':
      return { nodeType: 'root', id: wire.id, parentId: null, position: 0, axis: wire.axis };
    case 'split':
      return {
        nodeType: 'split',
        id: wire.id,
        parentId: wire.parentId,
        position: wire.position,
        axis: wire.axis,
        ...(wire.fraction === undefined ? {} : { fraction: wire.fraction }),
      };
    case 'pane':
      return {
        nodeType: 'pane',
        id: wire.id,
        parentId: wire.parentId,
        position: wire.position,
        ...(wire.fraction === undefined ? {} : { fraction: wire.fraction }),
        target: wire.target,
      };
  }
}

/**
 * ONE resolved target beside the tree, never inside it.
 *
 * **Titles are authority, not decoration.** A node's `targetId` is whatever the
 * write that bound it supplied, so resolving a title without asking "may this
 * viewer see it" turns a layout read into a title oracle over every
 * conversation, shell and page in the system (security review HIGH 1). That is
 * why they ride BESIDE the nodes: the tree is structural and identical for every
 * member of a workspace, so it can be broadcast to a room; the titles are
 * resolved and redacted once per viewer and can only ever be part of an answer
 * to one caller.
 *
 * A target the viewer may not read — or that no longer exists — simply has NO
 * entry. Refusing to resolve is deliberately indistinguishable from "gone", so
 * the join is not an existence oracle either.
 */
export interface WorkspaceNodeTarget {
  id: string;
  kind: PaneTargetKind;
  /** Already redacted for this viewer; may be the `(private thread)` marker. */
  title: string;
  /**
   * The conversation's last activity, ISO-8601 — `null` for a kind that has no
   * such fact. The sidebar orders members by recency, and once it stops reading
   * `session.conversations` this is where that ordering comes from.
   */
  lastMessageAt: string | null;
}

/**
 * What every node-model read answers, and what the write answers on BOTH 200
 * and 409. The 409 body is the truth to rebase against, so it must be the same
 * shape and must not say more than a GET would.
 */
export interface WorkspaceNodeSnapshotResponse {
  rev: number;
  nodes: WorkspaceNode[];
  targets: WorkspaceNodeTarget[];
}

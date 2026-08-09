/**
 * `decideNodeWrite` — THE ILLEGAL INPUTS.
 *
 * Every real bug in this epic came from an input nobody named, so this suite is
 * organised around what the write must REFUSE rather than around what it does.
 * Two properties are asserted on every refusal path and are the point of the
 * whole file:
 *
 *  * nothing is written — the decision carries no `persist` at all; and
 *  * nothing is REPAIRED. No `parentId` is reassigned, no dangling child is
 *    re-attached to the root, no offending node is quietly dropped. The
 *    `parentId`-assignment count on every failure path here is zero, and
 *    `parentIdsOf` below is what makes that a measurement rather than a claim.
 */
import { describe, it, expect } from 'vitest';
import { decideNodeWrite } from '../workspace-node-write';
import { applyNodeWrite } from '../workspace-node-algebra';
import { validateTree } from '../workspace-node-validate';
import { workspaceNodeWriteRequestSchema } from '../workspace-node-wire';
import type { WireWorkspaceNode } from '../workspace-node-wire';
import type { PaneNode, RootNode, SplitNode, WorkspaceNode } from '../workspace-node';

const WORKSPACE = 'ws-1';

const root = (axis: 'row' | 'column' = 'row'): RootNode => ({
  nodeType: 'root',
  id: 'root',
  parentId: null,
  position: 0,
  axis,
});

const pane = (
  id: string,
  parentId: string,
  position: number,
  extra: Partial<Pick<PaneNode, 'fraction' | 'target'>> = {},
): PaneNode => ({
  nodeType: 'pane',
  id,
  parentId,
  position,
  target: extra.target ?? null,
  ...(extra.fraction === undefined ? {} : { fraction: extra.fraction }),
});

const split = (
  id: string,
  parentId: string,
  position: number,
  axis: 'row' | 'column',
  fraction?: number,
): SplitNode => ({
  nodeType: 'split',
  id,
  parentId,
  position,
  axis,
  ...(fraction === undefined ? {} : { fraction }),
});

/** root ─ pane-a, pane-b. The smallest workspace that is more than a root. */
const TWO_PANES: WorkspaceNode[] = [root(), pane('pane-a', 'root', 0), pane('pane-b', 'root', 1)];

function decide(nodes: readonly WorkspaceNode[], over: Partial<Parameters<typeof decideNodeWrite>[0]> = {}) {
  return decideNodeWrite({
    workspaceId: WORKSPACE,
    rev: 4,
    nodes,
    baseRev: 4,
    put: [],
    drop: [],
    ...over,
  });
}

/**
 * Every `parentId` a decision would write. The measurement behind "no repair":
 * on a refusal there is no write, so there is nothing to count, and on a success
 * every value here came from the CALLER.
 */
function parentIdsOf(decision: ReturnType<typeof decideNodeWrite>): Array<string | null> {
  return decision.status === 'ok' ? decision.persist.put.map((node) => node.parentId) : [];
}

describe('a payload naming ANOTHER workspace', () => {
  it('refuses the ENTIRE write, not just the offending node', () => {
    const decision = decide(TWO_PANES, {
      put: [
        { ...pane('pane-a', 'root', 0), rootId: 'ws-somebody-else' },
        { ...pane('pane-b', 'root', 1) },
      ],
    });
    expect(decision.status).toBe('foreign_scope');
    expect(parentIdsOf(decision)).toEqual([]);
  });

  it('refuses BEFORE the rev check, so a cross-workspace payload is never invited to rebase', () => {
    // Stale AND foreign. Answering 409 + truth here would hand the caller a
    // fresh rev to re-send the same reassignment against.
    const decision = decide(TWO_PANES, {
      baseRev: 1,
      put: [{ ...pane('pane-a', 'root', 0), rootId: 'ws-somebody-else' }],
    });
    expect(decision.status).toBe('foreign_scope');
  });

  it('accepts a payload that names THIS workspace, and accepts one that names none', () => {
    const named = decide(TWO_PANES, { put: [{ ...pane('pane-a', 'root', 1), rootId: WORKSPACE }] });
    const silent = decide(TWO_PANES, { put: [pane('pane-a', 'root', 1)] });
    // Both reach the tree checks rather than the scope one; the position swap
    // below is what makes them not no-ops.
    expect(named.status).not.toBe('foreign_scope');
    expect(silent.status).not.toBe('foreign_scope');
  });
});

describe('a stale baseRev', () => {
  it('is told to rebase, and writes nothing', () => {
    expect(decide(TWO_PANES, { baseRev: 3 }).status).toBe('stale');
  });

  it('is stale when it is AHEAD of the server too — a rev nobody has minted is not a base', () => {
    // A client that has somehow run ahead is exactly as unable to describe the
    // stored tree as one that has fallen behind, and `>=` would let its
    // arithmetic through.
    expect(decide(TWO_PANES, { baseRev: 9 }).status).toBe('stale');
  });
});

describe('a drop naming a node that is not there', () => {
  it('is a no-op, because that is precisely what a REPLAY looks like', () => {
    // The first POST removed it; the retry names it again. Refusing here would
    // turn the replay the wire promises is a no-op into a 4xx.
    const decision = decide(TWO_PANES, { drop: ['pane-gone'] });
    expect(decision.status).toBe('ok');
    if (decision.status !== 'ok') return;
    expect(decision.changed).toBe(false);
    expect(decision.persist).toEqual({ put: [], drop: [] });
  });
});

describe('a put that orphans a subtree', () => {
  it('refuses a node whose parent the write removed — never re-attaches it to the root', () => {
    const nodes = [root(), split('col', 'root', 0, 'column'), pane('p1', 'col', 0), pane('p2', 'col', 1)];
    const decision = decide(nodes, { drop: ['col'] });
    expect(decision.status).toBe('invalid');
    if (decision.status !== 'invalid') return;
    expect(decision.code).toBe('dangling_parent');
    // THE COUNT. A re-parent here is the exact bug the model exists to delete:
    // a pane restructured into a place the user never put it.
    expect(parentIdsOf(decision)).toEqual([]);
  });

  it('refuses a put naming a parent that does not exist at all', () => {
    const decision = decide(TWO_PANES, { put: [pane('pane-a', 'col-that-was-deleted', 0)] });
    expect(decision.status).toBe('invalid');
    if (decision.status !== 'invalid') return;
    expect(decision.code).toBe('dangling_parent');
    expect(parentIdsOf(decision)).toEqual([]);
  });
});

describe('a payload that empties the tree entirely', () => {
  it('ACCEPTS dropping the root and everything under it — that write is how a session ends', () => {
    // The top half of the correction, arriving at the write path. `destroy(root)`
    // produces exactly this payload, and a write path that answered `no_root`
    // would make the tree operation that ends a session a tree operation the
    // server refuses — which is how ending a session became a second mechanism
    // in the first place.
    const decision = decide(TWO_PANES, { drop: ['root', 'pane-a', 'pane-b'] });
    expect(decision.status).toBe('ok');
    if (decision.status !== 'ok') return;
    expect(decision.nodes).toEqual([]);
    expect(decision.changed).toBe(true);
    expect(decision.persist.drop.slice().sort()).toEqual(['pane-a', 'pane-b', 'root']);
  });

  it('still refuses a payload that leaves nodes behind with no root to hold them', () => {
    // A NON-EMPTY list with no root is a workspace whose rows lost their top,
    // which is a fault. The difference from the case above is the whole reason
    // `rootOf` finds the root by TYPE rather than by "the node with no parent".
    const decision = decide(TWO_PANES, { drop: ['root'] });
    expect(decision.status).toBe('invalid');
    if (decision.status !== 'invalid') return;
    expect(decision.code).toBe('no_root');
  });

  it('accepts a root holding nothing — closing the last pane is an ordinary state', () => {
    const decision = decide(TWO_PANES, { drop: ['pane-a', 'pane-b'] });
    expect(decision.status).toBe('ok');
    if (decision.status !== 'ok') return;
    expect(decision.nodes).toEqual([root()]);
  });
});

describe('an id that names two nodes', () => {
  it('refuses a put carrying the same id twice', () => {
    // `upsertNodes` appends both, because neither is already present — so the
    // collision reaches the tree rather than being silently deduplicated into
    // whichever half a `Map` happened to keep.
    const decision = decide(TWO_PANES, {
      put: [pane('pane-new', 'root', 2), pane('pane-new', 'root', 3)],
    });
    expect(decision.status).toBe('invalid');
    if (decision.status !== 'invalid') return;
    expect(decision.code).toBe('duplicate_id');
  });

  it('refuses a put that would give the workspace a second root', () => {
    const decision = decide(TWO_PANES, { put: [{ ...root(), id: 'root-2' }] });
    expect(decision.status).toBe('invalid');
    if (decision.status !== 'invalid') return;
    // Reported as unreachable rather than as a second root: the fixed violation
    // order settles the dangling/reachability questions first, and a second root
    // descends from nothing.
    expect(['multiple_roots', 'unreachable']).toContain(decision.code);
  });
});

describe('a conversation the payload would show twice', () => {
  it('refuses, because the TABLE refuses — an algebra laxer than its storage is a raw index violation later', () => {
    const nodes = [
      root(),
      pane('pane-a', 'root', 0, { target: { kind: 'chat', id: 'conv-1' } }),
      pane('pane-b', 'root', 1),
    ];
    const decision = decide(nodes, {
      put: [pane('pane-b', 'root', 1, { target: { kind: 'chat', id: 'conv-1' } })],
    });
    expect(decision.status).toBe('invalid');
    if (decision.status !== 'invalid') return;
    expect(decision.code).toBe('duplicate_chat_target');
  });

  it('allows the same PAGE in two panes — that is a thing a user legitimately does', () => {
    const nodes = [
      root(),
      pane('pane-a', 'root', 0, { target: { kind: 'page', id: 'page-1' } }),
      pane('pane-b', 'root', 1),
    ];
    const decision = decide(nodes, {
      put: [pane('pane-b', 'root', 1, { target: { kind: 'page', id: 'page-1' } })],
    });
    expect(decision.status).toBe('ok');
  });
});

describe('a fraction that is not a share of anything', () => {
  it('is refused at the WIRE, so it never becomes a node', () => {
    // JSON cannot spell NaN, but `1e999` parses to Infinity — and a non-finite
    // walks through the validator's SUM check, since every comparison against it
    // is false.
    const parsed = workspaceNodeWriteRequestSchema.safeParse({
      baseRev: 0,
      drop: [],
      put: [{ nodeType: 'pane', id: 'p', parentId: 'root', position: 0, target: null, fraction: 1e999 }],
    });
    expect(parsed.success).toBe(false);
  });

  it('is refused by the tree checks too, if it ever arrives another way', () => {
    const decision = decide(TWO_PANES, {
      put: [pane('pane-a', 'root', 0, { fraction: Number.NaN }), pane('pane-b', 'root', 1, { fraction: 0.5 })],
    });
    expect(decision.status).toBe('invalid');
    if (decision.status !== 'invalid') return;
    expect(decision.code).toBe('fraction_not_finite');
  });

  it('refuses an EXPLICIT null fraction on the wire — absence is the state, never a null', () => {
    // A tree the algebra built and one parsed from the wire must be
    // byte-identical, or every write looks like a change.
    const parsed = workspaceNodeWriteRequestSchema.safeParse({
      baseRev: 0,
      drop: [],
      put: [{ nodeType: 'pane', id: 'p', parentId: 'root', position: 0, target: null, fraction: null }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('a node named in BOTH put and drop', () => {
  it('resolves as "put wins", and the storage instruction agrees with the tree', () => {
    // `decideNodeWrite` is drop-then-upsert, so the node survives. The DELETE
    // must therefore not name it — otherwise the cascade would take its
    // children while the validated tree still holds them.
    //
    // The name in that first sentence used to be `applyNodeWrite`, which folds
    // the other way (put-then-drop, so the node would be GONE). The decision
    // asserted here is right and load-bearing; only the attribution was wrong,
    // and it mattered because it made the algebra look like the authority for a
    // resolution the algebra does not share.
    const nodes = [root(), split('col', 'root', 0, 'column'), pane('p1', 'col', 0), pane('p2', 'col', 1)];
    const decision = decide(nodes, { drop: ['col'], put: [split('col', 'root', 0, 'column')] });
    expect(decision.status).toBe('ok');
    if (decision.status !== 'ok') return;
    expect(decision.persist.drop).toEqual([]);
    expect(decision.nodes.map((node) => node.id).sort()).toEqual(['col', 'p1', 'p2', 'root']);
  });
});

describe('THE CASCADE — a container that collapses while its subtree survives', () => {
  /**
   * The shape a review found against PostgreSQL 17.5 with migration 0255
   * applied: `R → s1 → { s2 → {a, b}, c }`, plus `R → d`. Moving `c` up to the
   * root leaves `s1` holding one child, so the algebra collapses it: `s1` is
   * DROPPED and `s2` inherits its place. Panes `a` and `b` never moved, so they
   * are correctly absent from `put` — and the table's `ON DELETE CASCADE`
   * self-FK would take them with `s1`.
   */
  const collapsing = (): WorkspaceNode[] => [
    root(),
    split('s1', 'root', 0, 'column', 0.5),
    split('s2', 's1', 0, 'row', 0.5),
    pane('a', 's2', 0, { fraction: 0.5 }),
    pane('b', 's2', 1, { fraction: 0.5 }),
    pane('c', 's1', 1, { fraction: 0.5 }),
    pane('d', 'root', 1, { fraction: 0.5 }),
  ];

  it('rescues the surviving subtree into the upsert, so the cascade cannot eat it', () => {
    const nodes = collapsing();
    // What the algebra's collapse emits: drop the container, re-parent the
    // survivor. `a` and `b` are deliberately NOT named.
    const decision = decide(nodes, {
      drop: ['s1'],
      put: [
        split('s2', 'root', 0, 'row', 0.5),
        pane('c', 'root', 1, { fraction: 0.25 }),
        pane('d', 'root', 2, { fraction: 0.25 }),
      ],
    });
    expect(decision.status).toBe('ok');
    if (decision.status !== 'ok') return;

    // The validated tree keeps them...
    expect(decision.nodes.map((node) => node.id).sort()).toEqual(['a', 'b', 'c', 'd', 'root', 's2']);
    // ...and so does the STORAGE INSTRUCTION, which is the half that was
    // missing. Without the rescue, `a` and `b` are deleted by the cascade and
    // never re-inserted: the write reports success and the next read comes back
    // two panes short.
    const written = decision.persist.put.map((node) => node.id).sort();
    expect(written).toContain('a');
    expect(written).toContain('b');
    expect(decision.persist.drop).toEqual(['s1']);
  });

  it('rescues them UNCHANGED — a rescue relocates nothing', () => {
    const nodes = collapsing();
    const decision = decide(nodes, {
      drop: ['s1'],
      put: [
        split('s2', 'root', 0, 'row', 0.5),
        pane('c', 'root', 1, { fraction: 0.25 }),
        pane('d', 'root', 2, { fraction: 0.25 }),
      ],
    });
    if (decision.status !== 'ok') throw new Error('expected ok');
    const rescued = decision.persist.put.filter((node) => node.id === 'a' || node.id === 'b');
    // Same parent, same slot, same share as before the write. The rescue exists
    // to make the database agree with the tree, never to move anything.
    expect(rescued).toEqual([pane('a', 's2', 0, { fraction: 0.5 }), pane('b', 's2', 1, { fraction: 0.5 })]);
  });

  it('does NOT rescue a subtree that is genuinely being destroyed', () => {
    const nodes = collapsing();
    // Destroying `s2` takes `a` and `b` with it — the cascade is the whole point
    // there, and re-inserting them would resurrect what the caller removed.
    // `s2` and its panes go; `s1` is then a split holding one child, so it
    // collapses and `c` takes its place — the same shape as above, minus the
    // survivors.
    const decision = decide(nodes, {
      drop: ['s2', 'a', 'b', 's1'],
      put: [pane('c', 'root', 0, { fraction: 0.5 }), pane('d', 'root', 1, { fraction: 0.5 })],
    });
    expect(decision.status).toBe('ok');
    if (decision.status !== 'ok') return;
    // Only `c` moved — `d` was already exactly where the payload puts it, and a
    // re-sent unchanged node is not a write.
    expect(decision.persist.put.map((node) => node.id)).toEqual(['c']);
    expect(decision.persist.drop.sort()).toEqual(['a', 'b', 's1', 's2']);
  });
});

describe('a write that changes nothing', () => {
  it('re-sending the stored nodes verbatim bumps no rev and broadcasts nothing', () => {
    const decision = decide(TWO_PANES, { put: TWO_PANES });
    expect(decision.status).toBe('ok');
    if (decision.status !== 'ok') return;
    expect(decision.changed).toBe(false);
    expect(decision.persist).toEqual({ put: [], drop: [] });
  });

  it('a fraction that survived a float4 round trip is not a change', () => {
    // The column is a Postgres `real`, so the value read back is not the double
    // that was written. Without one shared quantization every re-send of a sized
    // tree would look like a change, bump a rev and broadcast.
    const sized: WorkspaceNode[] = [
      root(),
      pane('pane-a', 'root', 0, { fraction: 0.3 }),
      pane('pane-b', 'root', 1, { fraction: 0.7 }),
    ];
    const decision = decide(sized, {
      put: [
        pane('pane-a', 'root', 0, { fraction: 0.30000001192092896 }),
        pane('pane-b', 'root', 1, { fraction: 0.699999988079071 }),
      ],
    });
    expect(decision.status).toBe('ok');
    if (decision.status !== 'ok') return;
    expect(decision.changed).toBe(false);
  });

  it('a real move IS a change, and reports only the nodes that moved', () => {
    const decision = decide(TWO_PANES, {
      put: [pane('pane-a', 'root', 1), pane('pane-b', 'root', 0)],
    });
    expect(decision.status).toBe('ok');
    if (decision.status !== 'ok') return;
    expect(decision.changed).toBe(true);
    expect(decision.persist.put.map((node) => node.id).sort()).toEqual(['pane-a', 'pane-b']);
    // Every parent here came from the caller. Nothing was chosen.
    expect(parentIdsOf(decision)).toEqual(['root', 'root']);
  });
});

describe('the wire schema', () => {
  it('refuses a pane carrying an axis, and a split carrying a target', () => {
    const paneWithAxis = workspaceNodeWriteRequestSchema.safeParse({
      baseRev: 0,
      drop: [],
      put: [{ nodeType: 'pane', id: 'p', parentId: 'root', position: 0, target: null, axis: 'row' }],
    });
    const splitWithTarget = workspaceNodeWriteRequestSchema.safeParse({
      baseRev: 0,
      drop: [],
      put: [{ nodeType: 'split', id: 's', parentId: 'root', position: 0, axis: 'row', target: null }],
    });
    expect(paneWithAxis.success).toBe(false);
    expect(splitWithTarget.success).toBe(false);
  });

  it('refuses a half-bound pane — a kind with no id is not a partially bound pane, it is a corrupt one', () => {
    const parsed = workspaceNodeWriteRequestSchema.safeParse({
      baseRev: 0,
      drop: [],
      put: [{ nodeType: 'pane', id: 'p', parentId: 'root', position: 0, target: { kind: 'chat' } }],
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a root that claims a parent, and a split that claims none', () => {
    const rootWithParent = workspaceNodeWriteRequestSchema.safeParse({
      baseRev: 0,
      drop: [],
      put: [{ nodeType: 'root', id: 'root', parentId: 'x', position: 0, axis: 'row' }],
    });
    const detachedSplit = workspaceNodeWriteRequestSchema.safeParse({
      baseRev: 0,
      drop: [],
      put: [{ nodeType: 'split', id: 's', parentId: null, position: 0, axis: 'row' }],
    });
    expect(rootWithParent.success).toBe(false);
    expect(detachedSplit.success).toBe(false);
  });

  it('preserves the ABSENCE of a fraction through the parse', () => {
    const parsed = workspaceNodeWriteRequestSchema.parse({
      baseRev: 0,
      drop: [],
      put: [{ nodeType: 'pane', id: 'p', parentId: 'root', position: 0, target: null }],
    });
    const node: WireWorkspaceNode = parsed.put[0];
    expect('fraction' in node).toBe(false);
  });
});

describe('a write that MOVES a conversation between nodes in one commit', () => {
  /**
   * The reviewer's scenario (PR #2378, CodeRabbit on `.pu-reports/pu-fix-xws.md`):
   * a client rebases, and its replayed write drops the node currently bound to a
   * conversation while putting a different node bound to the same one. The
   * concern was that this is "permanently rejected" — that `target_already_shown`
   * fires on a target which is unique in the tree the write is ASKING FOR.
   *
   * It is not, and the reason is worth pinning rather than re-deriving: the
   * refusal is a property of the FINAL tree, never of the intermediate one.
   * `applyNodeWrite` puts before it drops, so both nodes exist for an instant in
   * the middle — and nothing validates the middle. `validateTree` sees only what
   * the write settles on.
   *
   * The database agrees by a different route: `writeWorkspaceNodes` issues its
   * DELETE before its INSERT, so the partial unique index never sees the pair
   * either. Two layers, one answer, and neither is load-bearing alone.
   */
  const chat = { kind: 'chat' as const, id: 'conv-moving' };

  const before: WorkspaceNode[] = [
    { nodeType: 'root', id: 'root', parentId: null, position: 0, axis: 'row' },
    { nodeType: 'pane', id: 'pane-old', parentId: 'root', position: 0, target: chat },
  ];

  it('is accepted, because the target is unique in the tree the write asks for', () => {
    const after = applyNodeWrite(before, {
      put: [{ nodeType: 'pane', id: 'pane-new', parentId: 'root', position: 0, target: chat }],
      drop: ['pane-old'],
    });

    expect(after.map((node) => node.id).sort()).toEqual(['pane-new', 'root']);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('is refused when the write KEEPS both — the same put without the drop', () => {
    // The mutation that proves the test above is testing the drop and not the
    // put: leave `pane-old` in place and the same payload becomes the duplicate
    // the constraint exists to refuse.
    const after = applyNodeWrite(before, {
      put: [{ nodeType: 'pane', id: 'pane-new', parentId: 'root', position: 1, target: chat }],
      drop: [],
    });

    expect(validateTree(after)).toMatchObject({ ok: false, code: 'duplicate_chat_target' });
  });
});

/**
 * The row boundary of the workspace NODE model — `nodeFromRow`/`rowFromNode`,
 * and the render tree derived from a flat node list.
 *
 * Every read from Postgres and every write to it goes through these two
 * functions, so a lossy round-trip is not a cosmetic defect: the client's
 * optimistic list and the server's rehydrated one would differ on every write,
 * which is the exact class of divergence this model exists to delete. The suite
 * is therefore written around the round-trip rather than around either
 * direction on its own.
 *
 * Sibling of `workspace-node.test.ts`, which covers the flat-list primitives.
 */
import { describe, it, expect } from 'vitest';
import type { PaneNode, RootNode, SplitNode, WorkspaceNode } from '../workspace-node';
import {
  buildRenderTree,
  nodeFromRow,
  nodesFromRows,
  rowFromNode,
  type RenderNode,
  type WorkspaceNodeRow,
} from '../workspace-node-rows';
import {
  applyNodeWrite,
  create,
  resize,
  type NodeOperationResult,
  type NodeWrite,
} from '../workspace-node-algebra';

function rootRow(overrides: Partial<WorkspaceNodeRow> = {}): WorkspaceNodeRow {
  return {
    id: 'root-1',
    rootId: 'root-1',
    parentId: null,
    position: 0,
    nodeType: 'root',
    axis: 'row',
    fraction: null,
    targetKind: null,
    targetId: null,
    ...overrides,
  };
}

function splitRow(overrides: Partial<WorkspaceNodeRow> = {}): WorkspaceNodeRow {
  return {
    id: 'split-1',
    rootId: 'root-1',
    parentId: 'root-1',
    position: 0,
    nodeType: 'split',
    axis: 'column',
    fraction: null,
    targetKind: null,
    targetId: null,
    ...overrides,
  };
}

function paneRow(overrides: Partial<WorkspaceNodeRow> = {}): WorkspaceNodeRow {
  return {
    id: 'pane-1',
    rootId: 'root-1',
    parentId: 'root-1',
    position: 0,
    nodeType: 'pane',
    axis: null,
    fraction: null,
    targetKind: 'chat',
    targetId: 'conv-1',
    ...overrides,
  };
}

describe('nodeFromRow', () => {
  it('should read a root row as a root node, dropping the workspace-addressing column', () => {
    expect(nodeFromRow(rootRow())).toStrictEqual({
      nodeType: 'root',
      id: 'root-1',
      parentId: null,
      position: 0,
      axis: 'row',
    });
  });

  it('should read a split row as a split node', () => {
    expect(nodeFromRow(splitRow({ id: 'col', position: 2 }))).toStrictEqual({
      nodeType: 'split',
      id: 'col',
      parentId: 'root-1',
      position: 2,
      axis: 'column',
    });
  });

  it('should read a bound pane row as a pane carrying one target object', () => {
    expect(nodeFromRow(paneRow({ targetKind: 'terminal', targetId: 'shell-9' }))).toStrictEqual({
      nodeType: 'pane',
      id: 'pane-1',
      parentId: 'root-1',
      position: 0,
      target: { kind: 'terminal', id: 'shell-9' },
    });
  });

  it('should read a pane row with no target columns as an unbound pane', () => {
    expect(nodeFromRow(paneRow({ targetKind: null, targetId: null }))).toStrictEqual({
      nodeType: 'pane',
      id: 'pane-1',
      parentId: 'root-1',
      position: 0,
      target: null,
    });
  });

  it('should REFUSE a pane row with a null parent, which is a corrupt row and not a parked pane', () => {
    // The correction, stated at the boundary that reads storage. This used to
    // parse cleanly and mean "detached": in the workspace, off the screen. So a
    // row whose parent had been nulled — a bad write, a half-run migration, a
    // hand-run UPDATE — became a legal node no renderer would draw, and was
    // indistinguishable from a pane the user had closed. The TYPE makes it
    // unspellable in memory; `parentId text` still takes NULL from anything that
    // writes it, so the parse is what stands between such a row and the model.
    expect(() => nodeFromRow(paneRow({ parentId: null }))).toThrow();
  });

  it('should still read the ROOT row, whose null parent is a consequence of its type', () => {
    expect(nodeFromRow(rootRow())).toStrictEqual({
      nodeType: 'root',
      id: 'root-1',
      parentId: null,
      position: 0,
      axis: 'row',
    });
  });

  it('should leave a null fraction column ABSENT on the node, never present as null or undefined', () => {
    // The absence IS the state. A node carrying an explicit `fraction: null`
    // (or an explicit `undefined` key) is not equal to one the algebra built,
    // so every write would look like a change.
    const node = nodeFromRow(splitRow({ fraction: null }));
    expect(Object.keys(node)).not.toContain('fraction');
  });

  it('should carry a fraction that the column actually holds, including zero', () => {
    expect(nodeFromRow(splitRow({ fraction: 0 }))).toStrictEqual({
      nodeType: 'split',
      id: 'split-1',
      parentId: 'root-1',
      position: 0,
      axis: 'column',
      fraction: 0,
    });
  });

  it('should reject a root row that carries a parent, because a null parent is not what makes a root', () => {
    expect(() => nodeFromRow(rootRow({ parentId: 'somebody' }))).toThrow();
  });

  it('should reject a root row ordered anywhere but first', () => {
    expect(() => nodeFromRow(rootRow({ position: 3 }))).toThrow();
  });

  it('should reject a split row with no axis, because a container with no direction cannot render', () => {
    expect(() => nodeFromRow(splitRow({ axis: null }))).toThrow();
  });

  it('should reject a split row with a null parent, because only the root has none', () => {
    expect(() => nodeFromRow(splitRow({ parentId: null }))).toThrow();
  });

  it('should reject a split row that carries a target, because only a leaf shows anything', () => {
    expect(() => nodeFromRow(splitRow({ targetKind: 'chat', targetId: 'conv-1' }))).toThrow();
  });

  it('should reject a pane row that carries an axis, because a leaf splits nothing', () => {
    expect(() => nodeFromRow(paneRow({ axis: 'row' }))).toThrow();
  });

  it('should reject a half-bound pane row with a kind and no id', () => {
    expect(() => nodeFromRow(paneRow({ targetKind: 'chat', targetId: null }))).toThrow();
  });

  it('should reject a half-bound pane row with an id and no kind', () => {
    expect(() => nodeFromRow(paneRow({ targetKind: null, targetId: 'conv-1' }))).toThrow();
  });
});

describe('nodesFromRows', () => {
  it('should read a workspace’s rows as nodes, in the order they arrived', () => {
    const rows = [rootRow(), paneRow({ id: 'a' }), paneRow({ id: 'b', position: 1 })];
    expect(nodesFromRows(rows, 'root-1').map((node) => node.id)).toEqual(['root-1', 'a', 'b']);
  });

  it('should reject a row set that mixes workspaces rather than silently dropping the foreigner', () => {
    // A pane restructuring itself into somebody else's session is the failure
    // this exists to make impossible. Dropping the foreign row would hide a
    // corrupt read AND make a pane vanish — two bugs for the price of one.
    const rows = [rootRow(), paneRow({ id: 'ours' }), paneRow({ id: 'theirs', rootId: 'root-2' })];
    expect(() => nodesFromRows(rows, 'root-1')).toThrow();
  });

  it('should reject an internally consistent row set that belongs to a different workspace', () => {
    // Every row agrees with every other; they just are not the caller's. A read
    // scoped to the wrong workspace is a bug in the query, not a set to adopt.
    const rows = [rootRow({ rootId: 'root-2' }), paneRow({ rootId: 'root-2' })];
    expect(() => nodesFromRows(rows, 'root-1')).toThrow();
  });

  it('should name the foreign workspace in the error, so a corrupt read is diagnosable', () => {
    const rows = [rootRow(), paneRow({ id: 'theirs', rootId: 'root-2' })];
    expect(() => nodesFromRows(rows, 'root-1')).toThrow(/root-2/);
  });

  it('should reject the whole set when a single row contradicts its own type', () => {
    // One corrupt row poisons the read: a partial list would render a workspace
    // that is missing a pane, which is indistinguishable from one the user closed.
    const rows = [rootRow(), splitRow({ axis: null })];
    expect(() => nodesFromRows(rows, 'root-1')).toThrow();
  });
});

function rootNode(overrides: Partial<RootNode> = {}): RootNode {
  return { nodeType: 'root', id: 'root-1', parentId: null, position: 0, axis: 'row', ...overrides };
}

function splitNode(overrides: Partial<SplitNode> = {}): SplitNode {
  return { nodeType: 'split', id: 'split-1', parentId: 'root-1', position: 0, axis: 'column', ...overrides };
}

function paneNode(overrides: Partial<PaneNode> = {}): PaneNode {
  return {
    nodeType: 'pane',
    id: 'pane-1',
    parentId: 'root-1',
    position: 0,
    target: { kind: 'chat', id: 'conv-1' },
    ...overrides,
  };
}

describe('rowFromNode', () => {
  it('should write a root as a row scoped to the workspace it was given', () => {
    expect(rowFromNode(rootNode(), 'root-1')).toStrictEqual({
      id: 'root-1',
      rootId: 'root-1',
      parentId: null,
      position: 0,
      nodeType: 'root',
      axis: 'row',
      fraction: null,
      targetKind: null,
      targetId: null,
    });
  });

  it('should write a split’s axis and leave every leaf column null', () => {
    expect(rowFromNode(splitNode({ id: 'col', position: 2, fraction: 0.25 }), 'root-1')).toStrictEqual({
      id: 'col',
      rootId: 'root-1',
      parentId: 'root-1',
      position: 2,
      nodeType: 'split',
      axis: 'column',
      fraction: 0.25,
      targetKind: null,
      targetId: null,
    });
  });

  it('should write an ABSENT fraction as a null column, the only spelling a column has for it', () => {
    expect(rowFromNode(splitNode(), 'root-1').fraction).toBeNull();
  });

  it('should write a zero fraction as zero, not as the absent state', () => {
    // `0` is a legal share and a falsy one. Collapsing it to null here would
    // silently unsize a container on every save.
    expect(rowFromNode(splitNode({ fraction: 0 }), 'root-1').fraction).toBe(0);
  });

  it('should spread a pane’s target across the two columns and leave the axis null', () => {
    expect(rowFromNode(paneNode({ target: { kind: 'page', id: 'page-7' } }), 'root-1')).toStrictEqual({
      id: 'pane-1',
      rootId: 'root-1',
      parentId: 'root-1',
      position: 0,
      nodeType: 'pane',
      axis: null,
      fraction: null,
      targetKind: 'page',
      targetId: 'page-7',
    });
  });

  it('should write an unbound pane with BOTH target columns null, never half a binding', () => {
    const row = rowFromNode(paneNode({ target: null }), 'root-1');
    expect({ targetKind: row.targetKind, targetId: row.targetId }).toStrictEqual({ targetKind: null, targetId: null });
  });

  it('should write the ROOT with a null parent, and every other node with a real one', () => {
    // The only null `parentId` any writer produces. A pane can no longer carry
    // one, which is what makes the column's null unambiguous on the way back.
    expect(rowFromNode(rootNode(), 'root-1').parentId).toBeNull();
    expect(rowFromNode(paneNode(), 'root-1').parentId).toBe('root-1');
    expect(rowFromNode(splitNode(), 'root-1').parentId).toBe('root-1');
  });

  it('should stamp the workspace it was given, never one inferred from the node', () => {
    // The node cannot carry a workspace — that is what makes cross-workspace
    // parenting unspellable in the model — so the writer must say which one it
    // is writing into, every time.
    const nodes: WorkspaceNode[] = [rootNode(), splitNode(), paneNode(), paneNode({ id: 'second', position: 1 })];
    expect(nodes.map((node) => rowFromNode(node, 'ws-target').rootId)).toEqual([
      'ws-target',
      'ws-target',
      'ws-target',
      'ws-target',
    ]);
  });
});

/** A tree as `id(child, child)` — order-sensitive, so nesting AND order are read at once. */
function outline(rendered: RenderNode): string {
  if (rendered.children.length === 0) return rendered.node.id;
  return `${rendered.node.id}(${rendered.children.map(outline).join(',')})`;
}

describe('buildRenderTree', () => {
  it('should nest each node under its parent, at any depth', () => {
    const nodes: WorkspaceNode[] = [
      rootNode(),
      splitNode({ id: 'col', position: 0 }),
      paneNode({ id: 'top', parentId: 'col', position: 0 }),
      paneNode({ id: 'bottom', parentId: 'col', position: 1 }),
      paneNode({ id: 'right', parentId: 'root-1', position: 1 }),
    ];
    const tree = buildRenderTree(nodes);
    expect(tree.root && outline(tree.root)).toBe('root-1(col(top,bottom),right)');
  });

  it('should order siblings by position, whatever order the flat list is in', () => {
    const nodes: WorkspaceNode[] = [
      paneNode({ id: 'c', position: 2 }),
      rootNode(),
      paneNode({ id: 'a', position: 0 }),
      paneNode({ id: 'b', position: 1 }),
    ];
    const tree = buildRenderTree(nodes);
    expect(tree.root && outline(tree.root)).toBe('root-1(a,b,c)');
  });

  it('should render EVERY pane the workspace holds, because there is no second list beside the tree', () => {
    // The whole correction in one assertion. `RenderTree` used to carry a
    // `detached` field — panes in the workspace and off the grid — so every
    // caller had to remember "and also render the parked ones", and the caller
    // that forgot was the sidebar bug (#2373) in a new costume. There is nothing
    // to remember now.
    const nodes: WorkspaceNode[] = [
      rootNode(),
      paneNode({ id: 'first', position: 0 }),
      paneNode({ id: 'second', position: 1 }),
    ];
    const tree = buildRenderTree(nodes);
    expect(tree.root && outline(tree.root)).toBe('root-1(first,second)');
    expect(tree.orphaned).toEqual([]);
  });

  it('should return a null tree for a list with no root, and orphan whatever it held', () => {
    // A workspace mid-hydration has nodes but no root yet. The renderer draws
    // nothing rather than guessing which node is the top, and says what it could
    // not place.
    const tree = buildRenderTree([paneNode({ id: 'stranded', parentId: 'gone', position: 0 })]);
    expect(tree.root).toBeNull();
    expect(tree.orphaned.map((node) => node.id)).toEqual(['stranded']);
  });

  it('should ORPHAN a node a row left with no parent, rather than filing it anywhere else', () => {
    // The state the projection used to have a whole field for. It is not a
    // location any more — it is a node with no place, which is exactly what
    // `orphaned` is for.
    const parentless = { nodeType: 'pane', id: 'lost', parentId: null, position: 0, target: null } as unknown as WorkspaceNode;
    const nodes: WorkspaceNode[] = [rootNode(), paneNode({ id: 'onscreen', position: 0 }), parentless];
    const tree = buildRenderTree(nodes);
    expect(tree.root && outline(tree.root)).toBe('root-1(onscreen)');
    expect(tree.orphaned.map((node) => node.id)).toEqual(['lost']);
  });

  it('should surface a node whose parent does not resolve, and never re-parent it onto the root', () => {
    // Attaching an unresolvable node to the root would be the renderer INVENTING
    // a location — a pane appearing somewhere the user never put it, which is
    // the same class of lie as a pane moving between workspaces. It is reported
    // instead, so a corrupt read is visible rather than plausible.
    const nodes: WorkspaceNode[] = [
      rootNode(),
      paneNode({ id: 'onscreen', position: 0 }),
      paneNode({ id: 'lost', parentId: 'no-such-container', position: 0 }),
    ];
    const tree = buildRenderTree(nodes);
    expect(tree.root && outline(tree.root)).toBe('root-1(onscreen)');
    expect(tree.orphaned.map((node) => node.id)).toEqual(['lost']);
  });

  it('should report a whole orphaned SUBTREE, not only the node whose parent went missing', () => {
    // The pane's OWN parent resolves perfectly well — it is the container above
    // it that dangles. An implementation that decided orphanhood one node at a
    // time would report the container and then lose the pane entirely, which is
    // the partition quietly breaking on exactly the input that needs it most.
    const nodes: WorkspaceNode[] = [
      rootNode(),
      paneNode({ id: 'onscreen', position: 0 }),
      splitNode({ id: 'lost-col', parentId: 'no-such-container' }),
      paneNode({ id: 'lost-pane', parentId: 'lost-col' }),
    ];
    const tree = buildRenderTree(nodes);
    expect(tree.root && outline(tree.root)).toBe('root-1(onscreen)');
    expect(tree.orphaned.map((node) => node.id)).toEqual(['lost-col', 'lost-pane']);
  });

  it('should count every node exactly once across the tree and the orphans', () => {
    // The two fields partition the list. That is what makes the flat list safe
    // to keep canonical: a projection that could lose a node would put "in the
    // workspace" and "on screen" back into disagreement.
    const nodes: WorkspaceNode[] = [
      rootNode(),
      splitNode({ id: 'col' }),
      paneNode({ id: 'in-col', parentId: 'col' }),
      paneNode({ id: 'beside', position: 1 }),
      paneNode({ id: 'lost', parentId: 'ghost' }),
    ];
    const tree = buildRenderTree(nodes);
    const rendered: string[] = [];
    const walk = (branch: RenderNode): void => {
      rendered.push(branch.node.id);
      branch.children.forEach(walk);
    };
    if (tree.root) walk(tree.root);
    expect([...rendered, ...tree.orphaned.map((n) => n.id)].sort()).toEqual(
      ['beside', 'col', 'in-col', 'lost', 'root-1'].sort(),
    );
  });

  it('should terminate on a list that repeats an id, rather than descending forever', () => {
    // A duplicate id makes a parent pointer resolve to two different rows, and
    // the descent can then re-enter what it just left. Optimistic client state
    // has no primary key to stop that, and a renderer must not be the thing
    // that discovers it.
    const nodes: WorkspaceNode[] = [
      rootNode(),
      paneNode({ id: 'dup', parentId: 'root-1', position: 0 }),
      paneNode({ id: 'dup', parentId: 'dup', position: 0 }),
    ];
    const tree = buildRenderTree(nodes);
    expect(tree.root && outline(tree.root)).toBe('root-1(dup)');
    // The row it could not place is reported rather than dropped — a duplicate
    // id is corrupt input, and the renderer's job is to make that visible.
    expect(tree.orphaned).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The round-trip property
//
// No fast-check in this repo; the house precedent is a seeded LCG
// (`workspace-layout-verbs.test.ts`'s blob≡rows drift guard, and the verb-queue
// convergence suite in apps/web). Same discipline: every run is a pure function
// of one integer seed, every assertion names its seed, and the generator's own
// coverage is asserted at the end so a property cannot quietly pass by
// generating nothing interesting.
// ---------------------------------------------------------------------------

/** Deterministic LCG — the drift guard's generator, for the same reason. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Zero is in the pool deliberately: it is a legal share and a falsy one, so it
 * is the value that separates "absent" from "present" for any implementation
 * that reaches for `||`.
 */
const FRACTIONS = [0, 0.25, 1 / 3, 0.5, 1];
const AXES = ['row', 'column'] as const;
const TARGET_KINDS = ['chat', 'terminal', 'page'] as const;

/**
 * A whole workspace's rows: a root and a random tree of splits and panes beneath
 * it. Rows are valid by construction — the property under test is losslessness,
 * not rejection, which the example suite above pins directly.
 *
 * It used to generate PARKED panes too (`parentId: null`), which is now a row
 * the parse refuses rather than a shape the round trip has to preserve. The
 * refusal is pinned by example above; generating it here would only assert that
 * `nodeFromRow` throws, 200 times.
 */
function generateWorkspace(seed: number): WorkspaceNodeRow[] {
  const rand = prng(seed * 7919 + 101);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const maybeFraction = (): number | null => (rand() < 0.5 ? pick(FRACTIONS) : null);

  const rootId = `ws-${seed}`;
  const rows: WorkspaceNodeRow[] = [
    {
      id: rootId,
      rootId,
      parentId: null,
      position: 0,
      nodeType: 'root',
      axis: pick(AXES),
      fraction: null,
      targetKind: null,
      targetId: null,
    },
  ];

  const containers = [rootId];
  const childCount = new Map<string, number>();
  const nextPosition = (parentId: string): number => {
    const next = childCount.get(parentId) ?? 0;
    childCount.set(parentId, next + 1);
    return next;
  };

  const attached = 3 + Math.floor(rand() * 14);
  for (let n = 0; n < attached; n += 1) {
    const parentId = pick(containers);
    const id = `n-${seed}-${n}`;
    if (rand() < 0.3) {
      containers.push(id);
      rows.push({
        id,
        rootId,
        parentId,
        position: nextPosition(parentId),
        nodeType: 'split',
        axis: pick(AXES),
        fraction: maybeFraction(),
        targetKind: null,
        targetId: null,
      });
      continue;
    }
    const bound = rand() < 0.75;
    rows.push({
      id,
      rootId,
      parentId,
      position: nextPosition(parentId),
      nodeType: 'pane',
      axis: null,
      fraction: maybeFraction(),
      targetKind: bound ? pick(TARGET_KINDS) : null,
      targetId: bound ? `t-${seed}-${n}` : null,
    });
  }

  // Storage returns rows in whatever order it likes; shuffling here keeps the
  // properties honest about not depending on the order they arrive in.
  for (let i = rows.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows;
}

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

describe('rows ⟷ nodes (property)', () => {
  it('given any generated workspace, should round-trip rows → nodes → rows unchanged', () => {
    const census = { absentFraction: 0, zeroFraction: 0, boundPane: 0, unboundPane: 0, nestedSplit: 0 };

    for (const seed of SEEDS) {
      const rows = generateWorkspace(seed);
      for (const [index, row] of rows.entries()) {
        expect(rowFromNode(nodeFromRow(row), row.rootId), `seed ${seed} row ${index} (${row.id})`).toStrictEqual(row);

        if (row.nodeType !== 'root' && row.fraction === null) census.absentFraction += 1;
        if (row.fraction === 0) census.zeroFraction += 1;
        if (row.nodeType === 'pane' && row.targetKind !== null) census.boundPane += 1;
        if (row.nodeType === 'pane' && row.targetKind === null) census.unboundPane += 1;
        if (row.nodeType === 'split' && row.parentId !== row.rootId) census.nestedSplit += 1;
      }
    }

    // The generator must actually produce the cases the property claims to
    // cover — otherwise this is 200 seeds of nothing.
    for (const [what, count] of Object.entries(census)) {
      expect(count, `generator produced no ${what}`).toBeGreaterThan(0);
    }
  });

  it('given any generated workspace, should round-trip nodes → rows → nodes with absence preserved exactly', () => {
    for (const seed of SEEDS) {
      const rows = generateWorkspace(seed);
      for (const row of rows) {
        const where = `seed ${seed} node ${row.id}`;
        const node = nodeFromRow(row);
        // `toStrictEqual`, not `toEqual`: `toEqual` treats a key holding
        // `undefined` as absent, which is exactly the difference that has to
        // fail here.
        expect(nodeFromRow(rowFromNode(node, row.rootId)), where).toStrictEqual(node);

        // Stated directly as well, because the assertion above compares two
        // nodes that came from the same builder — if that builder invented a
        // `fraction` key, both sides would carry it.
        expect(Object.prototype.hasOwnProperty.call(node, 'fraction'), `${where}: fraction key`).toBe(
          row.fraction !== null,
        );
        if (row.nodeType === 'pane') {
          expect(Object.prototype.hasOwnProperty.call(node, 'axis'), `${where}: axis key on a leaf`).toBe(false);
        }
      }
    }
  });

  it('given any generated workspace, should stamp every row it writes with the workspace it was told to write into', () => {
    for (const seed of SEEDS) {
      const rows = generateWorkspace(seed);
      const nodes = nodesFromRows(rows, `ws-${seed}`);
      // A workspace id that appears nowhere in the nodes: if any row's scope
      // came from the node rather than the parameter, it cannot be this.
      const written = nodes.map((node) => rowFromNode(node, 'ws-elsewhere'));
      expect(new Set(written.map((row) => row.rootId)), `seed ${seed}`).toStrictEqual(new Set(['ws-elsewhere']));
    }
  });

  it('given any generated workspace, should render EVERY node exactly once, with nothing beside the tree', () => {
    for (const seed of SEEDS) {
      const nodes = nodesFromRows(generateWorkspace(seed), `ws-${seed}`);
      const tree = buildRenderTree(nodes);
      const where = `seed ${seed}`;

      const rendered: string[] = [];
      const walk = (branch: RenderNode): void => {
        rendered.push(branch.node.id);
        branch.children.forEach(walk);
      };
      expect(tree.root, where).not.toBeNull();
      if (tree.root) walk(tree.root);

      expect(rendered.slice().sort(), `${where}: the tree is every node, once each`).toEqual(
        nodes.map((node) => node.id).slice().sort(),
      );
      // Nothing is lost and nothing is duplicated: the projection partitions
      // the list, which is what makes the flat list safe to keep canonical.
      expect(tree.orphaned, `${where}: a well-formed workspace has no orphans`).toEqual([]);
      expect(rendered.length, `${where}: node count`).toBe(nodes.length);
    }
  });
});

// ---------------------------------------------------------------------------
// The OTHER producer
//
// Everything above round-trips nodes the ROW PARSE built, so both sides of
// every comparison come from one producer. The guarantee both module docblocks
// actually make is about the pair: the client holds the node THE ALGEBRA built
// optimistically while the server holds the rehydrated one, and any difference
// in which keys are present makes every write look like a change and puts the
// two planes permanently out of step.
// ---------------------------------------------------------------------------

describe('nodes the ALGEBRA built ⟷ rows', () => {
  /** A sized two-pane grid, built the way the algebra builds one rather than declared. */
  function grid(): WorkspaceNode[] {
    const root: RootNode = { nodeType: 'root', id: 'root-1', parentId: null, position: 0, axis: 'row' };
    const minted = applyNodeWrite(
      [root],
      accepted(create([root], { nodeId: 'a', target: { kind: 'chat', id: 'conv-a' }, parentId: 'root-1' })),
    );
    const both = applyNodeWrite(
      minted,
      accepted(create(minted, { nodeId: 'b', target: { kind: 'chat', id: 'conv-b' }, parentId: 'root-1' })),
    );
    // `resize` is what MATERIALIZES the fractions: before it, both panes carry
    // no `fraction` key at all, which is the absence the round trip has to
    // preserve — and after it, they carry one appended by `withFraction`, which
    // is the case the docblocks are really about.
    return applyNodeWrite(both, accepted(resize(both, { nodeId: 'a', fraction: 0.3 })));
  }

  function accepted(result: NodeOperationResult): NodeWrite {
    if (!result.ok) throw new Error(`expected an accepted operation, got ${result.code}: ${result.detail}`);
    return result.write;
  }

  it('should round-trip a SIZED node the algebra built, with its share preserved as a present key', () => {
    // `toStrictEqual`, not `toEqual`: `toEqual` treats a key holding
    // `undefined` as absent, which is exactly the difference that has to fail.
    for (const node of grid()) {
      expect(nodeFromRow(rowFromNode(node, 'root-1')), `node ${node.id}`).toStrictEqual(node);
    }
  });

  it('should round-trip an UNSIZED node the algebra built with no fraction key at all', () => {
    // The absence IS the state ("my parent is unsized"), never an explicit
    // null. A rehydrated node carrying `fraction: null` — or `undefined` —
    // would differ from the one the client is holding on every unsized
    // container in the workspace, which is most of them.
    const root: RootNode = { nodeType: 'root', id: 'root-1', parentId: null, position: 0, axis: 'row' };
    const minted = applyNodeWrite(
      [root],
      accepted(create([root], { nodeId: 'a', target: null, parentId: 'root-1' })),
    );
    for (const node of minted) {
      const back = nodeFromRow(rowFromNode(node, 'root-1'));
      expect(back, `node ${node.id}`).toStrictEqual(node);
      expect(Object.prototype.hasOwnProperty.call(back, 'fraction'), `node ${node.id}: fraction key`).toBe(
        false,
      );
    }
  });
});

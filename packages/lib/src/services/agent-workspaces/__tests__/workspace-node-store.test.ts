/**
 * THE ATOMIC READ — the leaf's whole point, tested under concurrency.
 *
 * The claim is not "this is fast" and not "this usually agrees". It is that the
 * `rev` a read returns DESCRIBES the nodes it returns — exactly, not "≤" — with
 * a write committing while the read is in flight. That assertion is only
 * possible because the read is one statement, and it is the only assertion that
 * can tell one statement from two.
 *
 * The fake database below is built to make the difference visible. It applies a
 * pending write AFTER each statement returns, and it remembers what the tree
 * looked like at every rev — so a reader that issues one statement gets a pair
 * from one history entry, and a reader that issues two gets a rev from one entry
 * and nodes from another. The second is the exact fault this leaf exists to
 * remove, and the exact fault a `≤` assertion would wave through.
 */
import { describe, it, expect } from 'vitest';
import {
  readWorkspaceNodeSnapshot,
  readWorkspaceNodeSnapshots,
  snapshotsFromJoinRows,
  type NodeSnapshotExecutor,
} from '../workspace-node-store';
import type { WorkspaceNodeRow } from '../../../agent-workspaces/workspace-node-rows';

const WORKSPACE = 'ws-1';

/** The join's row shape, with the node half nulled — a workspace with a rev and no nodes. */
function revOnly(workspaceId: string, rev: number) {
  return {
    workspaceId,
    rev,
    id: null,
    parentId: null,
    position: null,
    nodeType: null,
    axis: null,
    fraction: null,
    targetKind: null,
    targetId: null,
  };
}

function joinRow(workspaceId: string, rev: number, row: Partial<WorkspaceNodeRow> & { id: string }) {
  return {
    workspaceId,
    rev,
    id: row.id,
    parentId: row.parentId ?? null,
    position: row.position ?? 0,
    nodeType: row.nodeType ?? ('pane' as const),
    axis: row.axis ?? null,
    fraction: row.fraction ?? null,
    targetKind: row.targetKind ?? null,
    targetId: row.targetId ?? null,
  };
}

// ---------------------------------------------------------------------------
// The pure half: rows → snapshots
// ---------------------------------------------------------------------------

describe('snapshotsFromJoinRows', () => {
  it('gives every workspace ASKED FOR an entry, including one nothing has ever written', () => {
    // A missing entry would make "never written" and "you did not ask" the same
    // answer, and the first is a real state a caller has to render.
    const snapshots = snapshotsFromJoinRows([], [WORKSPACE, 'ws-2']);
    expect([...snapshots.keys()]).toEqual([WORKSPACE, 'ws-2']);
    expect(snapshots.get(WORKSPACE)).toEqual({ rev: 0, nodes: [] });
  });

  it('reads a workspace with a rev and an EMPTY tree as exactly that', () => {
    // Closing the last pane leaves a root and nothing else, or nothing at all —
    // an ordinary state, and one the join expresses with a null node half.
    const snapshots = snapshotsFromJoinRows([revOnly(WORKSPACE, 7)], [WORKSPACE]);
    expect(snapshots.get(WORKSPACE)).toEqual({ rev: 7, nodes: [] });
  });

  it('coerces the bigint rev postgres hands back as a STRING, at the parse', async () => {
    // node-postgres returns int8 as text rather than risk a silent precision
    // loss, and raw SQL does not get the drizzle builder's `{mode: 'number'}`
    // conversion for free. A rev left as a string would compare `'10' < '9'`.
    const executor: NodeSnapshotExecutor = {
      async execute() {
        return { rows: [{ ...revOnly(WORKSPACE, 0), rev: '12' }] };
      },
    };
    expect((await readWorkspaceNodeSnapshot(executor, WORKSPACE)).rev).toBe(12);
  });

  it('REJECTS a row whose stored nodeType is outside the domain the CHECK constraint promises', async () => {
    const executor: NodeSnapshotExecutor = {
      async execute() {
        return { rows: [joinRow(WORKSPACE, 1, { id: 'x', nodeType: 'Root' as 'root' })] };
      },
    };
    // Rejects the whole read rather than dropping the row: a partial workspace
    // is a lie about what the user has, and is indistinguishable from their
    // having closed the missing panes.
    await expect(readWorkspaceNodeSnapshot(executor, WORKSPACE)).rejects.toThrow();
  });

  it('keeps two workspaces apart, ids and all — client-minted ids collide legitimately', () => {
    const rows = [
      joinRow(WORKSPACE, 1, { id: 'root', nodeType: 'root', axis: 'row' }),
      joinRow('ws-2', 5, { id: 'root', nodeType: 'root', axis: 'column' }),
    ];
    const snapshots = snapshotsFromJoinRows(rows, [WORKSPACE, 'ws-2']);
    expect(snapshots.get(WORKSPACE)).toEqual({
      rev: 1,
      nodes: [{ nodeType: 'root', id: 'root', parentId: null, position: 0, axis: 'row' }],
    });
    expect(snapshots.get('ws-2')?.rev).toBe(5);
    expect(snapshots.get('ws-2')?.nodes[0]).toMatchObject({ axis: 'column' });
  });

  it('passes fractions through THE funnel, so a float4 round trip is an identity', () => {
    // Without one shared quantization every re-send of a sized tree would look
    // like a change: the change detector compares against exactly this value.
    const rows = [
      joinRow(WORKSPACE, 1, { id: 'root', nodeType: 'root', axis: 'row' }),
      joinRow(WORKSPACE, 1, { id: 'a', parentId: 'root', position: 0, fraction: 0.30000001192092896 }),
      joinRow(WORKSPACE, 1, { id: 'b', parentId: 'root', position: 1, fraction: 0.699999988079071 }),
    ];
    const nodes = snapshotsFromJoinRows(rows, [WORKSPACE]).get(WORKSPACE)?.nodes ?? [];
    expect(nodes.map((node) => (node.nodeType === 'root' ? null : node.fraction))).toEqual([null, 0.3, 0.7]);
  });

  it('reads a non-positive or non-finite stored share as UNSIZED, not as a node to reject', () => {
    // float4 can hold an Infinity and a zero; neither is a share of anything,
    // and the honest reading is "this container was never sized".
    const rows = [
      joinRow(WORKSPACE, 1, { id: 'root', nodeType: 'root', axis: 'row' }),
      joinRow(WORKSPACE, 1, { id: 'a', parentId: 'root', position: 0, fraction: 0 }),
      joinRow(WORKSPACE, 1, { id: 'b', parentId: 'root', position: 1, fraction: Number.POSITIVE_INFINITY }),
    ];
    const nodes = snapshotsFromJoinRows(rows, [WORKSPACE]).get(WORKSPACE)?.nodes ?? [];
    for (const node of nodes) expect('fraction' in node).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The concurrency contract
// ---------------------------------------------------------------------------

/**
 * A database that commits a pending write BETWEEN statements.
 *
 * Every `execute` answers from the state as it is, then applies the next queued
 * write — so a reader issuing one statement sees one consistent state, and a
 * reader issuing two straddles a commit. `history` records the tree at every
 * rev, which is what turns "the rev describes the nodes" into an assertion
 * rather than a hope.
 */
function racingDatabase(writes: ReadonlyArray<(rows: ReturnType<typeof joinRow>[]) => ReturnType<typeof joinRow>[]>) {
  let rev = 1;
  let rows: ReturnType<typeof joinRow>[] = [joinRow(WORKSPACE, 1, { id: 'root', nodeType: 'root', axis: 'row' })];
  const history = new Map<number, string[]>([[1, ['root']]]);
  let pending = 0;
  let statements = 0;

  const executor: NodeSnapshotExecutor = {
    async execute() {
      statements += 1;
      const answered = rows.map((row) => ({ ...row, rev }));
      if (pending < writes.length) {
        rev += 1;
        rows = writes[pending](rows).map((row) => ({ ...row, rev }));
        history.set(rev, rows.map((row) => row.id).filter((id): id is string => id !== null).sort());
        pending += 1;
      }
      return { rows: answered };
    },
  };

  return { executor, history, statementCount: () => statements };
}

describe('the read is ONE statement, so its rev describes its nodes exactly', () => {
  it('a write committing mid-read cannot produce a rev/nodes pair that never existed', async () => {
    const { executor, history, statementCount } = racingDatabase([
      (rows) => [...rows, joinRow(WORKSPACE, 0, { id: 'pane-new', parentId: 'root', position: 0 })],
    ]);

    const snapshot = await readWorkspaceNodeSnapshot(executor, WORKSPACE);

    // EXACTLY, not "≤". The pair the read returned is a state the workspace was
    // genuinely in — which is the only thing that makes it safe for a client to
    // adopt `rev` as its base. A rev newer than its nodes makes the client
    // discard the next broadcast (`payload.rev <= sync.rev`) and stay wrong
    // until it happens to poll.
    expect(snapshot.nodes.map((node) => node.id).sort()).toEqual(history.get(snapshot.rev));
    // And the reason it holds: one statement, which in Postgres is one snapshot
    // by definition. Split this read in two and the assertion above stops being
    // provable, whichever order the two run in.
    expect(statementCount()).toBe(1);
  });

  it('holds for the bulk read too — one statement for one workspace and for fifty', async () => {
    const { executor, history, statementCount } = racingDatabase([
      (rows) => [...rows, joinRow(WORKSPACE, 0, { id: 'pane-new', parentId: 'root', position: 0 })],
      (rows) => rows.filter((row) => row.id !== 'pane-new'),
    ]);

    const snapshots = await readWorkspaceNodeSnapshots(executor, [WORKSPACE, 'ws-2', 'ws-3']);
    const mine = snapshots.get(WORKSPACE);
    expect(mine).toBeDefined();
    if (!mine) return;
    expect(mine.nodes.map((node) => node.id).sort()).toEqual(history.get(mine.rev));
    expect(statementCount()).toBe(1);
  });

  it('asks nothing at all for an empty list', async () => {
    const { executor, statementCount } = racingDatabase([]);
    expect(await readWorkspaceNodeSnapshots(executor, [])).toEqual(new Map());
    expect(statementCount()).toBe(0);
  });
});

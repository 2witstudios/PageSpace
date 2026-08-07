/**
 * The REARRANGE half of the verb algebra (issue #2208) — `resize_column`,
 * `resize_pane`, `move_pane`, `reorder_columns`, and the fraction invariant
 * they all maintain.
 *
 * Split from `workspace-layout-verbs.test.ts` (which owns the structural
 * verbs and the dual-write drift guard) because these four share one subject
 * the others do not have at all: SIZING. The invariant is stated once, in
 * `rebalanceFractions`' doc, and asserted here by a single predicate
 * ({@link expectInvariant}) applied after every case — including the
 * structural verbs, which must maintain it too now that a grid can be sized
 * when they run.
 *
 * The closing property is the epic's acceptance shape for this PR: after ANY
 * seeded sequence of the NEW verbs mixed with the old ones, the grid still
 * satisfies every structural invariant — contiguous positions, valid
 * fractions, no orphan panes, no empty columns. Seeded LCG rather than
 * fast-check (not a dependency of this repo), matching the drift guard's own
 * precedent so a failure reproduces from its logged seed.
 */
import { describe, it, expect } from 'vitest';
import {
  applyVerbLocal,
  gridFromWorkspaceState,
  workspaceStateFromGrid,
  newWorkspace,
  panesOf,
  workspaceLayoutVerbSchema,
  FRACTION_EPSILON,
  MIN_FRACTION,
  type ColumnState,
  type WorkspaceLayoutVerb,
  type WorkspaceState,
} from '../workspace-layout-verbs';
import { persistedWorkspaceStateSchema, type PaneScope } from '../contract';

const WORKSPACE_ID = 'ses-1';

const chatScope = (targetId: string, name = 'Conversation'): PaneScope => ({
  kind: 'chat',
  name,
  targetId,
  agentPageId: null,
});

const opening = (): WorkspaceState =>
  newWorkspace({ sessionId: WORKSPACE_ID, paneId: 'pane-1', columnId: 'col-1', scope: chatScope('conv-1') });

/** Apply a verb, asserting it actually ran — the setup helper for every case below. */
function apply(state: WorkspaceState | null, verb: WorkspaceLayoutVerb): WorkspaceState {
  const outcome = applyVerbLocal(state, WORKSPACE_ID, verb);
  expect(outcome.applied, `expected ${verb.type} to apply`).toBe(true);
  return outcome.state!;
}

/**
 * A three-column grid: `col-1` holds `pane-1` + `pane-1b`, `col-2` holds
 * `pane-2`, `col-3` holds `pane-3`. Unsized — no verb here has touched a
 * fraction yet.
 */
function threeColumns(): WorkspaceState {
  let state = opening();
  state = apply(state, { type: 'split_right', fromPaneId: 'pane-1', newColumnId: 'col-2', newPaneId: 'pane-2' });
  state = apply(state, { type: 'split_right', fromPaneId: 'pane-2', newColumnId: 'col-3', newPaneId: 'pane-3' });
  state = apply(state, { type: 'split_down', fromPaneId: 'pane-1', newPaneId: 'pane-1b' });
  return state;
}

/** Fractions rounded for comparison — stored shares sit on a 1e-5 grid, so
 *  their exact doubles carry representation noise (0.6 is `0.6000000000000001`). */
const round5 = (value: number | null | undefined) =>
  typeof value === 'number' ? Math.round(value * 1e5) / 1e5 : null;
const widths = (state: WorkspaceState) => state.columns.map((column) => round5(column.widthFraction));
const heights = (column: ColumnState) => column.panes.map((pane) => round5(pane.heightFraction));
const columnIds = (state: WorkspaceState) => state.columns.map((column) => column.id);
const paneIdsOf = (column: ColumnState) => column.panes.map((pane) => pane.id);

/**
 * THE fraction invariant, as one assertion: every container is either wholly
 * unsized or wholly sized with each share at/above the floor and the shares
 * summing to 1. Plus the structural invariants a rearrange must never break:
 * no empty column, and no duplicated pane (a `move_pane` that copied instead
 * of moving would show up here and nowhere else).
 */
function expectInvariant(state: WorkspaceState | null, label = ''): void {
  if (state === null) return;
  const containers: Array<Array<number | null | undefined>> = [
    state.columns.map((column) => column.widthFraction),
    ...state.columns.map((column) => column.panes.map((pane) => pane.heightFraction)),
  ];
  for (const container of containers) {
    const sized = container.filter((value) => typeof value === 'number') as number[];
    if (sized.length === 0) continue;
    expect(sized.length, `${label}: container is MIXED (some members sized, some not)`).toBe(container.length);
    for (const share of sized) {
      expect(Number.isFinite(share), `${label}: non-finite share`).toBe(true);
      // The floor itself relaxes for a container too crowded to honor it —
      // `1 / n` is then the even split, which is all anyone can have.
      expect(share, `${label}: share under the floor`).toBeGreaterThanOrEqual(
        Math.min(MIN_FRACTION, 1 / container.length) - FRACTION_EPSILON,
      );
    }
    const sum = sized.reduce((total, share) => total + share, 0);
    expect(Math.abs(sum - 1), `${label}: shares sum to ${sum}, not 1`).toBeLessThan(FRACTION_EPSILON);
  }

  for (const column of state.columns) {
    expect(column.panes.length, `${label}: empty column ${column.id}`).toBeGreaterThan(0);
  }
  const ids = panesOf(state).map((pane) => pane.id);
  expect(new Set(ids).size, `${label}: duplicated pane id`).toBe(ids.length);
}

// ---------------------------------------------------------------------------
// resize_column
// ---------------------------------------------------------------------------

describe('applyVerbLocal: resize_column', () => {
  it('materializes an unsized grid: the resized column takes its share, siblings split the rest evenly', () => {
    const state = apply(threeColumns(), { type: 'resize_column', columnId: 'col-1', widthFraction: 0.5 });
    expect(widths(state)).toEqual([0.5, 0.25, 0.25]);
    expectInvariant(state);
  });

  it('siblings absorb the difference IN PROPORTION, not evenly', () => {
    let state = apply(threeColumns(), { type: 'resize_column', columnId: 'col-2', widthFraction: 0.6 });
    expect(widths(state)).toEqual([0.2, 0.6, 0.2]);
    // col-1 is now twice col-3; shrinking col-2 must preserve that ratio.
    state = apply(state, { type: 'resize_column', columnId: 'col-1', widthFraction: 0.4 });
    expect(state.columns[1].widthFraction! / state.columns[2].widthFraction!).toBeCloseTo(3, 5);
    expectInvariant(state);
  });

  it('clamps a request beyond what the floor leaves available instead of refusing it', () => {
    const wide = apply(threeColumns(), { type: 'resize_column', columnId: 'col-1', widthFraction: 5 });
    expect(wide.columns[0].widthFraction).toBeCloseTo(1 - 2 * MIN_FRACTION, 5);
    expect(wide.columns[1].widthFraction).toBeCloseTo(MIN_FRACTION, 5);
    expectInvariant(wide);

    const narrow = apply(threeColumns(), { type: 'resize_column', columnId: 'col-1', widthFraction: -3 });
    expect(narrow.columns[0].widthFraction).toBeCloseTo(MIN_FRACTION, 5);
    expectInvariant(narrow);
  });

  it('no-ops on an unresolvable column, on a single-column grid, and on a re-sent identical resize', () => {
    const three = threeColumns();
    expect(applyVerbLocal(three, WORKSPACE_ID, { type: 'resize_column', columnId: 'ghost', widthFraction: 0.5 }).applied).toBe(false);
    // A lone column always owns the whole width — there is no share to state.
    expect(applyVerbLocal(opening(), WORKSPACE_ID, { type: 'resize_column', columnId: 'col-1', widthFraction: 0.3 }).applied).toBe(false);

    const sized = apply(three, { type: 'resize_column', columnId: 'col-1', widthFraction: 0.5 });
    const replayed = applyVerbLocal(sized, WORKSPACE_ID, { type: 'resize_column', columnId: 'col-1', widthFraction: 0.5 });
    expect(replayed.applied, 'a re-sent resize must not bump the rev').toBe(false);
    expect(replayed.state).toBe(sized);
  });

  it('no-ops on a gridless session rather than inventing a grid to size', () => {
    expect(applyVerbLocal(null, WORKSPACE_ID, { type: 'resize_column', columnId: 'col-1', widthFraction: 0.5 })).toEqual({
      state: null,
      applied: false,
    });
  });
});

// ---------------------------------------------------------------------------
// resize_pane
// ---------------------------------------------------------------------------

describe('applyVerbLocal: resize_pane', () => {
  it('sizes within the pane OWN column and leaves every other column alone', () => {
    const state = apply(threeColumns(), { type: 'resize_pane', paneId: 'pane-1', heightFraction: 0.75 });
    expect(heights(state.columns[0])).toEqual([0.75, 0.25]);
    // Heights are column-local: a single-pane sibling column is untouched.
    expect(heights(state.columns[1])).toEqual([null]);
    expect(widths(state)).toEqual([null, null, null]);
    expectInvariant(state);
  });

  it('clamps to the floor and no-ops for a pane alone in its column', () => {
    const clamped = apply(threeColumns(), { type: 'resize_pane', paneId: 'pane-1', heightFraction: 0.999 });
    expect(clamped.columns[0].panes[1].heightFraction).toBeCloseTo(MIN_FRACTION, 5);
    expectInvariant(clamped);

    expect(applyVerbLocal(threeColumns(), WORKSPACE_ID, { type: 'resize_pane', paneId: 'pane-2', heightFraction: 0.4 }).applied).toBe(false);
    expect(applyVerbLocal(threeColumns(), WORKSPACE_ID, { type: 'resize_pane', paneId: 'ghost', heightFraction: 0.4 }).applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// move_pane
// ---------------------------------------------------------------------------

describe('applyVerbLocal: move_pane', () => {
  it('moves a pane to another column, keeping its binding and appending by default', () => {
    const state = apply(threeColumns(), { type: 'move_pane', paneId: 'pane-2', toColumnId: 'col-1' });
    expect(paneIdsOf(state.columns[0])).toEqual(['pane-1', 'pane-1b', 'pane-2']);
    // The column it emptied is gone — a grid never carries an empty column.
    expect(columnIds(state)).toEqual(['col-1', 'col-3']);
    // The binding rides along untouched — `pane-2` is the unbound picker pane
    // `split_right` minted, and it is still exactly that after the move.
    expect(panesOf(state).find((pane) => pane.id === 'pane-2')?.scope).toBe(null);
    expectInvariant(state);
  });

  it('honors an explicit index and clamps one out of range', () => {
    const first = apply(threeColumns(), { type: 'move_pane', paneId: 'pane-2', toColumnId: 'col-1', toIndex: 0 });
    expect(paneIdsOf(first.columns[0])).toEqual(['pane-2', 'pane-1', 'pane-1b']);

    const clampedHigh = apply(threeColumns(), { type: 'move_pane', paneId: 'pane-2', toColumnId: 'col-1', toIndex: 99 });
    expect(paneIdsOf(clampedHigh.columns[0])).toEqual(['pane-1', 'pane-1b', 'pane-2']);

    const clampedLow = apply(threeColumns(), { type: 'move_pane', paneId: 'pane-2', toColumnId: 'col-1', toIndex: -5 });
    expect(paneIdsOf(clampedLow.columns[0])).toEqual(['pane-2', 'pane-1', 'pane-1b']);
    expectInvariant(clampedLow);
  });

  it('reorders WITHIN a column, carrying each pane its own height along', () => {
    let state = apply(threeColumns(), { type: 'resize_pane', paneId: 'pane-1', heightFraction: 0.7 });
    state = apply(state, { type: 'move_pane', paneId: 'pane-1', toColumnId: 'col-1', toIndex: 1 });
    expect(paneIdsOf(state.columns[0])).toEqual(['pane-1b', 'pane-1']);
    // A same-column move is a pure permutation: shares travel with their pane.
    expect(heights(state.columns[0])).toEqual([0.3, 0.7]);
    expectInvariant(state);
  });

  it('arrives in a NEW column unsized — a height chosen against one stack means nothing in another', () => {
    let state = threeColumns();
    state = apply(state, { type: 'split_down', fromPaneId: 'pane-2', newPaneId: 'pane-2b' });
    state = apply(state, { type: 'resize_pane', paneId: 'pane-1', heightFraction: 0.8 });
    state = apply(state, { type: 'move_pane', paneId: 'pane-1', toColumnId: 'col-2', toIndex: 0 });
    // col-2 was unsized and stays unsized; col-1's survivor takes the whole column.
    expect(heights(state.columns[1])).toEqual([null, null, null]);
    expect(heights(state.columns[0])).toEqual([null]);
    expectInvariant(state);
  });

  it('no-ops on an unresolvable pane, an unresolvable destination, and a move to where it already is', () => {
    const state = threeColumns();
    expect(applyVerbLocal(state, WORKSPACE_ID, { type: 'move_pane', paneId: 'ghost', toColumnId: 'col-1' }).applied).toBe(false);
    expect(applyVerbLocal(state, WORKSPACE_ID, { type: 'move_pane', paneId: 'pane-1', toColumnId: 'ghost' }).applied).toBe(false);
    // pane-2 is already the only (hence last) pane of col-2.
    expect(applyVerbLocal(state, WORKSPACE_ID, { type: 'move_pane', paneId: 'pane-2', toColumnId: 'col-2' }).applied).toBe(false);
    expect(applyVerbLocal(state, WORKSPACE_ID, { type: 'move_pane', paneId: 'pane-1', toColumnId: 'col-1', toIndex: 0 }).applied).toBe(false);
  });

  it('renumbers positions contiguously through the row projection', () => {
    const state = apply(threeColumns(), { type: 'move_pane', paneId: 'pane-3', toColumnId: 'col-1', toIndex: 1 });
    const grid = gridFromWorkspaceState(state);
    // `orderIndex` IS array order in the projection — the store derives it
    // from `entries()`, so a contiguous array is a contiguous renumbering.
    expect(grid[0].panes.map((pane) => pane.id)).toEqual(['pane-1', 'pane-3', 'pane-1b']);
    expect(grid.map((column) => column.id)).toEqual(['col-1', 'col-2']);
    expectInvariant(state);
  });
});

// ---------------------------------------------------------------------------
// reorder_columns
// ---------------------------------------------------------------------------

describe('applyVerbLocal: reorder_columns', () => {
  it('reorders to an explicit full permutation, carrying widths along', () => {
    let state = apply(threeColumns(), { type: 'resize_column', columnId: 'col-1', widthFraction: 0.5 });
    state = apply(state, { type: 'reorder_columns', columnIds: ['col-3', 'col-2', 'col-1'] });
    expect(columnIds(state)).toEqual(['col-3', 'col-2', 'col-1']);
    expect(widths(state)).toEqual([0.25, 0.25, 0.5]);
    expectInvariant(state);
  });

  it('reads a PARTIAL list as a prefix: named columns first, everything else in its current order', () => {
    const state = apply(threeColumns(), { type: 'reorder_columns', columnIds: ['col-3'] });
    expect(columnIds(state)).toEqual(['col-3', 'col-1', 'col-2']);
    expectInvariant(state);
  });

  it('skips unknown ids and ignores repeats rather than refusing the whole request', () => {
    const state = apply(threeColumns(), {
      type: 'reorder_columns',
      columnIds: ['ghost', 'col-2', 'col-2', 'also-ghost'],
    });
    expect(columnIds(state)).toEqual(['col-2', 'col-1', 'col-3']);
    expectInvariant(state);
  });

  it('no-ops when the requested order is the order already in force', () => {
    const state = threeColumns();
    expect(applyVerbLocal(state, WORKSPACE_ID, { type: 'reorder_columns', columnIds: ['col-1', 'col-2', 'col-3'] }).applied).toBe(false);
    expect(applyVerbLocal(state, WORKSPACE_ID, { type: 'reorder_columns', columnIds: ['col-1'] }).applied).toBe(false);
    expect(applyVerbLocal(state, WORKSPACE_ID, { type: 'reorder_columns', columnIds: ['nobody'] }).applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Structural verbs maintain the invariant on an ALREADY-SIZED grid
// ---------------------------------------------------------------------------

describe('the structural verbs re-establish the invariant after a membership change', () => {
  it('a split gives the newcomer an even share and shrinks the rest proportionally', () => {
    let state = apply(threeColumns(), { type: 'resize_column', columnId: 'col-1', widthFraction: 0.6 });
    state = apply(state, { type: 'split_right', fromPaneId: 'pane-1', newColumnId: 'col-4', newPaneId: 'pane-4' });
    expect(state.columns).toHaveLength(4);
    // The newcomer takes 1/4; the incumbents keep their 0.6 : 0.2 : 0.2 ratio
    // inside the remaining 3/4.
    expect(state.columns[0].widthFraction).toBeCloseTo(0.45, 4);
    expect(state.columns[1].widthFraction).toBeCloseTo(0.25, 4);
    expectInvariant(state);
  });

  it('a close rescales the survivors to fill what the departure freed', () => {
    let state = apply(threeColumns(), { type: 'resize_column', columnId: 'col-2', widthFraction: 0.5 });
    state = apply(state, { type: 'close_pane', paneId: 'pane-3' });
    expect(columnIds(state)).toEqual(['col-1', 'col-2']);
    // col-1 : col-2 was 0.25 : 0.5 before the close, so the survivors keep
    // that 1 : 2 ratio while growing to fill the whole width.
    expect(state.columns[0].widthFraction).toBeCloseTo(1 / 3, 4);
    expect(state.columns[1].widthFraction).toBeCloseTo(2 / 3, 4);
    expectInvariant(state);
  });

  it('leaves an UNSIZED grid untouched — a split on a grid nobody sized writes no fractions', () => {
    const state = apply(threeColumns(), { type: 'split_down', fromPaneId: 'pane-2', newPaneId: 'pane-2b' });
    expect(widths(state)).toEqual([null, null, null]);
    expect(heights(state.columns[1])).toEqual([null, null]);
    expectInvariant(state);
  });
});

// ---------------------------------------------------------------------------
// Fractions survive the round trip the runtime actually performs
// ---------------------------------------------------------------------------

describe('fractions round-trip through the row projection', () => {
  it('project to rows and rehydrate identically', () => {
    let state = apply(threeColumns(), { type: 'resize_column', columnId: 'col-1', widthFraction: 0.5 });
    state = apply(state, { type: 'resize_pane', paneId: 'pane-1', heightFraction: 0.7 });

    const grid = gridFromWorkspaceState(state);
    expect(grid[0].widthFraction).toBeCloseTo(0.5, 5);
    expect(grid[0].panes[0].heightFraction).toBeCloseTo(0.7, 5);
    expect(grid[1].panes[0].heightFraction, 'an unsized column projects canonical nulls').toBe(null);

    // Structure and fractions survive the row round trip exactly; the fields
    // rows deliberately do NOT own (labels, focus) come back at their
    // defaults, which is why this compares the projection, not the state.
    const rehydrated = workspaceStateFromGrid({ workspaceId: WORKSPACE_ID, grid })!;
    expect(gridFromWorkspaceState(rehydrated)).toEqual(grid);
  });

  it('survive the wire schema — a grid serialized to the client and back keeps every fraction', () => {
    let state = apply(threeColumns(), { type: 'resize_column', columnId: 'col-2', widthFraction: 0.5 });
    state = apply(state, { type: 'resize_pane', paneId: 'pane-1b', heightFraction: 0.3 });
    const reparsed = persistedWorkspaceStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(gridFromWorkspaceState(reparsed)).toEqual(gridFromWorkspaceState(state));
  });

  it('reads a MIXED container from the wire as unsized rather than half-trusting it', () => {
    // Hand-crafted: col-1 sized, col-2/col-3 not. No renderer can make sense
    // of shares summing to 0.5, so the reducer treats the container as
    // unsized and materializes from the even split on the next resize.
    const mixed = workspaceStateFromGrid({
      workspaceId: WORKSPACE_ID,
      grid: [
        { id: 'col-1', widthFraction: 0.5, panes: [{ id: 'pane-1', kind: 'chat', targetId: 'conv-1', heightFraction: null }] },
        { id: 'col-2', widthFraction: null, panes: [{ id: 'pane-2', kind: null, targetId: null, heightFraction: null }] },
      ],
    })!;
    const resized = apply(mixed, { type: 'resize_column', columnId: 'col-2', widthFraction: 0.8 });
    expect(widths(resized)).toEqual([0.2, 0.8]);
    expectInvariant(resized);
  });
});

// ---------------------------------------------------------------------------
// The property: any sequence of the NEW verbs preserves every invariant
// ---------------------------------------------------------------------------

/** Deterministic LCG so a failure reproduces from its logged seed. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * A random verb weighted toward the NEW four, mixed with enough structural
 * verbs to keep membership churning — a rearrange invariant that only holds
 * on a grid whose shape never changes would prove nothing.
 */
function randomVerb(rand: () => number, state: WorkspaceState | null, mint: () => string): WorkspaceLayoutVerb {
  const panes = state ? panesOf(state) : [];
  const columns = state?.columns ?? [];
  // Mix resolvable and unresolvable targets so the no-op paths are exercised
  // just as hard as the applying ones.
  const paneId = rand() < 0.85 && panes.length > 0 ? panes[Math.floor(rand() * panes.length)].id : `ghost-${mint()}`;
  const columnId = rand() < 0.85 && columns.length > 0 ? columns[Math.floor(rand() * columns.length)].id : `ghost-${mint()}`;
  // Deliberately unclamped and occasionally absurd — the reducer owns the
  // clamp, so the property must see what a buggy caller would send.
  const fraction = rand() < 0.15 ? (rand() - 0.5) * 8 : rand();

  switch (Math.floor(rand() * 10)) {
    case 0:
      return { type: 'resize_column', columnId, widthFraction: fraction };
    case 1:
      return { type: 'resize_pane', paneId, heightFraction: fraction };
    case 2:
      return { type: 'move_pane', paneId, toColumnId: columnId, toIndex: Math.floor(rand() * 6) - 1 };
    case 3:
      return { type: 'move_pane', paneId, toColumnId: columnId };
    case 4: {
      const shuffled = columns
        .map((column) => column.id)
        .filter(() => rand() < 0.7)
        .sort(() => rand() - 0.5);
      return { type: 'reorder_columns', columnIds: shuffled.length > 0 ? shuffled : [`ghost-${mint()}`] };
    }
    case 5:
      return { type: 'split_right', fromPaneId: paneId, newColumnId: mint(), newPaneId: mint() };
    case 6:
      return { type: 'split_down', fromPaneId: paneId, newPaneId: mint() };
    case 7:
      return { type: 'close_pane', paneId };
    case 8:
      return { type: 'assign_pane', paneId, scope: chatScope(`conv-${Math.floor(rand() * 5)}`) };
    default:
      return { type: 'ensure', columnId: mint(), paneId: mint(), scope: chatScope('conv-0') };
  }
}

describe('property: any sequence of the rearrange verbs preserves the structural invariants', () => {
  it('holds across seeded random sequences — contiguous order, valid fractions, no orphan panes', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const rand = prng(seed * 7919);
      let minted = 0;
      const mint = () => `id-${seed}-${(minted += 1)}`;
      let state: WorkspaceState | null = rand() < 0.5 ? opening() : null;

      for (let step = 0; step < 60; step += 1) {
        const verb = randomVerb(rand, state, mint);
        const label = `seed ${seed} step ${step} (${verb.type})`;
        // The payload must be wire-legal: the schema and the engine cannot
        // drift on what a verb is.
        expect(workspaceLayoutVerbSchema.safeParse(verb).success, label).toBe(true);

        const before = state;
        const outcome = applyVerbLocal(state, WORKSPACE_ID, verb);
        // Purity: a verb never mutates the state handed to it, and a verb that
        // did not apply returns that exact state back.
        expect(before, `${label}: reducer mutated its input`).toEqual(before);
        if (!outcome.applied) {
          expect(outcome.state, `${label}: a no-op must return the same reference`).toBe(before);
        }
        state = outcome.state;
        expectInvariant(state, label);

        if (state === null) continue;
        // Every pane belongs to exactly one column, and the projection the
        // store persists is contiguous in both dimensions by construction.
        const grid = gridFromWorkspaceState(state);
        expect(grid.length, `${label}: projection dropped a column`).toBe(state.columns.length);
        expect(
          grid.reduce((total, column) => total + column.panes.length, 0),
          `${label}: projection dropped a pane`,
        ).toBe(panesOf(state).length);
        for (const column of grid) {
          expect(column.panes.length, `${label}: projected an empty column`).toBeGreaterThan(0);
        }
        // Focus never dangles: `activePaneId` always names a live pane.
        expect(
          panesOf(state).some((pane) => pane.id === state!.activePaneId),
          `${label}: activePaneId dangles`,
        ).toBe(true);
        // And the rows round-trip back to the same grid, fractions included.
        expect(
          gridFromWorkspaceState(workspaceStateFromGrid({ workspaceId: WORKSPACE_ID, grid })!),
          `${label}: row round-trip is not an identity`,
        ).toEqual(grid);
      }
    }
  });
});

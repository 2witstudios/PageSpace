/**
 * The shared pane-grid verb engine (`applyVerbLocal`) and its projection
 * pair (`gridFromWorkspaceState` / `workspaceStateFromGrid`).
 *
 * The individual transitions (split/assign/close/reset/…) are pinned by the
 * web client's own pane-reducer suite (which now runs against these very
 * functions via re-export); what THIS suite owns is the verb layer on top —
 * targeting, no-op semantics, the focus-or-assign policy — and, since the
 * `workspaceState` blob was dropped, the SINGLE-SOURCE property that
 * replaced the old "blob ≡ rows" drift guard: after ANY sequence of verbs
 * the persisted ROWS are a complete record of the grid's structure — reading
 * them back and re-reducing the next verb against that rehydration lands on
 * exactly the grid the in-memory state carries (a seeded random-sequence
 * property). There is nothing left to drift against; what has to hold now is
 * that the one remaining representation loses nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  applyVerbLocal,
  gridFromWorkspaceState,
  workspaceStateFromGrid,
  newWorkspace,
  panesOf,
  workspaceLayoutVerbSchema,
  type WorkspaceLayoutVerb,
  type WorkspaceState,
} from '../workspace-layout-verbs';
import { type PaneScope } from '../contract';
import { createFakeWorkspaceLayoutStore } from '../../services/agent-workspaces/__tests__/fake-workspace-layout-store';

const WORKSPACE_ID = 'ses-1';

const chatScope = (targetId: string, name = 'Conversation'): PaneScope => ({
  kind: 'chat',
  name,
  targetId,
  agentPageId: null,
});

const terminalScope = (targetId: string): PaneScope => ({
  kind: 'terminal',
  name: 'shell',
  targetId,
  agentPageId: null,
});

const opening = (): WorkspaceState =>
  newWorkspace({ workspaceId: WORKSPACE_ID, paneId: 'pane-1', columnId: 'col-1', scope: chatScope('conv-1') });

describe('applyVerbLocal: ensure', () => {
  it('mints the opening grid for a session without one', () => {
    const outcome = applyVerbLocal(null, WORKSPACE_ID, {
      type: 'ensure',
      columnId: 'col-1',
      paneId: 'pane-1',
      scope: chatScope('conv-1'),
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.state).toEqual(opening());
  });

  it('no-ops when a grid already exists (idempotent)', () => {
    const state = opening();
    const outcome = applyVerbLocal(state, WORKSPACE_ID, {
      type: 'ensure',
      columnId: 'col-9',
      paneId: 'pane-9',
      scope: chatScope('conv-9'),
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.state).toBe(state);
  });
});

describe('applyVerbLocal: structural transitions', () => {
  it('split_right adds a new unbound column after the source pane', () => {
    const outcome = applyVerbLocal(opening(), WORKSPACE_ID, {
      type: 'split_right',
      fromPaneId: 'pane-1',
      newColumnId: 'col-2',
      newPaneId: 'pane-2',
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.state?.columns.map((c) => c.id)).toEqual(['col-1', 'col-2']);
    expect(outcome.state?.pendingPickerPaneId).toBe('pane-2');
  });

  it('split_down stacks a new unbound pane in the source column', () => {
    const outcome = applyVerbLocal(opening(), WORKSPACE_ID, {
      type: 'split_down',
      fromPaneId: 'pane-1',
      newPaneId: 'pane-2',
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.state?.columns[0].panes.map((p) => p.id)).toEqual(['pane-1', 'pane-2']);
  });

  it('any verb targeting an unknown pane no-ops (a stale click racing a close is never an error)', () => {
    const state = opening();
    for (const verb of [
      { type: 'split_right', fromPaneId: 'ghost', newColumnId: 'c', newPaneId: 'p' },
      { type: 'split_down', fromPaneId: 'ghost', newPaneId: 'p' },
      { type: 'assign_pane', paneId: 'ghost', scope: chatScope('conv-2') },
      { type: 'close_pane', paneId: 'ghost' },
      { type: 'reset_pane', paneId: 'ghost' },
      { type: 'replace_conversation', oldTargetId: 'ghost', scope: chatScope('conv-2') },
    ] satisfies WorkspaceLayoutVerb[]) {
      const outcome = applyVerbLocal(state, WORKSPACE_ID, verb);
      expect(outcome.applied, verb.type).toBe(false);
      expect(outcome.state).toBe(state);
    }
  });

  it('every verb except ensure/open_conversation no-ops on a session with no grid', () => {
    for (const verb of [
      { type: 'split_right', fromPaneId: 'pane-1', newColumnId: 'c', newPaneId: 'p' },
      { type: 'assign_pane', paneId: 'pane-1', scope: chatScope('conv-2') },
      { type: 'close_pane', paneId: 'pane-1' },
    ] satisfies WorkspaceLayoutVerb[]) {
      const outcome = applyVerbLocal(null, WORKSPACE_ID, verb);
      expect(outcome.applied, verb.type).toBe(false);
      expect(outcome.state).toBeNull();
    }
  });

  it('close_pane on the LAST pane no-ops — emptying a session is a lifecycle act, not a layout verb', () => {
    const state = opening();
    const outcome = applyVerbLocal(state, WORKSPACE_ID, { type: 'close_pane', paneId: 'pane-1' });
    expect(outcome.applied).toBe(false);
    expect(outcome.state).toBe(state);
  });
});

describe('applyVerbLocal: open_conversation (focus-or-assign)', () => {
  const open = (state: WorkspaceState | null, scope: PaneScope) =>
    applyVerbLocal(state, WORKSPACE_ID, { type: 'open_conversation', scope, newColumnId: 'col-new', newPaneId: 'pane-new' });

  it('mints the opening grid on a session with no grid', () => {
    const outcome = open(null, chatScope('conv-1'));
    expect(outcome.applied).toBe(true);
    expect(panesOf(outcome.state!).map((p) => p.id)).toEqual(['pane-new']);
  });

  it('focuses the pane already showing the target instead of duplicating it', () => {
    let state = opening();
    state = applyVerbLocal(state, WORKSPACE_ID, {
      type: 'split_right', fromPaneId: 'pane-1', newColumnId: 'col-2', newPaneId: 'pane-2',
    }).state!;
    // Active pane is now pane-2; opening conv-1 focuses pane-1 rather than
    // assigning conv-1 a second surface.
    const outcome = open(state, chatScope('conv-1'));
    expect(outcome.applied).toBe(true);
    expect(outcome.state?.activePaneId).toBe('pane-1');
    expect(panesOf(outcome.state!).filter((p) => p.scope?.targetId === 'conv-1')).toHaveLength(1);
  });

  it('fills a replaceable pane (unbound picker first when active), never a terminal', () => {
    let state = opening();
    state = applyVerbLocal(state, WORKSPACE_ID, {
      type: 'assign_pane', paneId: 'pane-1', scope: terminalScope('shell-1'),
    }).state!;
    state = applyVerbLocal(state, WORKSPACE_ID, {
      type: 'split_right', fromPaneId: 'pane-1', newColumnId: 'col-2', newPaneId: 'pane-2',
    }).state!;
    const outcome = open(state, chatScope('conv-2'));
    expect(outcome.applied).toBe(true);
    const panes = panesOf(outcome.state!);
    expect(panes.find((p) => p.id === 'pane-1')?.scope?.kind).toBe('terminal');
    expect(panes.find((p) => p.id === 'pane-2')?.scope?.targetId).toBe('conv-2');
  });

  it('splits right when every pane is a running terminal or an in-flight mint', () => {
    let state = opening();
    state = applyVerbLocal(state, WORKSPACE_ID, {
      type: 'assign_pane', paneId: 'pane-1', scope: terminalScope('shell-1'),
    }).state!;
    const outcome = open(state, chatScope('conv-2'));
    expect(outcome.applied).toBe(true);
    expect(outcome.state?.columns.map((c) => c.id)).toEqual(['col-1', 'col-new']);
    expect(panesOf(outcome.state!).find((p) => p.id === 'pane-new')?.scope?.targetId).toBe('conv-2');
  });

  it('never replaces a pane whose mint is still in flight (targetId null)', () => {
    let state = opening();
    state = applyVerbLocal(state, WORKSPACE_ID, {
      type: 'assign_pane',
      paneId: 'pane-1',
      scope: { kind: 'chat', name: '', targetId: null, agentPageId: null },
    }).state!;
    const outcome = open(state, chatScope('conv-2'));
    expect(outcome.applied).toBe(true);
    // The in-flight pane keeps its pending mint; the new conversation opens beside it.
    expect(panesOf(outcome.state!).find((p) => p.id === 'pane-1')?.scope?.targetId).toBeNull();
    expect(panesOf(outcome.state!).find((p) => p.id === 'pane-new')?.scope?.targetId).toBe('conv-2');
  });
});

describe('applyVerbLocal: replace_conversation', () => {
  it('repoints every pane showing the dead target at the replacement', () => {
    let state = opening();
    state = applyVerbLocal(state, WORKSPACE_ID, {
      type: 'split_down', fromPaneId: 'pane-1', newPaneId: 'pane-2',
    }).state!;
    state = applyVerbLocal(state, WORKSPACE_ID, {
      type: 'assign_pane', paneId: 'pane-2', scope: chatScope('conv-1'),
    }).state!;
    const outcome = applyVerbLocal(state, WORKSPACE_ID, {
      type: 'replace_conversation', oldTargetId: 'conv-1', scope: chatScope('conv-2', 'Reminted'),
    });
    expect(outcome.applied).toBe(true);
    for (const pane of panesOf(outcome.state!)) {
      expect(pane.scope?.targetId).toBe('conv-2');
    }
  });
});

describe('projections', () => {
  it('gridFromWorkspaceState keeps structure only (no names, no view state)', () => {
    let state = opening();
    state = applyVerbLocal(state, WORKSPACE_ID, {
      type: 'split_right', fromPaneId: 'pane-1', newColumnId: 'col-2', newPaneId: 'pane-2',
    }).state!;
    // Fractions project as CANONICAL null on an unsized grid — never absent.
    // The store's content diff is a JSON.stringify comparison, and an
    // `undefined` key vanishes from that string, so "no fraction" and "an
    // explicit null fraction" would compare equal to two different rows.
    expect(gridFromWorkspaceState(state)).toEqual([
      { id: 'col-1', widthFraction: null, panes: [{ id: 'pane-1', kind: 'chat', targetId: 'conv-1', heightFraction: null }] },
      { id: 'col-2', widthFraction: null, panes: [{ id: 'pane-2', kind: null, targetId: null, heightFraction: null }] },
    ]);
  });

  it('workspaceStateFromGrid takes structure from rows and NOTHING else', () => {
    // Labels and focus have no row to come from — they are derived at read
    // time (`resolvePaneLabels`) and client-local respectively, so the
    // rehydrated state carries neutral defaults, not stale copies.
    const grid = gridFromWorkspaceState(opening());
    const rehydrated = workspaceStateFromGrid({ workspaceId: WORKSPACE_ID, grid });
    expect(rehydrated).toEqual({
      id: WORKSPACE_ID,
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: { kind: 'chat', name: '', targetId: 'conv-1', agentPageId: null } }] }],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    });
  });

  it('anchors focus on the first pane — the server has no focus to restore', () => {
    let state = opening();
    state = applyVerbLocal(state, WORKSPACE_ID, {
      type: 'split_right', fromPaneId: 'pane-1', newColumnId: 'col-2', newPaneId: 'pane-2',
    }).state!;
    // The split moved focus to the new pane; the rows do not carry that, so a
    // server-side rehydrate anchors on the first pane instead (#2048 —
    // deliberately no cross-device focus restore).
    expect(state.activePaneId).toBe('pane-2');
    const rehydrated = workspaceStateFromGrid({ workspaceId: WORKSPACE_ID, grid: gridFromWorkspaceState(state) });
    expect(rehydrated?.activePaneId).toBe('pane-1');
    expect(rehydrated?.pendingPickerPaneId).toBeNull();
  });

  it('no rows is no grid', () => {
    expect(workspaceStateFromGrid({ workspaceId: WORKSPACE_ID, grid: [] })).toBeNull();
    // A grid of empty columns is representable in rows (they carry no min(1)
    // the way the wire schema does) but has no pane to anchor focus on, so it
    // reads as no grid rather than a state with a dangling activePaneId.
    expect(
      workspaceStateFromGrid({ workspaceId: WORKSPACE_ID, grid: [{ id: 'col-1', widthFraction: null, panes: [] }] }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Single-source property — the contract step's acceptance property.
// ---------------------------------------------------------------------------

/** Deterministic LCG so a failure reproduces from its logged seed. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomVerb(rand: () => number, state: WorkspaceState | null, mint: () => string): WorkspaceLayoutVerb {
  const scopes: PaneScope[] = [
    chatScope(`conv-${Math.floor(rand() * 5)}`),
    terminalScope(`shell-${Math.floor(rand() * 3)}`),
    { kind: 'page', name: 'Page', targetId: `page-${Math.floor(rand() * 3)}`, agentPageId: null },
    { kind: 'chat', name: '', targetId: null, agentPageId: null },
  ];
  const scope = scopes[Math.floor(rand() * scopes.length)];
  const panes = state ? panesOf(state) : [];
  // Mix resolvable and unresolvable targets so no-op paths are exercised too.
  const paneId = rand() < 0.8 && panes.length > 0 ? panes[Math.floor(rand() * panes.length)].id : `ghost-${mint()}`;

  switch (Math.floor(rand() * 8)) {
    case 0:
      return { type: 'ensure', columnId: mint(), paneId: mint(), scope };
    case 1:
      return { type: 'split_right', fromPaneId: paneId, newColumnId: mint(), newPaneId: mint() };
    case 2:
      return { type: 'split_down', fromPaneId: paneId, newPaneId: mint() };
    case 3:
      return { type: 'assign_pane', paneId, scope };
    case 4:
      return { type: 'close_pane', paneId };
    case 5:
      return { type: 'reset_pane', paneId };
    case 6:
      return { type: 'open_conversation', scope, newColumnId: mint(), newPaneId: mint() };
    default:
      return { type: 'replace_conversation', oldTargetId: scope.targetId ?? 'conv-0', scope: chatScope(`conv-${Math.floor(rand() * 5)}`) };
  }
}

describe('single source: the rows are the whole grid after ANY verb sequence', () => {
  it('holds across seeded random verb sequences run through the engine + store exactly as the runtime does', async () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const rand = prng(seed * 7919);
      let minted = 0;
      const mint = () => `id-${seed}-${(minted += 1)}`;
      const store = createFakeWorkspaceLayoutStore();

      for (let step = 0; step < 40; step += 1) {
        // The runtime's locked read-reduce-write cycle, verbatim: the ONLY
        // read is the rows, because the blob no longer exists.
        const grid = await store.getWorkspaceGrid(WORKSPACE_ID);
        const state = workspaceStateFromGrid({ workspaceId: WORKSPACE_ID, grid });
        const verb = randomVerb(rand, state, mint);
        const outcome = applyVerbLocal(state, WORKSPACE_ID, verb);
        if (!outcome.applied || outcome.state === null) continue;
        // The verb payload must be wire-legal — the schema and the engine
        // cannot drift on what a verb is.
        expect(workspaceLayoutVerbSchema.safeParse(verb).success, `seed ${seed} step ${step}`).toBe(true);
        await store.replaceWorkspaceGrid({
          workspaceId: WORKSPACE_ID,
          grid: gridFromWorkspaceState(outcome.state),
        });

        // THE invariant: what the rows hold, read back, projects to exactly
        // the grid the reduced state does — every column, pane, binding and
        // fraction survives the only round trip that still exists.
        const rowsAfter = await store.getWorkspaceGrid(WORKSPACE_ID);
        expect(rowsAfter, `seed ${seed} step ${step} (${verb.type})`).toEqual(
          gridFromWorkspaceState(outcome.state),
        );
        const rehydrated = workspaceStateFromGrid({ workspaceId: WORKSPACE_ID, grid: rowsAfter });
        expect(
          rehydrated === null ? [] : gridFromWorkspaceState(rehydrated),
          `seed ${seed} step ${step} (${verb.type}): rehydration is not an identity`,
        ).toEqual(rowsAfter);
      }
    }
  });
});

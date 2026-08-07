/**
 * The queue's pure half. The store is the IO shell around exactly these three
 * functions, so anything provable here is proved without React or a network.
 */
import { describe, it, expect } from 'vitest';
import type { PaneScope } from '@pagespace/lib/agent-workspaces/contract';
import { adoptServerGrid, replayPending, verbAlreadyLanded, type PendingVerbOp } from '../verb-queue';
import { panesOf, type WorkspaceLayoutVerb, type WorkspaceState } from '../pane-reducer';

const scope = (targetId = 'conv-1', name = 'Planning'): PaneScope => ({
  kind: 'chat',
  name,
  targetId,
  agentPageId: 'agent-1',
});

const op = (verb: WorkspaceLayoutVerb, opId = `op-${verb.type}`): PendingVerbOp => ({
  opId,
  baseRev: 0,
  verb,
});

const oneCell = (): WorkspaceState => ({
  id: 'ses-1',
  columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: scope() }] }],
  activePaneId: 'pane-1',
  pendingPickerPaneId: null,
});

describe('verbAlreadyLanded — the id-based idempotency check', () => {
  it('says no against an empty grid', () => {
    expect(verbAlreadyLanded(null, { type: 'ensure', columnId: 'col-1', paneId: 'pane-1', scope: scope() })).toBe(false);
  });

  it('says yes for ensure against ANY existing grid — it only ever creates', () => {
    expect(verbAlreadyLanded(oneCell(), { type: 'ensure', columnId: 'col-x', paneId: 'pane-x', scope: scope() })).toBe(
      true,
    );
  });

  it('recognizes a split whose minted pane is already present', () => {
    const state: WorkspaceState = {
      ...oneCell(),
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: scope() }] },
        { id: 'col-2', panes: [{ id: 'pane-2', scope: null }] },
      ],
    };
    expect(
      verbAlreadyLanded(state, { type: 'split_right', fromPaneId: 'pane-1', newColumnId: 'col-2', newPaneId: 'pane-2' }),
    ).toBe(true);
  });

  it('says no for a split whose minted ids are absent', () => {
    expect(
      verbAlreadyLanded(oneCell(), {
        type: 'split_right',
        fromPaneId: 'pane-1',
        newColumnId: 'col-9',
        newPaneId: 'pane-9',
      }),
    ).toBe(false);
  });

  it('says no for verbs that mint nothing — they are naturally idempotent', () => {
    expect(verbAlreadyLanded(oneCell(), { type: 'assign_pane', paneId: 'pane-1', scope: scope('conv-2') })).toBe(false);
    expect(verbAlreadyLanded(oneCell(), { type: 'close_pane', paneId: 'pane-1' })).toBe(false);
    expect(verbAlreadyLanded(oneCell(), { type: 'reset_pane', paneId: 'pane-1' })).toBe(false);
  });
});

describe('replayPending', () => {
  it('applies the queue in order onto a snapshot', () => {
    const state = replayPending(oneCell(), 'ses-1', [
      op({ type: 'split_right', fromPaneId: 'pane-1', newColumnId: 'col-2', newPaneId: 'pane-2' }),
      op({ type: 'assign_pane', paneId: 'pane-2', scope: scope('conv-2') }),
    ]);
    expect(panesOf(state!)).toHaveLength(2);
    expect(panesOf(state!)[1].scope?.targetId).toBe('conv-2');
  });

  it('does NOT re-create a split the snapshot already contains', () => {
    // The race this exists for: an ack (or a broadcast) delivers a grid that
    // already includes an op still sitting in the queue. Replaying it blind
    // would splice a second column carrying an id that already exists.
    const alreadySplit: WorkspaceState = {
      ...oneCell(),
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope: scope() }] },
        { id: 'col-2', panes: [{ id: 'pane-2', scope: null }] },
      ],
    };

    const state = replayPending(alreadySplit, 'ses-1', [
      op({ type: 'split_right', fromPaneId: 'pane-1', newColumnId: 'col-2', newPaneId: 'pane-2' }),
    ]);

    expect(state!.columns).toHaveLength(2);
    expect(state!.columns.map((column) => column.id)).toEqual(['col-1', 'col-2']);
  });

  it('is a no-op on an empty queue', () => {
    const base = oneCell();
    expect(replayPending(base, 'ses-1', [])).toBe(base);
  });

  it('builds a grid from nothing when the queue starts with ensure', () => {
    const state = replayPending(null, 'ses-1', [
      op({ type: 'ensure', columnId: 'col-1', paneId: 'pane-1', scope: scope() }),
    ]);
    expect(state!.id).toBe('ses-1');
    expect(panesOf(state!)).toHaveLength(1);
  });
});

describe('adoptServerGrid', () => {
  it('turns a wire grid into a reducible state', () => {
    const state = adoptServerGrid('ses-1', [{ id: 'col-1', panes: [{ id: 'pane-1', scope: scope() }] }]);
    expect(state).toEqual({
      id: 'ses-1',
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: scope() }] }],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    });
  });

  it('reads a null or empty grid as "this session has no grid"', () => {
    expect(adoptServerGrid('ses-1', null)).toBeNull();
    expect(adoptServerGrid('ses-1', [])).toBeNull();
  });
});

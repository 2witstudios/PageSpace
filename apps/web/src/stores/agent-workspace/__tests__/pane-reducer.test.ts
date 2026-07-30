/**
 * The pane grid's layout transitions. Pure in, pure out — the discipline the
 * old machine reducer had and the reason its behaviour survived a rewrite that
 * deleted everything around it.
 */
import { describe, it, expect } from 'vitest';
import type { PaneScope } from '@pagespace/lib/agent-sessions/contract';
import {
  newWorkspace,
  assignPane,
  setPanePendingPrompt,
  clearPanePrompt,
  dismissPicker,
  splitRight,
  splitDown,
  closePane,
  selectPane,
  panesOf,
  paneShowing,
  type WorkspaceState,
} from '../pane-reducer';

function chatScope(targetId: string, agentPageId: string | null = 'agent-1'): PaneScope {
  return { kind: 'chat', name: 'Conversation', targetId, agentPageId };
}

function terminalScope(targetId: string | null): PaneScope {
  return { kind: 'terminal', name: 'shell-1', targetId, agentPageId: null };
}

function base(): WorkspaceState {
  return newWorkspace({
    sessionId: 'ses-1',
    paneId: 'pane-1',
    columnId: 'col-1',
    scope: chatScope('conv-1'),
  });
}

describe('newWorkspace', () => {
  it('should open on the conversation itself, never on a picker', () => {
    const state = base();
    expect(panesOf(state)).toHaveLength(1);
    expect(state.columns[0].panes[0].scope).toEqual(chatScope('conv-1'));
    expect(state.activePaneId).toBe('pane-1');
    expect(state.pendingPickerPaneId).toBeNull();
  });

  it('should key the grid by its session', () => {
    expect(base().id).toBe('ses-1');
  });
});

describe('splitRight', () => {
  it('should insert a new column immediately after the source pane\'s column', () => {
    const state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    expect(state.columns.map((c) => c.id)).toEqual(['col-1', 'col-2']);
    expect(state.columns[1].panes).toEqual([{ id: 'pane-2', scope: null }]);
  });

  it('should insert AFTER the source column, not at the end', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    state = splitRight(state, 'pane-1', 'col-3', 'pane-3');
    expect(state.columns.map((c) => c.id)).toEqual(['col-1', 'col-3', 'col-2']);
  });

  it('should focus the new pane and open its picker', () => {
    // A split means "I want something here" — landing the user in the picker is
    // the difference between a new pane and a blank rectangle to go find a
    // control in.
    const state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    expect(state.activePaneId).toBe('pane-2');
    expect(state.pendingPickerPaneId).toBe('pane-2');
  });

  it('given an unresolvable source pane, should no-op — a stale click racing a close', () => {
    const state = base();
    expect(splitRight(state, 'ghost', 'col-2', 'pane-2')).toBe(state);
  });
});

describe('splitDown', () => {
  it('should append to the source pane\'s own column rather than making one', () => {
    const state = splitDown(base(), 'pane-1', 'pane-2');
    expect(state.columns).toHaveLength(1);
    expect(state.columns[0].panes.map((p) => p.id)).toEqual(['pane-1', 'pane-2']);
  });

  it('should focus the new pane and open its picker', () => {
    const state = splitDown(base(), 'pane-1', 'pane-2');
    expect(state.activePaneId).toBe('pane-2');
    expect(state.pendingPickerPaneId).toBe('pane-2');
  });

  it('given an unresolvable source pane, should no-op', () => {
    const state = base();
    expect(splitDown(state, 'ghost', 'pane-2')).toBe(state);
  });
});

describe('assignPane', () => {
  it('should bind the pane and retire its picker', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    state = assignPane(state, 'pane-2', terminalScope('shell-9'));
    expect(state.columns[1].panes[0].scope).toEqual(terminalScope('shell-9'));
    expect(state.pendingPickerPaneId).toBeNull();
  });

  it('should let two panes hold conversations with DIFFERENT agents', () => {
    // The capability whose loss made panes pointless: a grid is not restricted
    // to one agent, or to shells.
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    state = assignPane(state, 'pane-2', chatScope('conv-2', 'agent-2'));
    const [left, right] = panesOf(state);
    expect(left.scope?.agentPageId).toBe('agent-1');
    expect(right.scope?.agentPageId).toBe('agent-2');
  });

  it('should leave another pane\'s pending picker alone', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    state = splitDown(state, 'pane-1', 'pane-3');
    expect(state.pendingPickerPaneId).toBe('pane-3');
    state = assignPane(state, 'pane-2', terminalScope('shell-9'));
    expect(state.pendingPickerPaneId).toBe('pane-3');
  });

  it('given an unresolvable pane, should no-op', () => {
    const state = base();
    expect(assignPane(state, 'ghost', terminalScope('s1'))).toBe(state);
  });
});

describe('closePane', () => {
  it('should remove the pane and drop a column it empties', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    state = closePane(state, 'pane-2');
    expect(state.columns.map((c) => c.id)).toEqual(['col-1']);
  });

  it('should keep a column that still holds panes', () => {
    let state = splitDown(base(), 'pane-1', 'pane-2');
    state = closePane(state, 'pane-2');
    expect(state.columns).toHaveLength(1);
    expect(state.columns[0].panes.map((p) => p.id)).toEqual(['pane-1']);
  });

  it('should re-target active when the active pane is the one closed', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    expect(state.activePaneId).toBe('pane-2');
    state = closePane(state, 'pane-2');
    expect(state.activePaneId).toBe('pane-1');
  });

  it('should leave active alone when another pane closes', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    state = selectPane(state, 'pane-1');
    state = closePane(state, 'pane-2');
    expect(state.activePaneId).toBe('pane-1');
  });

  it('should clear a pending picker pointed at the closed pane', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    expect(state.pendingPickerPaneId).toBe('pane-2');
    state = closePane(state, 'pane-2');
    expect(state.pendingPickerPaneId).toBeNull();
  });

  it('given the last pane, should no-op — a grid is never empty', () => {
    const state = base();
    expect(closePane(state, 'pane-1')).toBe(state);
  });

  it('given an unresolvable pane, should no-op', () => {
    const state = base();
    expect(closePane(state, 'ghost')).toBe(state);
  });
});

describe('selectPane', () => {
  it('should move focus', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    state = selectPane(state, 'pane-1');
    expect(state.activePaneId).toBe('pane-1');
  });

  it('given an unresolvable pane, should no-op', () => {
    const state = base();
    expect(selectPane(state, 'ghost')).toBe(state);
  });
});

describe('pending prompts', () => {
  it('should set and then clear, so a remount cannot re-send', () => {
    let state = setPanePendingPrompt(base(), 'pane-1', 'run the tests');
    expect(panesOf(state)[0].pendingPrompt).toBe('run the tests');
    state = clearPanePrompt(state, 'pane-1');
    expect(panesOf(state)[0].pendingPrompt).toBeUndefined();
    expect('pendingPrompt' in panesOf(state)[0]).toBe(false);
  });

  it('given an unresolvable pane, should no-op', () => {
    const state = base();
    expect(setPanePendingPrompt(state, 'ghost', 'x')).toBe(state);
    expect(clearPanePrompt(state, 'ghost')).toBe(state);
  });
});

describe('dismissPicker', () => {
  it('should clear only the picker it names', () => {
    const state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    expect(dismissPicker(state, 'pane-1')).toBe(state);
    expect(dismissPicker(state, 'pane-2').pendingPickerPaneId).toBeNull();
  });
});

describe('panesOf / paneShowing', () => {
  it('should flatten in visual order — left to right, top to bottom', () => {
    let state = splitDown(base(), 'pane-1', 'pane-2');
    state = splitRight(state, 'pane-1', 'col-2', 'pane-3');
    expect(panesOf(state).map((p) => p.id)).toEqual(['pane-1', 'pane-2', 'pane-3']);
  });

  it('should find a pane already showing a target, so callers focus instead of duplicating', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    state = assignPane(state, 'pane-2', terminalScope('shell-9'));
    expect(paneShowing(state, 'shell-9')?.id).toBe('pane-2');
    expect(paneShowing(state, 'nothing-here')).toBeUndefined();
  });

  it('should not match an unbound pane against a null target', () => {
    const state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    expect(panesOf(state)[1].scope).toBeNull();
    expect(paneShowing(state, 'conv-1')?.id).toBe('pane-1');
  });
});

/**
 * The pane grid's PRIMITIVE transitions — `newWorkspace`, `splitRight`,
 * `splitDown`, `assignPane`, `closePane`, `selectPane`, `dismissPicker`,
 * `resetPane` and the small queries over them. Pure in, pure out.
 *
 * Moved here from `apps/web/src/stores/agent-workspace/__tests__/` with the
 * deletion of the `pane-reducer` re-export shim it used to run against. It is
 * NOT a duplicate of `workspace-layout-verbs.test.ts` next door: that one
 * covers `applyVerbLocal`'s dispatch and the grid projections, this one covers
 * the transitions those dispatch INTO. They were disjoint when they lived in
 * different packages and they still are.
 */
import { describe, it, expect } from 'vitest';
import type { PaneScope } from '../contract';
import {
  newWorkspace,
  assignPane,
  assignPaneShowing,
  dismissPicker,
  splitRight,
  splitDown,
  closePane,
  isLastPane,
  resetPane,
  selectPane,
  panesOf,
  paneShowing,
  type WorkspaceState,
} from '../workspace-layout-verbs';

function chatScope(targetId: string, agentPageId: string | null = 'agent-1'): PaneScope {
  return { kind: 'chat', name: 'Conversation', targetId, agentPageId };
}

function terminalScope(targetId: string | null): PaneScope {
  return { kind: 'terminal', name: 'shell-1', targetId, agentPageId: null };
}

function base(): WorkspaceState {
  return newWorkspace({
    workspaceId: 'ses-1',
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

  it('should replace the pane\'s prior scope entirely, not merge into it', () => {
    const state = assignPane(base(), 'pane-1', chatScope('conv-2', 'agent-2'));
    expect(state.columns[0].panes[0].scope).toEqual(chatScope('conv-2', 'agent-2'));
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

  it('given the pane is already active, returns the SAME reference — not just an equal one', () => {
    // Reference stability here is load-bearing: `useWorkspaceServerSync`'s
    // hydration guard (and `updateWorkspace`'s own `next === current` check)
    // depend on a true no-op producing the identical object, not a fresh
    // copy that merely deep-equals it (review finding).
    const state = base();
    expect(selectPane(state, state.activePaneId)).toBe(state);
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

describe('isLastPane', () => {
  it('given the only pane in the grid, should say so', () => {
    expect(isLastPane(base(), 'pane-1')).toBe(true);
  });

  it('given one of several panes, should say no', () => {
    const state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    expect(isLastPane(state, 'pane-1')).toBe(false);
    expect(isLastPane(state, 'pane-2')).toBe(false);
  });

  it('given an unresolvable pane, should say no rather than throw', () => {
    expect(isLastPane(base(), 'ghost')).toBe(false);
  });
});

describe('resetPane', () => {
  it('should unbind the pane back to null scope', () => {
    const state = resetPane(base(), 'pane-1');
    expect(state.columns[0].panes[0].scope).toBeNull();
  });

  it('should focus the reset pane\'s picker, same as a fresh split', () => {
    const state = resetPane(base(), 'pane-1');
    expect(state.pendingPickerPaneId).toBe('pane-1');
  });

  it('given an unresolvable pane, should no-op', () => {
    const state = base();
    expect(resetPane(state, 'ghost')).toBe(state);
  });

  it('should leave sibling panes untouched', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    state = assignPane(state, 'pane-2', terminalScope('shell-9'));
    state = resetPane(state, 'pane-1');
    expect(panesOf(state).find((p) => p.id === 'pane-2')?.scope).toEqual(terminalScope('shell-9'));
  });
});

describe('assignPaneShowing', () => {
  it('should assign the pane currently showing the old target to a new scope', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    state = assignPane(state, 'pane-2', chatScope('conv-2', 'agent-2'));

    state = assignPaneShowing(state, 'conv-2', chatScope('conv-3', 'agent-3'));

    expect(panesOf(state).find((p) => p.id === 'pane-2')?.scope).toEqual(chatScope('conv-3', 'agent-3'));
  });

  it('given a target shown nowhere, should no-op — nothing stale to prune', () => {
    const state = base();
    expect(assignPaneShowing(state, 'never-shown', chatScope('conv-9'))).toBe(state);
  });

  it('should repoint EVERY pane showing the old target at once, without stealing focus from the active one', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    // Both panes happen to show the same conversation — a duplicate view.
    state = assignPane(state, 'pane-2', chatScope('conv-1'));
    expect(state.activePaneId).toBe('pane-2');
    state = selectPane(state, 'pane-1');

    state = assignPaneShowing(state, 'conv-1', chatScope('conv-2', 'agent-2'));

    const [pane1, pane2] = panesOf(state);
    expect(pane1.scope).toEqual(chatScope('conv-2', 'agent-2'));
    expect(pane2.scope).toEqual(chatScope('conv-2', 'agent-2'));
    // Neither pane's own focus/active-pane pointer moved as a side effect.
    expect(state.activePaneId).toBe('pane-1');
  });
});

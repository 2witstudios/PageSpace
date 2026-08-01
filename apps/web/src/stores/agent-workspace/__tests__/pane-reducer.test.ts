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
  openTab,
  replaceTab,
  switchTab,
  closeTab,
  tabsOf,
  paneTabsOf,
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
    expect(state.columns[1].panes).toEqual([{ id: 'pane-2', scope: null, tabs: [] }]);
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

  it('should replace the pane\'s tab entry for the old target, not just its scope', () => {
    let state = assignPane(base(), 'pane-1', chatScope('conv-1'));
    state = assignPaneShowing(state, 'conv-1', chatScope('conv-2', 'agent-2'));
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-2', 'agent-2')]);
  });

  it('should also repoint a BACKGROUND tab in another pane, without stealing its focus', () => {
    // The deleted/replaced conversation can be open as a non-active tab in
    // a pane whose active scope is something else entirely — that pane's
    // own focus and active tab must be untouched, only the stale tab entry
    // itself gets swapped (review finding: this used to only check each
    // pane's ACTIVE scope, leaving background tabs dangling on a dead id).
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    // pane-2 opens conv-1 (background — pane-1 stays the grid's active pane).
    state = openTab(state, 'pane-2', chatScope('conv-1'));
    state = openTab(state, 'pane-2', chatScope('conv-9', 'agent-9'));
    expect(state.activePaneId).toBe('pane-2');
    state = selectPane(state, 'pane-1');

    state = assignPaneShowing(state, 'conv-1', chatScope('conv-2', 'agent-2'));

    const pane2 = panesOf(state).find((p) => p.id === 'pane-2')!;
    expect(pane2.tabs).toEqual([chatScope('conv-2', 'agent-2'), chatScope('conv-9', 'agent-9')]);
    // Still showing conv-9 (its active tab) — repointing the BACKGROUND tab
    // must not change what the pane is currently displaying or steal focus.
    expect(pane2.scope).toEqual(chatScope('conv-9', 'agent-9'));
    expect(state.activePaneId).toBe('pane-1');
  });

  it('should repoint EVERY pane referencing the old target at once — active in one, background in another', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    // pane-1: conv-1 is the ACTIVE tab (from `base()`).
    // pane-2: conv-1 is a BACKGROUND tab.
    state = openTab(state, 'pane-2', chatScope('conv-1'));
    state = openTab(state, 'pane-2', chatScope('conv-9', 'agent-9'));

    state = assignPaneShowing(state, 'conv-1', chatScope('conv-2', 'agent-2'));

    const [pane1, pane2] = panesOf(state);
    expect(pane1.scope).toEqual(chatScope('conv-2', 'agent-2'));
    expect(pane2.tabs).toEqual([chatScope('conv-2', 'agent-2'), chatScope('conv-9', 'agent-9')]);
    expect(pane2.scope).toEqual(chatScope('conv-9', 'agent-9'));
  });
});

describe('newWorkspace: tab seeding', () => {
  it('should seed the opening chat pane\'s tabs with its own scope', () => {
    expect(paneTabsOf(base(), 'pane-1')).toEqual([chatScope('conv-1')]);
  });

  it('should leave a non-chat opening pane tab-less', () => {
    const state = newWorkspace({ sessionId: 'ses-1', paneId: 'pane-1', columnId: 'col-1', scope: terminalScope('shell-1') });
    expect(paneTabsOf(state, 'pane-1')).toEqual([]);
  });
});

describe('assignPane: tab bookkeeping', () => {
  it('should add the pane\'s first chat scope as its sole tab', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    state = assignPane(state, 'pane-2', chatScope('conv-2', 'agent-2'));
    expect(paneTabsOf(state, 'pane-2')).toEqual([chatScope('conv-2', 'agent-2')]);
  });

  it('should replace the previously-active tab in place when settling straight to a new chat scope', () => {
    // A single-step assign (no intervening loading call) — e.g. History-pick.
    const state = assignPane(base(), 'pane-1', chatScope('conv-2', 'agent-2'));
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-2', 'agent-2')]);
  });

  it('should clear tabs when the pane settles on a non-chat scope', () => {
    const state = assignPane(base(), 'pane-1', terminalScope('shell-1'));
    expect(paneTabsOf(state, 'pane-1')).toEqual([]);
  });

  it('given a loading assign (targetId null), should leave tabs untouched', () => {
    const state = assignPane(base(), 'pane-1', { kind: 'chat', name: 'New conversation', targetId: null, agentPageId: 'agent-2' });
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-1')]);
    expect(state.columns[0].panes[0].scope?.targetId).toBeNull();
  });

  it('should not duplicate a tab already open when re-settling on the same targetId', () => {
    const state = assignPane(base(), 'pane-1', chatScope('conv-1', 'agent-9'));
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-1', 'agent-9')]);
  });

  it('given an unresolvable pane, should no-op', () => {
    const state = base();
    expect(assignPane(state, 'ghost', chatScope('conv-9'))).toBe(state);
  });
});

describe('replaceTab', () => {
  it('should replace the tab matching oldTargetId and activate the new scope', () => {
    const state = replaceTab(base(), 'pane-1', 'conv-1', chatScope('conv-2', 'agent-2'));
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-2', 'agent-2')]);
    expect(state.columns[0].panes[0].scope).toEqual(chatScope('conv-2', 'agent-2'));
  });

  it('should survive an intervening loading step using the SAME captured oldTargetId', () => {
    // The exact two-step async mint sequence: loading (targetId null) then
    // resolved, both keyed off the id captured BEFORE the sequence began —
    // this is the case a naive "diff against pane.scope" approach breaks,
    // because the loading step already overwrote pane.scope by the time the
    // resolved step runs.
    let state = replaceTab(base(), 'pane-1', 'conv-1', { kind: 'chat', name: 'New conversation', targetId: null, agentPageId: 'agent-2' });
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-1')]); // still untouched — loading no-ops on tabs
    state = replaceTab(state, 'pane-1', 'conv-1', chatScope('conv-2', 'agent-2'));
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-2', 'agent-2')]);
  });

  it('given a null oldTargetId (nothing to replace), should append instead', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2'); // pane-2 unbound, no tabs
    state = replaceTab(state, 'pane-2', null, chatScope('conv-9'));
    expect(paneTabsOf(state, 'pane-2')).toEqual([chatScope('conv-9')]);
  });

  it('given an oldTargetId no longer present (closed meanwhile), should append rather than throw', () => {
    const state = replaceTab(base(), 'pane-1', 'conv-gone', chatScope('conv-2'));
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-1'), chatScope('conv-2')]);
  });

  it('given a still-loading newScope, should leave tabs untouched regardless of oldTargetId', () => {
    const state = replaceTab(base(), 'pane-1', null, { kind: 'chat', name: 'x', targetId: null, agentPageId: null });
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-1')]);
  });

  it('given an unresolvable pane, should no-op', () => {
    const state = base();
    expect(replaceTab(state, 'ghost', 'conv-1', chatScope('conv-2'))).toBe(state);
  });
});

describe('openTab', () => {
  it('should append a new tab and activate it, keeping the prior tab open', () => {
    const state = openTab(base(), 'pane-1', chatScope('conv-2', 'agent-2'));
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-1'), chatScope('conv-2', 'agent-2')]);
    expect(state.columns[0].panes[0].scope).toEqual(chatScope('conv-2', 'agent-2'));
  });

  it('given an agent already open in this pane, should activate it rather than duplicate', () => {
    let state = openTab(base(), 'pane-1', chatScope('conv-2', 'agent-2'));
    state = openTab(state, 'pane-1', chatScope('conv-1'));
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-1'), chatScope('conv-2', 'agent-2')]);
  });

  it('should not touch tabs while the new tab is still loading', () => {
    const state = openTab(base(), 'pane-1', { kind: 'chat', name: 'New conversation', targetId: null, agentPageId: 'agent-2' });
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-1')]);
  });
});

describe('switchTab', () => {
  it('should activate an already-open tab without touching the tab list', () => {
    let state = openTab(base(), 'pane-1', chatScope('conv-2', 'agent-2'));
    state = switchTab(state, 'pane-1', 'conv-1');
    expect(state.columns[0].panes[0].scope).toEqual(chatScope('conv-1'));
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-1'), chatScope('conv-2', 'agent-2')]);
    expect(state.activePaneId).toBe('pane-1');
  });

  it('given a targetId not open in this pane, should no-op', () => {
    const state = base();
    expect(switchTab(state, 'pane-1', 'conv-nowhere')).toBe(state);
  });

  it('given an unresolvable pane, should no-op', () => {
    const state = base();
    expect(switchTab(state, 'ghost', 'conv-1')).toBe(state);
  });
});

describe('closeTab', () => {
  it('should remove a background (non-active) tab, leaving the active one untouched', () => {
    let state = openTab(base(), 'pane-1', chatScope('conv-2', 'agent-2'));
    state = closeTab(state, 'pane-1', 'conv-2');
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-1')]);
    expect(state.columns[0].panes[0].scope).toEqual(chatScope('conv-1'));
  });

  it('should activate the previous remaining tab when the active one closes', () => {
    let state = openTab(base(), 'pane-1', chatScope('conv-2', 'agent-2'));
    state = openTab(state, 'pane-1', chatScope('conv-3', 'agent-3'));
    // active is conv-3 (index 2); closing it should fall back to conv-2 (index 1).
    state = closeTab(state, 'pane-1', 'conv-3');
    expect(state.columns[0].panes[0].scope).toEqual(chatScope('conv-2', 'agent-2'));
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-1'), chatScope('conv-2', 'agent-2')]);
  });

  it('should fall back to the first tab when the active (first) one closes', () => {
    let state = openTab(base(), 'pane-1', chatScope('conv-2', 'agent-2'));
    state = switchTab(state, 'pane-1', 'conv-1');
    state = closeTab(state, 'pane-1', 'conv-1');
    expect(state.columns[0].panes[0].scope).toEqual(chatScope('conv-2', 'agent-2'));
    expect(paneTabsOf(state, 'pane-1')).toEqual([chatScope('conv-2', 'agent-2')]);
  });

  it('should revert to the picker (null scope) when the last tab closes', () => {
    const state = closeTab(base(), 'pane-1', 'conv-1');
    expect(state.columns[0].panes[0].scope).toBeNull();
    expect(paneTabsOf(state, 'pane-1')).toEqual([]);
    expect(state.pendingPickerPaneId).toBe('pane-1');
  });

  it('given a targetId not open in this pane, should no-op', () => {
    const state = base();
    expect(closeTab(state, 'pane-1', 'conv-nowhere')).toBe(state);
  });

  it('given an unresolvable pane, should no-op', () => {
    const state = base();
    expect(closeTab(state, 'ghost', 'conv-1')).toBe(state);
  });

  it('closing the last tab of a NON-active pane still reverts THAT pane to its own picker', () => {
    // `handleHistoryDeleteConversation` (AgentPanes.tsx) can call closeTab on
    // a pane that isn't the grid's currently active one — e.g. the same
    // deleted conversation was the sole tab in two panes at once. Every
    // affected pane still gets its own picker; this only pins down that
    // pane-1 (inactive here) does too, not any claim about which pane's
    // `pendingPickerPaneId` "wins" when multiple panes revert in the same
    // sequence of calls (each call sets it, so the last one processed is
    // what the grid shows a picker for — a pre-existing, low-severity
    // limitation of the single `pendingPickerPaneId` field, not something
    // this test asserts either way).
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    state = selectPane(state, 'pane-2');
    expect(state.activePaneId).toBe('pane-2');

    state = closeTab(state, 'pane-1', 'conv-1');

    expect(state.columns[0].panes[0].scope).toBeNull();
    expect(paneTabsOf(state, 'pane-1')).toEqual([]);
    expect(state.pendingPickerPaneId).toBe('pane-1');
    // The active pane never moved — closing an inactive pane's own tab must
    // not steal grid focus.
    expect(state.activePaneId).toBe('pane-2');
  });
});

describe('tabsOf / paneTabsOf', () => {
  it('should flatten every pane\'s tabs, tagged with their owning pane', () => {
    let state = splitRight(base(), 'pane-1', 'col-2', 'pane-2');
    state = assignPane(state, 'pane-2', chatScope('conv-2', 'agent-2'));
    expect(tabsOf(state)).toEqual([
      { paneId: 'pane-1', tab: chatScope('conv-1') },
      { paneId: 'pane-2', tab: chatScope('conv-2', 'agent-2') },
    ]);
  });

  it('given an unresolvable pane, paneTabsOf should return an empty array', () => {
    expect(paneTabsOf(base(), 'ghost')).toEqual([]);
  });
});

import { describe, it } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import { isValidAgentTerminalName, AGENT_LAUNCH_SPECS } from '@pagespace/lib/services/machines/agent-terminal-types';
import {
  newWorkspace,
  initialMachineWorkspaces,
  addWorkspace,
  setActiveWorkspace,
  updateWorkspace,
  workspacesOf,
  sessionWorkspaceId,
  nextWorkspaceName,
  assignPane,
  clearPanePrompt,
  dismissPicker,
  splitRight,
  splitDown,
  closePane,
  selectPane,
  panesOf,
  autoSessionName,
  MACHINE_NODE_SCOPE,
  type WorkspaceState,
} from '../workspace-reducer';

const BRANCH_SCOPE = { projectName: 'app', branchName: 'main' };

/** A one-pane workspace — what every workspace starts as. */
const aWorkspace = (id = 'ws-1', firstPaneId = 'pane-1'): WorkspaceState =>
  newWorkspace({ id, name: id, scope: BRANCH_SCOPE, firstPaneId });

describe('newWorkspace', () => {
  it('given a workspace born empty, should open with one empty pane, ready for the picker', () => {
    assert({
      given: 'a workspace created with no session',
      should: 'hold a single empty pane — an empty pane IS the agent picker',
      actual: newWorkspace({ id: 'ws-1', name: 'Workspace 1', scope: MACHINE_NODE_SCOPE, firstPaneId: 'pane-1' }),
      expected: {
        id: 'ws-1',
        name: 'Workspace 1',
        scope: MACHINE_NODE_SCOPE,
        columns: [{ id: 'pane-1', panes: [{ id: 'pane-1', scope: null }] }],
        activePaneId: 'pane-1',
        pendingPickerPaneId: null,
      },
    });
  });

  it('given a workspace born from a session, should open with that session running in its first pane', () => {
    const scope = { ...BRANCH_SCOPE, name: 'claude-a1b2c3' };

    assert({
      given: 'a workspace created for an existing session',
      should: 'show that session immediately, rather than an empty pane the user must fill',
      actual: panesOf(
        newWorkspace({ id: 'ws-1', name: scope.name, scope: BRANCH_SCOPE, firstPaneId: 'pane-1', firstPaneScope: scope })
      ),
      expected: [{ id: 'pane-1', scope }],
    });
  });
});

describe('setActiveWorkspace — selecting an item switches the whole middle view', () => {
  it('given a second workspace, should switch the view to ITS grid, leaving the first intact', () => {
    // Workspace A holds a two-pane split; workspace B holds one pane.
    const a = splitRight(aWorkspace('ws-a', 'a1'), 'a1', 'col-a2', 'a2');
    const b = aWorkspace('ws-b', 'b1');
    const machine = addWorkspace(initialMachineWorkspaces(a), b);

    const backToA = setActiveWorkspace(machine, 'ws-a');

    assert({
      given: 'workspace A holding a two-pane split, and workspace B holding one pane',
      should:
        'switch the ENTIRE view between their grids — THIS is the fix: selecting an item swaps the whole pane combination, not the contents of one pane',
      actual: {
        showingB: {
          active: machine.activeWorkspaceId,
          panes: panesOf(machine.workspaces[machine.activeWorkspaceId]).length,
        },
        showingA: {
          active: backToA.activeWorkspaceId,
          panes: panesOf(backToA.workspaces[backToA.activeWorkspaceId]).length,
        },
      },
      expected: {
        showingB: { active: 'ws-b', panes: 1 },
        showingA: { active: 'ws-a', panes: 2 },
      },
    });
  });

  it('given an unknown workspace id, should be a no-op', () => {
    const machine = initialMachineWorkspaces(aWorkspace());

    assert({
      given: 'a selection naming a workspace that no longer exists',
      should: 'keep showing the current one rather than blanking the middle view',
      actual: setActiveWorkspace(machine, 'ws-gone'),
      expected: machine,
    });
  });
});

describe('addWorkspace', () => {
  it('given a new workspace, should append it in order and show it', () => {
    const machine = addWorkspace(initialMachineWorkspaces(aWorkspace('ws-a', 'a1')), aWorkspace('ws-b', 'b1'));

    assert({
      given: 'a workspace the user just created',
      should: 'append it to the sidebar order and make it the one on screen — they created it to use it',
      actual: { order: machine.order, active: machine.activeWorkspaceId },
      expected: { order: ['ws-a', 'ws-b'], active: 'ws-b' },
    });
  });

  it('given a workspace id that already exists, should show it instead of resetting it', () => {
    const a = splitRight(aWorkspace('ws-a', 'a1'), 'a1', 'col-a2', 'a2');
    const machine = setActiveWorkspace(addWorkspace(initialMachineWorkspaces(a), aWorkspace('ws-b', 'b1')), 'ws-b');

    const reopened = addWorkspace(machine, aWorkspace('ws-a', 'fresh-pane'));

    assert({
      given: 'a workspace re-opened when it already exists (its sidebar row clicked again)',
      should: 'restore the grid it had, NOT reset it to a fresh single pane',
      actual: {
        active: reopened.activeWorkspaceId,
        panes: panesOf(reopened.workspaces['ws-a']).length,
        order: reopened.order,
      },
      expected: { active: 'ws-a', panes: 2, order: ['ws-a', 'ws-b'] },
    });
  });
});

describe('updateWorkspace — a split lands in the workspace it was made in', () => {
  it('given a split in one workspace, should not touch a sibling workspace', () => {
    const machine = addWorkspace(initialMachineWorkspaces(aWorkspace('ws-a', 'a1')), aWorkspace('ws-b', 'b1'));

    const split = updateWorkspace(machine, 'ws-b', (workspace) => splitDown(workspace, 'b1', 'b2'));

    assert({
      given: 'a split performed while workspace B is on screen',
      should: 'add the pane to B only — a workspace owns its own combination of terminals',
      actual: { b: panesOf(split.workspaces['ws-b']).length, a: panesOf(split.workspaces['ws-a']).length },
      expected: { b: 2, a: 1 },
    });
  });

  it('given an unknown workspace id, should be a no-op', () => {
    const machine = initialMachineWorkspaces(aWorkspace());

    assert({
      given: 'a write addressed to a workspace that is gone',
      should: 'be a no-op rather than an error',
      actual: updateWorkspace(machine, 'ws-gone', (workspace) => splitDown(workspace, 'pane-1', 'pane-2')),
      expected: machine,
    });
  });
});

describe('sessionWorkspaceId', () => {
  it('given the same session twice, should resolve to the same workspace', () => {
    const scope = { ...BRANCH_SCOPE, name: 'claude-a1b2c3' };

    assert({
      given: 'a session row clicked twice',
      should:
        'address ONE workspace — so re-opening it restores the panes split into it, instead of minting a new workspace on every click',
      actual: sessionWorkspaceId(scope) === sessionWorkspaceId({ ...scope }),
      expected: true,
    });
  });

  it('given sessions of the same name under different nodes, should keep them apart', () => {
    const ids = new Set([
      sessionWorkspaceId({ name: 'claude-a1' }),
      sessionWorkspaceId({ projectName: 'app', name: 'claude-a1' }),
      sessionWorkspaceId({ projectName: 'app', branchName: 'main', name: 'claude-a1' }),
    ]);

    assert({
      given: 'one session name reused at machine, project and branch scope',
      should: 'give each its own workspace — they are different sessions in different checkouts',
      actual: ids.size,
      expected: 3,
    });
  });
});

describe('nextWorkspaceName', () => {
  it('given existing workspaces, should take the first free index', () => {
    const machine = addWorkspace(
      initialMachineWorkspaces(newWorkspace({ id: 'a', name: 'Workspace 1', scope: {}, firstPaneId: 'p1' })),
      newWorkspace({ id: 'b', name: 'Workspace 3', scope: {}, firstPaneId: 'p2' })
    );

    assert({
      given: 'Workspace 1 and Workspace 3 already taken',
      should: 'auto-name the next one Workspace 2 — the user is never asked for a name, so the name has to pick itself',
      actual: nextWorkspaceName(machine),
      expected: 'Workspace 2',
    });
  });
});

describe('workspacesOf', () => {
  it('given a machine, should list its workspaces in sidebar order', () => {
    const machine = addWorkspace(initialMachineWorkspaces(aWorkspace('ws-a', 'a1')), aWorkspace('ws-b', 'b1'));

    assert({
      given: 'a machine with two workspaces, the first one re-selected',
      should: 'list them in insertion order — selecting must not reshuffle the sidebar',
      actual: workspacesOf(setActiveWorkspace(machine, 'ws-a')).map((workspace) => workspace.id),
      expected: ['ws-a', 'ws-b'],
    });
  });
});

describe('splitRight / splitDown', () => {
  it('given a split to the right, should insert a new column after it and auto-open its picker', () => {
    assert({
      given: 'a split to the right',
      should: 'add the column, activate the new pane, and point the picker at it so the user lands in it',
      actual: splitRight(aWorkspace(), 'pane-1', 'col-2', 'pane-2'),
      expected: {
        ...aWorkspace(),
        columns: [
          { id: 'pane-1', panes: [{ id: 'pane-1', scope: null }] },
          { id: 'col-2', panes: [{ id: 'pane-2', scope: null }] },
        ],
        activePaneId: 'pane-2',
        pendingPickerPaneId: 'pane-2',
      },
    });
  });

  it('given a split down, should stack the new pane in the same column', () => {
    const actual = splitDown(aWorkspace(), 'pane-1', 'pane-2');

    assert({
      given: 'a split downward',
      should: 'stack within the column — the grid is columns of stacked panes, not a recursive tree',
      actual: {
        columns: actual.columns.length,
        panesInColumn: actual.columns[0].panes.length,
        picker: actual.pendingPickerPaneId,
      },
      expected: { columns: 1, panesInColumn: 2, picker: 'pane-2' },
    });
  });

  it('given a pane id that does not resolve, should be a no-op', () => {
    const state = aWorkspace();

    assert({
      given: 'a stale split click racing a close',
      should: 'be a no-op',
      actual: [splitRight(state, 'gone', 'c', 'p'), splitDown(state, 'gone', 'p')],
      expected: [state, state],
    });
  });

  it('given splitting the middle column of three, should insert immediately after it', () => {
    const three = splitRight(splitRight(aWorkspace(), 'pane-1', 'col-2', 'pane-2'), 'pane-2', 'col-3', 'pane-3');

    assert({
      given: 'a split from the middle column',
      should: 'insert the new column immediately after it, not at the end',
      actual: splitRight(three, 'pane-2', 'col-new', 'pane-new').columns.map((column) => column.id),
      expected: ['pane-1', 'col-2', 'col-new', 'col-3'],
    });
  });
});

describe('assignPane (split-and-pick landing)', () => {
  it('given a spawn that resolves while ANOTHER pane is active, should bind it to the pane it was picked in', () => {
    const state = { ...splitRight(aWorkspace(), 'pane-1', 'col-2', 'pane-2'), activePaneId: 'pane-2' };
    const scope = { ...BRANCH_SCOPE, name: 'claude-a1b2c3' };

    const actual = assignPane(state, 'pane-1', scope, 'fix the build');

    assert({
      given: 'a spawn picked in pane-1 that resolves while pane-2 is active (a cold Sprite boot the user clicked away from)',
      should:
        'bind the agent to pane-1 — the pane it was picked in — and focus it, while pane-2 stays empty and keeps the pending picker it was split with',
      actual: {
        pane1: actual.columns[0].panes[0],
        pane2: actual.columns[1].panes[0],
        activePaneId: actual.activePaneId,
        pendingPickerPaneId: actual.pendingPickerPaneId,
      },
      expected: {
        pane1: { id: 'pane-1', scope, pendingPrompt: 'fix the build' },
        pane2: { id: 'pane-2', scope: null },
        activePaneId: 'pane-1',
        pendingPickerPaneId: 'pane-2',
      },
    });
  });

  it('given a pane closed before its spawn resolved, should be a no-op', () => {
    const state = aWorkspace();

    assert({
      given: 'a pane closed while its agent was still booting',
      should:
        'return the state untouched — the store reads that identity to know the session it just created is orphaned, and removes it',
      actual: assignPane(state, 'closed-pane', { name: 'claude-a1b2c3' }),
      expected: state,
    });
  });
});

describe('clearPanePrompt', () => {
  it('given a prompt that has been typed into the PTY, should drop it', () => {
    const scope = { name: 'claude-a1b2c3' };
    const state = assignPane(aWorkspace(), 'pane-1', scope, 'fix the build');

    assert({
      given: 'a starting prompt already delivered to the agent',
      should: 'drop it — a pane that re-mounts must reattach, not retype the prompt at a running agent',
      actual: panesOf(clearPanePrompt(state, 'pane-1'))[0],
      expected: { id: 'pane-1', scope, pendingPrompt: undefined },
    });
  });
});

describe('dismissPicker', () => {
  it('given the pending picker pane, should clear the focus intent but keep the pane empty', () => {
    const state = splitDown(aWorkspace(), 'pane-1', 'pane-2');

    const actual = dismissPicker(state, 'pane-2');

    assert({
      given: 'the auto-focused picker of a freshly split pane, once it has taken focus',
      should: 'clear the focus intent while leaving the pane empty and still offering its picker',
      actual: { pendingPickerPaneId: actual.pendingPickerPaneId, stillEmpty: panesOf(actual)[1].scope },
      expected: { pendingPickerPaneId: null, stillEmpty: null },
    });
  });

  it('given a pane that is not the pending picker, should be a no-op', () => {
    const state = splitDown(aWorkspace(), 'pane-1', 'pane-2');

    assert({
      given: 'a pane other than the pending picker',
      should: "be a no-op — one pane taking focus must not cancel another pane's pending picker",
      actual: dismissPicker(state, 'pane-1'),
      expected: state,
    });
  });
});

describe('closePane', () => {
  it('given the last remaining pane, should be a no-op', () => {
    const state = aWorkspace();

    assert({
      given: 'the only pane of a workspace',
      should: 'be a no-op — a workspace never has zero panes',
      actual: closePane(state, 'pane-1'),
      expected: state,
    });
  });

  it('given the last pane in a column, should remove the column and re-target the active pane', () => {
    const state = splitRight(aWorkspace(), 'pane-1', 'col-2', 'pane-2');

    assert({
      given: 'the only pane of one column of two closed',
      should: 'remove the column with it and point active at a live pane',
      actual: closePane(state, 'pane-2'),
      expected: { ...aWorkspace(), activePaneId: 'pane-1', pendingPickerPaneId: null },
    });
  });

  it('given the pending picker pane is closed, should clear the focus intent', () => {
    const state = splitRight(aWorkspace(), 'pane-1', 'col-2', 'pane-2');

    assert({
      given: 'a freshly split pane closed before anything was picked in it',
      should: 'clear the pending picker — it points at a pane that no longer exists',
      actual: closePane(state, 'pane-2').pendingPickerPaneId,
      expected: null,
    });
  });
});

describe('selectPane', () => {
  it('given a valid pane id, should activate it; given an unknown one, should be a no-op', () => {
    const state = splitRight(aWorkspace(), 'pane-1', 'col-2', 'pane-2');

    assert({
      given: 'a valid pane id, then an unknown one',
      should: 'activate the valid pane and ignore the unknown one',
      actual: [selectPane(state, 'pane-1').activePaneId, selectPane(state, 'gone')],
      expected: ['pane-1', state],
    });
  });
});

describe('autoSessionName', () => {
  it('given every agent type and a uuid-shaped suffix, should produce a valid session name', () => {
    const names = Object.keys(AGENT_LAUNCH_SPECS).map((type) => autoSessionName(type, '3f2a91b7c4d5'));

    assert({
      given: 'each agent type auto-named with a fresh suffix (picking an agent is ONE act — the user is never asked for a name)',
      should: 'always satisfy isValidAgentTerminalName, the contract the spawn API enforces',
      actual: names.every(isValidAgentTerminalName),
      expected: true,
    });
  });

  it('given two spawns of the same type in one workspace, should not collide', () => {
    assert({
      given: 'two claude agents spawned into two panes of one workspace (name_in_use is a 409)',
      should: 'differ — the suffix, not the type, carries the identity',
      actual: autoSessionName('claude', 'aaaaaa') === autoSessionName('claude', 'bbbbbb'),
      expected: false,
    });
  });

  it('given a suffix of only separator characters, should still produce a valid name', () => {
    assert({
      given: 'a degenerate suffix with nothing name-safe in it',
      should: 'fall back to the bare agent type rather than emit a trailing dash the API would reject',
      actual: autoSessionName('claude', '----'),
      expected: 'claude',
    });
  });
});

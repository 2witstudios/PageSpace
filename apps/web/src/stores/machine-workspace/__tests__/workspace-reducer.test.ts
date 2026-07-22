import { describe, it } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import { isValidAgentTerminalName, AGENT_LAUNCH_SPECS } from '@pagespace/lib/services/machines/agent-terminal-types';
import {
  newWorkspace,
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
  closePaneIn,
  removedWorkspaceBy,
  selectPane,
  panesOf,
  showSessionIn,
  removeWorkspace,
  renameWorkspace,
  mergeServerWorkspaces,
  applyServerWorkspaceUpsert,
  applyServerWorkspaceDeleted,
  sanitizeMachines,
  autoSessionName,
  MACHINE_NODE_SCOPE,
  type WorkspaceState,
  type MachineWorkspacesState,
  type ServerWorkspaceDTO,
} from '../workspace-reducer';

const BRANCH_SCOPE = { projectName: 'app', branchName: 'main' };

/** A one-pane workspace — what every workspace starts as. */
const aWorkspace = (id = 'ws-1', firstPaneId = 'pane-1'): WorkspaceState =>
  newWorkspace({ id, name: id, scope: BRANCH_SCOPE, firstPaneId });

/** A machine showing exactly this one workspace. A fixture, not a production
 * concept: the reducer used to export this to seed every machine's mandatory
 * first workspace, but a machine now legitimately starts (and ends) with zero. */
const initialMachineWorkspaces = (workspace: WorkspaceState): MachineWorkspacesState => ({
  workspaces: { [workspace.id]: workspace },
  order: [workspace.id],
  activeWorkspaceId: workspace.id,
});

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
    // The checkout lands on the WORKSPACE; the pane gets the narrow half.
    const pane = { name: 'claude-a1b2c3' };

    assert({
      given: 'a workspace created for an existing session',
      should: 'show that session immediately, rather than an empty pane the user must fill',
      actual: panesOf(
        newWorkspace({ id: 'ws-1', name: pane.name, scope: BRANCH_SCOPE, firstPaneId: 'pane-1', firstPaneScope: pane })
      ),
      expected: [{ id: 'pane-1', scope: pane }],
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

  it('given scopes that differ only by content kind, should resolve to the same workspace id', () => {
    assert({
      given: 'the same session scope tagged "chat", "terminal", and untagged',
      should: 'produce the identical workspace id — the content kind is not part of session identity',
      actual: new Set([
        sessionWorkspaceId({ projectName: 'app', branchName: 'main', name: 'claude-a1b2c3', kind: 'chat' }),
        sessionWorkspaceId({ projectName: 'app', branchName: 'main', name: 'claude-a1b2c3', kind: 'terminal' }),
        sessionWorkspaceId({ projectName: 'app', branchName: 'main', name: 'claude-a1b2c3' }),
      ]).size,
      expected: 1,
    });
  });

  it('given any scope, should never contain a NUL byte', () => {
    const id = sessionWorkspaceId({ projectName: 'app', branchName: 'main', name: 'claude-a1b2c3' });

    assert({
      given: 'a workspace id that is also the primary key of the server-side machine_workspaces row',
      should: 'contain no U+0000 — Postgres text columns reject a literal NUL byte outright',
      actual: id.includes('\u0000'),
      expected: false,
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
        // Stored NARROW: the checkout is the workspace's, never a second copy.
        pane1: { id: 'pane-1', scope: { name: scope.name }, pendingPrompt: 'fix the build' },
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
      actual: assignPane(state, 'closed-pane', { ...BRANCH_SCOPE, name: 'claude-a1b2c3' }),
      expected: state,
    });
  });
});

describe('assignPane — content kind round-trips on the bound scope (#2166 phase 9)', () => {
  it('given a scope carrying the content kind, should round-trip it onto the pane', () => {
    assert({
      given: 'assignPane with a scope tagged kind: "chat"',
      should: "round-trip the kind onto the pane's scope, unchanged",
      actual: panesOf(assignPane(aWorkspace(), 'pane-1', { ...BRANCH_SCOPE, name: 'claude-a1b2c3', kind: 'chat' }))[0].scope,
      expected: { name: 'claude-a1b2c3', kind: 'chat' },
    });
  });

  it('given an unknown pane id, should be a no-op even when the scope carries a content kind', () => {
    const state = aWorkspace();

    assert({
      given: 'a pane id that does not resolve, with a scope carrying a content kind',
      should: 'be a no-op, same as any other assignPane call',
      actual: assignPane(state, 'gone', { ...BRANCH_SCOPE, name: 'claude-a1b2c3', kind: 'chat' }),
      expected: state,
    });
  });
});

describe('clearPanePrompt', () => {
  it('given a prompt that has been typed into the PTY, should drop it', () => {
    const state = assignPane(aWorkspace(), 'pane-1', { ...BRANCH_SCOPE, name: 'claude-a1b2c3' }, 'fix the build');

    assert({
      given: 'a starting prompt already delivered to the agent',
      should: 'drop it — a pane that re-mounts must reattach, not retype the prompt at a running agent',
      actual: panesOf(clearPanePrompt(state, 'pane-1'))[0],
      expected: { id: 'pane-1', scope: { name: 'claude-a1b2c3' }, pendingPrompt: undefined },
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

describe('showSessionIn — a clicked session must actually be on screen', () => {
  const SESSION = { ...BRANCH_SCOPE, name: 'claude-a1b2c3' };

  it('given the session is already in a pane, should just focus that pane', () => {
    const workspace = assignPane(splitRight(aWorkspace(), 'pane-1', 'col-2', 'pane-2'), 'pane-1', SESSION);

    const actual = showSessionIn(workspace, SESSION, 'new-pane');

    assert({
      given: 'a session already showing in one pane of its workspace',
      should: 'focus that pane and add nothing — clicking its row twice must not open it twice',
      actual: { activePaneId: actual.activePaneId, panes: panesOf(actual).length },
      expected: { activePaneId: 'pane-1', panes: 2 },
    });
  });

  it('given the pane it was opened in was CLOSED, should put it back in an empty pane', () => {
    // The user opened the session, split, then closed the session's own pane.
    const workspace = closePane(
      assignPane(splitRight(aWorkspace(), 'pane-1', 'col-2', 'pane-2'), 'pane-1', SESSION),
      'pane-1'
    );

    const actual = showSessionIn(workspace, SESSION, 'new-pane');

    assert({
      given: 'a session whose pane the user closed, then clicked its sidebar row again',
      should:
        'show it again in the empty pane — merely re-selecting the workspace would leave the session unreachable from the sidebar while its PTY kept running, and billing',
      actual: panesOf(actual).find((pane) => pane.scope?.name === SESSION.name)?.id,
      expected: 'pane-2',
    });
  });

  it('given a workspace whose active pane is stale, should still put the session on screen', () => {
    const full = assignPane({ ...aWorkspace(), activePaneId: 'closed-long-ago' }, 'pane-1', { ...BRANCH_SCOPE, name: 'other' });

    const actual = showSessionIn(full, SESSION, 'new-pane');

    assert({
      given: 'a full workspace whose activePaneId names a pane that is gone',
      should: 'anchor the split on a pane that exists, so the session actually appears',
      actual: panesOf(actual).find((pane) => pane.scope?.name === SESSION.name)?.id,
      expected: 'new-pane',
    });
  });

  it('given every pane is full of other agents, should split a new pane for it', () => {
    const full = assignPane(
      assignPane(splitRight(aWorkspace(), 'pane-1', 'col-2', 'pane-2'), 'pane-1', { ...BRANCH_SCOPE, name: 'other-1' }),
      'pane-2',
      { ...BRANCH_SCOPE, name: 'other-2' }
    );

    const actual = showSessionIn(full, SESSION, 'new-pane');

    assert({
      given: 'a workspace whose panes all hold other agents',
      should: 'split a pane for the session rather than evict one of them',
      actual: {
        panes: panesOf(actual).length,
        session: panesOf(actual).find((pane) => pane.id === 'new-pane')?.scope,
        othersKept: panesOf(actual).filter((pane) => pane.scope?.name.startsWith('other')).length,
      },
      expected: { panes: 3, session: { name: SESSION.name }, othersKept: 2 },
    });
  });
});

describe('closePane on a lone pane — the grid level does not own this case', () => {
  it('given the only pane of a workspace, should be a no-op at the grid level', () => {
    const workspace = assignPane(aWorkspace(), 'pane-1', { ...BRANCH_SCOPE, name: 'claude-a1b2c3' }, 'a prompt');

    assert({
      given: "a workspace's ONLY pane",
      should:
        'be a no-op — removing it means removing the workspace, which a WorkspaceState transition cannot do to its own container (closePaneIn owns it)',
      actual: closePane(workspace, 'pane-1'),
      expected: workspace,
    });
  });
});

describe('closePaneIn', () => {
  it('given a pane with siblings, should close just that pane', () => {
    const machine = initialMachineWorkspaces(splitDown(aWorkspace(), 'pane-1', 'pane-2'));

    const actual = closePaneIn(machine, 'ws-1', 'pane-2');

    assert({
      given: 'one pane of a two-pane workspace',
      should: 'close the pane and keep the workspace',
      actual: {
        panes: panesOf(actual.workspaces['ws-1']!).map((pane) => pane.id),
        order: actual.order,
      },
      expected: { panes: ['pane-1'], order: ['ws-1'] },
    });
  });

  it('given the last pane, should remove the whole workspace', () => {
    const machine = addWorkspace(initialMachineWorkspaces(aWorkspace('ws-a', 'a1')), aWorkspace('ws-b', 'b1'));

    const actual = closePaneIn(machine, 'ws-b', 'b1');

    assert({
      given: "the last pane of a workspace — a view with no terminals left in it",
      should: 'remove the workspace itself, not leave an empty row behind',
      actual: { order: actual.order, active: actual.activeWorkspaceId },
      expected: { order: ['ws-a'], active: 'ws-a' },
    });
  });

  it("given the last pane of the machine's last workspace, should empty the machine", () => {
    const machine = initialMachineWorkspaces(aWorkspace());

    const actual = closePaneIn(machine, 'ws-1', 'pane-1');

    assert({
      given: 'the final pane of the final workspace',
      should: 'leave zero workspaces and nothing active — the empty state is a legal, reachable place',
      actual: { order: actual.order, active: actual.activeWorkspaceId },
      expected: { order: [], active: '' },
    });
  });

  it('given an unknown pane, should be a no-op', () => {
    const machine = initialMachineWorkspaces(aWorkspace());

    assert({
      given: 'a pane id that is not in the workspace',
      should: 'be a no-op — an unknown pane must not remove a workspace',
      actual: closePaneIn(machine, 'ws-1', 'nope'),
      expected: machine,
    });
  });
});

describe('removedWorkspaceBy', () => {
  it('given a close that removed the workspace, should report true', () => {
    const before = initialMachineWorkspaces(aWorkspace());
    const after = closePaneIn(before, 'ws-1', 'pane-1');

    assert({
      given: 'a close that took the whole workspace with it',
      should: 'report true — the sync layer must DELETE, since PATCHing a removed workspace 404s and its fallback re-creates the row',
      actual: removedWorkspaceBy(before, after, 'ws-1'),
      expected: true,
    });
  });

  it('given a close that only removed a pane, should report false', () => {
    const before = initialMachineWorkspaces(splitDown(aWorkspace(), 'pane-1', 'pane-2'));
    const after = closePaneIn(before, 'ws-1', 'pane-2');

    assert({
      given: 'a close that left the workspace standing',
      should: 'report false — this is an ordinary layout PATCH',
      actual: removedWorkspaceBy(before, after, 'ws-1'),
      expected: false,
    });
  });
});

describe('removeWorkspace', () => {
  it('given the active workspace is removed, should show its neighbour', () => {
    const machine = addWorkspace(
      addWorkspace(initialMachineWorkspaces(aWorkspace('ws-a', 'a1')), aWorkspace('ws-b', 'b1')),
      aWorkspace('ws-c', 'c1')
    );

    const actual = removeWorkspace(setActiveWorkspace(machine, 'ws-b'), 'ws-b');

    assert({
      given: 'the middle workspace of three, removed while it was on screen',
      should: 'drop it and show the one that took its place, rather than jumping across the sidebar',
      actual: { order: actual.order, active: actual.activeWorkspaceId },
      expected: { order: ['ws-a', 'ws-c'], active: 'ws-c' },
    });
  });

  it('given the last workspace, should remove it and leave the machine empty', () => {
    const machine = initialMachineWorkspaces(aWorkspace());

    const actual = removeWorkspace(machine, 'ws-1');

    assert({
      given: 'the only workspace a machine has',
      should:
        'remove it — a view you cannot destroy is not a view; the floor here is what made the last sidebar row unremovable',
      actual: { workspaces: Object.keys(actual.workspaces), order: actual.order, active: actual.activeWorkspaceId },
      expected: { workspaces: [], order: [], active: '' },
    });
  });

  it('given the last workspace, should set activeWorkspaceId to the empty string exactly', () => {
    const actual = removeWorkspace(initialMachineWorkspaces(aWorkspace()), 'ws-1');

    assert({
      given: 'a removal that empties the machine',
      should:
        "produce '' and not undefined — the neighbour lookup is order[-1] here, and undefined in a field typed string reads downstream as 'not mounted yet' rather than 'nothing active'",
      actual: actual.activeWorkspaceId === '',
      expected: true,
    });
  });

  it('given every workspace removed one at a time, should end empty without throwing', () => {
    const machine = addWorkspace(
      addWorkspace(initialMachineWorkspaces(aWorkspace('ws-a', 'a1')), aWorkspace('ws-b', 'b1')),
      aWorkspace('ws-c', 'c1')
    );

    const actual = ['ws-a', 'ws-b', 'ws-c'].reduce(removeWorkspace, machine);

    assert({
      given: 'three workspaces removed in sequence',
      should: 'end at zero with nothing active',
      actual: { order: actual.order, active: actual.activeWorkspaceId },
      expected: { order: [], active: '' },
    });
  });

  it('given an unknown workspace id, should be a no-op', () => {
    const machine = initialMachineWorkspaces(aWorkspace());

    assert({
      given: 'an id the machine does not have',
      should: 'be a no-op',
      actual: removeWorkspace(machine, 'nope'),
      expected: machine,
    });
  });
});

describe('renameWorkspace', () => {
  it('given a new name, should rename only that workspace', () => {
    const machine = addWorkspace(initialMachineWorkspaces(aWorkspace('ws-a', 'a1')), aWorkspace('ws-b', 'b1'));

    const renamed = renameWorkspace(machine, 'ws-b', 'Renamed');

    assert({
      given: 'a rename addressed to one workspace of two',
      should: 'change only its name, leaving the sibling and the rest of the grid untouched',
      actual: { a: renamed.workspaces['ws-a'].name, b: renamed.workspaces['ws-b'].name },
      expected: { a: 'ws-a', b: 'Renamed' },
    });
  });

  it('given an unknown workspace id, should be a no-op', () => {
    const machine = initialMachineWorkspaces(aWorkspace());

    assert({
      given: 'a rename addressed to a workspace that is gone',
      should: 'be a no-op rather than an error',
      actual: renameWorkspace(machine, 'ws-gone', 'Renamed'),
      expected: machine,
    });
  });
});

describe('mergeServerWorkspaces — reconciling the server\'s workspace list', () => {
  const serverWorkspace = (overrides: Partial<ServerWorkspaceDTO> = {}): ServerWorkspaceDTO => ({
    id: 'ws-1',
    name: 'Workspace 1',
    scope: BRANCH_SCOPE,
    columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }],
    ...overrides,
  });

  it('given an empty server list, should converge on zero rather than keep the local rows', () => {
    const local = initialMachineWorkspaces(aWorkspace());

    const merged = mergeServerWorkspaces(local, []);

    assert({
      given: 'a server that reports this machine has no workspaces (the user removed them all)',
      should:
        'apply it — returning `local` here (the old fallback) meant "server has zero" could NEVER converge, since this hydrate runs once per mount and nothing prunes afterwards',
      actual: { order: merged.order, active: merged.activeWorkspaceId },
      expected: { order: [], active: '' },
    });
  });

  it('given no local state, should build a fresh machine from the server list', () => {
    const merged = mergeServerWorkspaces(undefined, [serverWorkspace()]);

    assert({
      given: 'a browser with nothing local yet for this machine',
      should: 'adopt the server workspace, defaulting activePaneId to its first pane',
      actual: { order: merged.order, active: merged.activeWorkspaceId, activePane: merged.workspaces['ws-1'].activePaneId },
      expected: { order: ['ws-1'], active: 'ws-1', activePane: 'pane-1' },
    });
  });

  it('given a matching local workspace, should preserve its local-only fields, not the server\'s', () => {
    const local = initialMachineWorkspaces(
      splitRight(aWorkspace('ws-1', 'pane-1'), 'pane-1', 'col-2', 'pane-2')
    );
    const focused = { ...local, workspaces: { ...local.workspaces, 'ws-1': selectPane(local.workspaces['ws-1'], 'pane-2') } };

    // The server reports the SAME grid shape (both panes still exist).
    const merged = mergeServerWorkspaces(focused, [
      serverWorkspace({ columns: focused.workspaces['ws-1'].columns.map((c) => ({ id: c.id, panes: c.panes.map((p) => ({ id: p.id, scope: p.scope })) })) }),
    ]);

    assert({
      given: 'a server payload for a workspace this browser already has open, with a pane focused',
      should: 'keep the LOCAL activePaneId — focus is presence-like and never comes from the server',
      actual: merged.workspaces['ws-1'].activePaneId,
      expected: 'pane-2',
    });
  });

  it('given a surviving pane with a local pendingPrompt, should preserve it across the server\'s columns', () => {
    const local = initialMachineWorkspaces(assignPane(aWorkspace('ws-1', 'pane-1'), 'pane-1', { ...BRANCH_SCOPE, name: 'claude-a1' }, 'fix the build'));

    const merged = mergeServerWorkspaces(local, [
      serverWorkspace({ columns: [{ id: 'pane-1', panes: [{ id: 'pane-1', scope: { name: 'claude-a1' } }] }] }),
    ]);

    assert({
      given: 'an incoming layout for a pane that still exists locally with an undelivered starting prompt',
      should: 'keep the prompt — it has not been typed into its PTY yet, and the server never carries this field',
      actual: panesOf(merged.workspaces['ws-1'])[0].pendingPrompt,
      expected: 'fix the build',
    });
  });

  it('given a local-only workspace the server does not know about, should drop it — not merge unpublished history', () => {
    const local = addWorkspace(initialMachineWorkspaces(aWorkspace('ws-a', 'a1')), aWorkspace('ws-b', 'b1'));

    const merged = mergeServerWorkspaces(local, [serverWorkspace({ id: 'ws-a', columns: local.workspaces['ws-a'].columns })]);

    assert({
      given:
        'a server list that only includes one of this browser\'s two local workspaces (it lost the bootstrap race, or the machine was already bootstrapped by someone else)',
      should:
        'adopt ONLY the server\'s list — a local-only straggler is either a disposable ensureMachine placeholder or unmigrated history, and keeping it would leave a permanent phantom workspace nothing ever prunes',
      actual: merged.order,
      expected: ['ws-a'],
    });
  });
});

describe('mergeServerWorkspaces — round-trips the content kind (#2166 phase 9)', () => {
  it('given a server workspace whose pane scope carries the content kind, should round-trip it', () => {
    const merged = mergeServerWorkspaces(undefined, [
      {
        id: 'ws-1',
        name: 'Workspace 1',
        scope: {},
        columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: { name: 'claude-a1', kind: 'chat' } }] }],
      },
    ]);

    assert({
      given: 'a server payload whose pane scope is tagged kind: "chat"',
      should: 'round-trip the tag into local state — server isValidLayout is lenient, so this is not stripped in transit',
      actual: panesOf(merged.workspaces['ws-1'])[0].scope,
      expected: { name: 'claude-a1', kind: 'chat' },
    });
  });

  it("given a surviving pane with a local pendingPrompt, should preserve both the prompt and the server's content kind", () => {
    const local = initialMachineWorkspaces(
      assignPane(aWorkspace('ws-1', 'pane-1'), 'pane-1', { ...BRANCH_SCOPE, name: 'claude-a1' }, 'fix the build')
    );

    const merged = mergeServerWorkspaces(local, [
      {
        id: 'ws-1',
        name: 'ws-1',
        scope: BRANCH_SCOPE,
        columns: [{ id: 'pane-1', panes: [{ id: 'pane-1', scope: { name: 'claude-a1', kind: 'chat' } }] }],
      },
    ]);

    assert({
      given: 'an incoming layout for a pane that survives locally with an undelivered prompt, whose server scope now carries a content kind',
      should: 'keep the local pendingPrompt AND adopt the server content kind together — same merge, two fields',
      actual: panesOf(merged.workspaces['ws-1'])[0],
      expected: { id: 'pane-1', scope: { name: 'claude-a1', kind: 'chat' }, pendingPrompt: 'fix the build' },
    });
  });
});

describe('applyServerWorkspaceUpsert', () => {
  it('given a brand-new workspace id, should add it to the end of order', () => {
    const machine = initialMachineWorkspaces(aWorkspace('ws-a', 'a1'));

    const applied = applyServerWorkspaceUpsert(machine, {
      id: 'ws-b',
      name: 'Workspace 2',
      scope: {},
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }],
    });

    assert({
      given: 'a machine-workspace:created event for a workspace this browser has never seen',
      should: 'append it to order and make it renderable',
      actual: { order: applied.order, name: applied.workspaces['ws-b'].name },
      expected: { order: ['ws-a', 'ws-b'], name: 'Workspace 2' },
    });
  });

  it('given an existing workspace id, should update it in place without touching order', () => {
    const machine = addWorkspace(initialMachineWorkspaces(aWorkspace('ws-a', 'a1')), aWorkspace('ws-b', 'b1'));

    const applied = applyServerWorkspaceUpsert(machine, {
      id: 'ws-a',
      name: 'Renamed elsewhere',
      scope: BRANCH_SCOPE,
      columns: machine.workspaces['ws-a'].columns,
    });

    assert({
      given: 'a machine-workspace:updated event (a rename from another browser) for a known workspace',
      should: 'update its name in place — order is unchanged, this workspace already had a slot',
      actual: { order: applied.order, name: applied.workspaces['ws-a'].name },
      expected: { order: ['ws-a', 'ws-b'], name: 'Renamed elsewhere' },
    });
  });
});

describe('applyServerWorkspaceDeleted', () => {
  it('given an incoming delete for a known workspace, should remove it and show a neighbour', () => {
    const machine = addWorkspace(initialMachineWorkspaces(aWorkspace('ws-a', 'a1')), aWorkspace('ws-b', 'b1'));

    const applied = applyServerWorkspaceDeleted(setActiveWorkspace(machine, 'ws-b'), 'ws-b');

    assert({
      given: 'a machine-workspace:deleted event for the workspace currently on screen',
      should: 'drop it and show its neighbour — same behaviour as a local removeWorkspace',
      actual: { order: applied.order, active: applied.activeWorkspaceId },
      expected: { order: ['ws-a'], active: 'ws-a' },
    });
  });

  it("given the machine's only workspace, should apply the delete", () => {
    const machine = initialMachineWorkspaces(aWorkspace());

    const applied = applyServerWorkspaceDeleted(machine, 'ws-1');

    assert({
      given: 'a delete event for the last workspace this browser has locally',
      should:
        'apply it — the old floor DROPPED this event, so a browser whose teammate removed the last view kept a phantom of it forever (nothing re-reconciles after the once-per-mount hydrate)',
      actual: { order: applied.order, active: applied.activeWorkspaceId },
      expected: { order: [], active: '' },
    });
  });
});

describe('sanitizeMachines — what comes back from storage is untrusted', () => {
  it('given a persisted machine with zero workspaces, should drop the entry', () => {
    const actual = sanitizeMachines({ m1: { workspaces: {}, order: [], activeWorkspaceId: '' } });

    assert({
      given: 'an empty machine coming back out of localStorage',
      should:
        'drop the entry — ensureMachine re-adds it on mount, so this is equivalent to keeping it, and the UI must therefore key its empty state on "no active workspace resolves" rather than on the entry existing',
      actual: Object.keys(actual),
      expected: [],
    });
  });

  it('given a workspace from an older, incompatible shape, should drop it rather than crash on render', () => {
    const persisted = {
      m1: {
        workspaces: {
          good: aWorkspace('good', 'p1'),
          // Written by a previous version: no `columns` at all. Rendering this
          // throws (columns.flatMap of undefined), and a throw here means a
          // Machine page the user can never open again.
          stale: { id: 'stale', name: 'old', scope: {}, activePaneId: 'x' },
        },
        order: ['good', 'stale'],
        activeWorkspaceId: 'stale',
      },
    };

    const actual = sanitizeMachines(persisted);

    assert({
      given: 'a persisted blob holding one renderable workspace and one from an incompatible older shape',
      should: 'keep what it can render, drop what it cannot, and re-point the active id at a workspace that exists',
      actual: {
        workspaces: Object.keys(actual.m1.workspaces),
        order: actual.m1.order,
        active: actual.m1.activeWorkspaceId,
      },
      expected: { workspaces: ['good'], order: ['good'], active: 'good' },
    });
  });

  it('given a workspace id persisted with the legacy NUL delimiter, should migrate it to the current one', () => {
    const legacyId = 'session repo main claude-a1';
    const currentId = 'sessionrepomainclaude-a1';
    const persisted = {
      m1: {
        workspaces: { [legacyId]: aWorkspace(legacyId, 'p1') },
        order: [legacyId],
        activeWorkspaceId: legacyId,
      },
    };

    const actual = sanitizeMachines(persisted);

    assert({
      given: "a session-derived workspace id persisted by a version of this app that predates the U+001F delimiter switch (it used NUL, which Postgres text columns reject outright)",
      should: 'migrate the id everywhere it appears — the record key, the workspace\'s own id field, order, and activeWorkspaceId — so a bootstrap POST of this browser\'s local history never sends a doomed id to the server',
      actual: {
        keys: Object.keys(actual.m1.workspaces),
        ownId: actual.m1.workspaces[currentId]?.id,
        order: actual.m1.order,
        active: actual.m1.activeWorkspaceId,
      },
      expected: { keys: [currentId], ownId: currentId, order: [currentId], active: currentId },
    });
  });

  it('given transient UI state in storage, should strip it', () => {
    const withTransient = {
      m1: {
        workspaces: {
          'ws-1': {
            ...assignPane(aWorkspace(), 'pane-1', { ...BRANCH_SCOPE, name: 'claude-a1' }, 'fix the build'),
            pendingPickerPaneId: 'pane-1',
          },
        },
        order: ['ws-1'],
        activeWorkspaceId: 'ws-1',
      },
    };

    const actual = sanitizeMachines(withTransient).m1.workspaces['ws-1'];

    assert({
      given: 'a picker focus intent and an undelivered starting prompt, both written to storage',
      should:
        'strip both — a picker must not steal the caret on page load, and a prompt from a boot that already happened must never be typed at an agent that has been running ever since',
      actual: { picker: actual.pendingPickerPaneId, prompt: panesOf(actual)[0].pendingPrompt },
      expected: { picker: null, prompt: undefined },
    });
  });

  it('given garbage, should yield an empty map rather than throw', () => {
    assert({
      given: 'a corrupt or absent storage blob',
      should: 'come back empty, so the store rebuilds from scratch instead of exploding at import time',
      actual: [sanitizeMachines(undefined), sanitizeMachines('nonsense'), sanitizeMachines({ m1: 7 })],
      expected: [{}, {}, {}],
    });
  });

  it('given a stored activePaneId that names no pane, should re-point it at one that exists', () => {
    const persisted = {
      m1: {
        workspaces: { 'ws-1': { ...aWorkspace(), activePaneId: 'pane-that-was-closed' } },
        order: ['ws-1'],
        activeWorkspaceId: 'ws-1',
      },
    };

    assert({
      given: 'a workspace whose active pane no longer exists',
      should:
        'point active at a real pane — every grid transition no-ops on a pane it cannot resolve, so a split anchored on a phantom would silently do nothing',
      actual: sanitizeMachines(persisted).m1.workspaces['ws-1'].activePaneId,
      expected: 'pane-1',
    });
  });

  it('given a persisted pane scope carrying the content kind, should preserve it (#2166 phase 9)', () => {
    const persisted = {
      m1: {
        workspaces: {
          'ws-1': {
            id: 'ws-1',
            name: 'ws-1',
            scope: {},
            columns: [{ id: 'pane-1', panes: [{ id: 'pane-1', scope: { name: 'claude-a1', kind: 'chat' } }] }],
            activePaneId: 'pane-1',
          },
        },
        order: ['ws-1'],
        activeWorkspaceId: 'ws-1',
      },
    };

    const actual = sanitizeMachines(persisted).m1.workspaces['ws-1'];

    assert({
      given: 'a rehydrated pane whose scope carries kind: "chat"',
      should: 'preserve the content kind on the way through, not strip it as an unrecognized field',
      actual: panesOf(actual)[0].scope,
      expected: { name: 'claude-a1', kind: 'chat' },
    });
  });

  it('given a persisted activePaneId that does not resolve, should still repoint it while preserving the content kind on surviving panes', () => {
    const persisted = {
      m1: {
        workspaces: {
          'ws-1': {
            id: 'ws-1',
            name: 'ws-1',
            scope: {},
            columns: [{ id: 'pane-1', panes: [{ id: 'pane-1', scope: { name: 'claude-a1', kind: 'chat' } }] }],
            activePaneId: 'pane-that-was-closed',
          },
        },
        order: ['ws-1'],
        activeWorkspaceId: 'ws-1',
      },
    };

    const actual = sanitizeMachines(persisted).m1.workspaces['ws-1'];

    assert({
      given: 'an activePaneId that no longer resolves, on a workspace whose surviving pane carries a content kind',
      should:
        'repoint active at the real pane and keep the content kind intact — same no-op-on-unknown-id contract as every other transition here',
      actual: { activePaneId: actual.activePaneId, scope: panesOf(actual)[0].scope },
      expected: { activePaneId: 'pane-1', scope: { name: 'claude-a1', kind: 'chat' } },
    });
  });
});

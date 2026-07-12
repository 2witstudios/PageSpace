import { describe, it, expect, beforeEach } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import {
  useMachineWorkspaceStore,
  selectWorkspace,
  selectActiveNode,
  selectNodeWorkspace,
  type WorkspaceState,
} from '../useMachineWorkspaceStore';

const reset = () => useMachineWorkspaceStore.setState({ workspaces: {}, activeNodes: {} });

const store = () => useMachineWorkspaceStore.getState();

const MACHINE_NODE = {};
const BRANCH_NODE = { projectName: 'app', branchName: 'main' };
const OTHER_BRANCH = { projectName: 'app', branchName: 'fix' };

function allPanes(workspace: WorkspaceState | undefined) {
  return workspace?.columns.flatMap((column) => column.panes) ?? [];
}

describe('useMachineWorkspaceStore', () => {
  beforeEach(() => {
    reset();
  });

  it('given a fresh store, should have no workspaces', () => {
    const actual = useMachineWorkspaceStore.getState().workspaces;

    expect({
      given: 'a fresh store',
      should: 'have no workspaces',
      actual,
      expected: {},
    }).toEqual({
      given: 'a fresh store',
      should: 'have no workspaces',
      actual: {},
      expected: {},
    });
  });

  it('given ensureWorkspace is called for a new machineId, should create a single-pane workspace', () => {
    useMachineWorkspaceStore.getState().ensureWorkspace('terminal-1');

    const workspace = selectWorkspace('terminal-1')(useMachineWorkspaceStore.getState());

    expect({
      given: 'ensureWorkspace is called for a new machineId',
      should: 'create a single-pane workspace',
      actual: allPanes(workspace).length,
      expected: 1,
    }).toEqual({
      given: 'ensureWorkspace is called for a new machineId',
      should: 'create a single-pane workspace',
      actual: 1,
      expected: 1,
    });
  });

  it('given ensureWorkspace is called twice, should not replace the existing workspace', () => {
    useMachineWorkspaceStore.getState().ensureWorkspace('terminal-1');
    const first = selectWorkspace('terminal-1')(useMachineWorkspaceStore.getState());

    useMachineWorkspaceStore.getState().ensureWorkspace('terminal-1');
    const second = selectWorkspace('terminal-1')(useMachineWorkspaceStore.getState());

    expect({
      given: 'ensureWorkspace is called twice',
      should: 'not replace the existing workspace',
      actual: second,
      expected: first,
    }).toEqual({
      given: 'ensureWorkspace is called twice',
      should: 'not replace the existing workspace',
      actual: first,
      expected: first,
    });
  });

  it('given disposeWorkspace is called, should remove the workspace entry', () => {
    useMachineWorkspaceStore.getState().ensureWorkspace('terminal-1');
    useMachineWorkspaceStore.getState().disposeWorkspace('terminal-1');

    const workspace = selectWorkspace('terminal-1')(useMachineWorkspaceStore.getState());

    expect({
      given: 'disposeWorkspace is called',
      should: 'remove the workspace entry',
      actual: workspace,
      expected: undefined,
    }).toEqual({
      given: 'disposeWorkspace is called',
      should: 'remove the workspace entry',
      actual: undefined,
      expected: undefined,
    });
  });

  it('given two ensured workspaces, should keep them independent', () => {
    useMachineWorkspaceStore.getState().ensureWorkspace('terminal-1');
    useMachineWorkspaceStore.getState().ensureWorkspace('terminal-2');
    useMachineWorkspaceStore.getState().openTerminal('terminal-1', { name: 'only-in-1' });

    const state = useMachineWorkspaceStore.getState();
    const workspace1 = selectWorkspace('terminal-1')(state);
    const workspace2 = selectWorkspace('terminal-2')(state);

    expect({
      given: 'two ensured workspaces',
      should: 'keep them independent',
      actual: { w1Scope: allPanes(workspace1)[0].scope, w2Scope: allPanes(workspace2)[0].scope },
      expected: { w1Scope: { name: 'only-in-1' }, w2Scope: null },
    }).toEqual({
      given: 'two ensured workspaces',
      should: 'keep them independent',
      actual: { w1Scope: { name: 'only-in-1' }, w2Scope: null },
      expected: { w1Scope: { name: 'only-in-1' }, w2Scope: null },
    });
  });

  it('given openTerminal, should write the scope into the active pane', () => {
    useMachineWorkspaceStore.getState().ensureWorkspace('terminal-1');
    useMachineWorkspaceStore.getState().openTerminal('terminal-1', { name: 'my-terminal' });

    const workspace = selectWorkspace('terminal-1')(useMachineWorkspaceStore.getState());

    expect({
      given: 'openTerminal',
      should: 'write the scope into the active pane',
      actual: allPanes(workspace).find((p) => p.id === workspace?.activePaneId)?.scope,
      expected: { name: 'my-terminal' },
    }).toEqual({
      given: 'openTerminal',
      should: 'write the scope into the active pane',
      actual: { name: 'my-terminal' },
      expected: { name: 'my-terminal' },
    });
  });

  it('given splitRight, should add a second column and activate its pane', () => {
    useMachineWorkspaceStore.getState().ensureWorkspace('terminal-1');
    const before = selectWorkspace('terminal-1')(useMachineWorkspaceStore.getState());
    useMachineWorkspaceStore.getState().splitRight('terminal-1', MACHINE_NODE, before!.activePaneId);

    const workspace = selectWorkspace('terminal-1')(useMachineWorkspaceStore.getState());

    expect({
      given: 'splitRight',
      should: 'add a second column and activate its pane',
      actual: { columnCount: workspace?.columns.length, activeIsNewPane: workspace?.activePaneId !== before?.activePaneId },
      expected: { columnCount: 2, activeIsNewPane: true },
    }).toEqual({
      given: 'splitRight',
      should: 'add a second column and activate its pane',
      actual: { columnCount: 2, activeIsNewPane: true },
      expected: { columnCount: 2, activeIsNewPane: true },
    });
  });

  it('given splitDown, should stack a new pane in the same column', () => {
    useMachineWorkspaceStore.getState().ensureWorkspace('terminal-1');
    const before = selectWorkspace('terminal-1')(useMachineWorkspaceStore.getState());
    useMachineWorkspaceStore.getState().splitDown('terminal-1', MACHINE_NODE, before!.activePaneId);

    const workspace = selectWorkspace('terminal-1')(useMachineWorkspaceStore.getState());

    expect({
      given: 'splitDown',
      should: 'stack a new pane in the same column',
      actual: { columnCount: workspace?.columns.length, paneCountInColumn: workspace?.columns[0]?.panes.length },
      expected: { columnCount: 1, paneCountInColumn: 2 },
    }).toEqual({
      given: 'splitDown',
      should: 'stack a new pane in the same column',
      actual: { columnCount: 1, paneCountInColumn: 2 },
      expected: { columnCount: 1, paneCountInColumn: 2 },
    });
  });

  it('given closePane on the last pane, should be a no-op', () => {
    useMachineWorkspaceStore.getState().ensureWorkspace('terminal-1');
    const before = selectWorkspace('terminal-1')(useMachineWorkspaceStore.getState());

    useMachineWorkspaceStore.getState().closePane('terminal-1', MACHINE_NODE, allPanes(before)[0].id);
    const after = selectWorkspace('terminal-1')(useMachineWorkspaceStore.getState());

    expect({
      given: 'closePane on the last pane',
      should: 'be a no-op',
      actual: after,
      expected: before,
    }).toEqual({
      given: 'closePane on the last pane',
      should: 'be a no-op',
      actual: before,
      expected: before,
    });
  });

  it('given selectPane, should activate the chosen pane', () => {
    useMachineWorkspaceStore.getState().ensureWorkspace('terminal-1');
    const before = selectWorkspace('terminal-1')(useMachineWorkspaceStore.getState());
    useMachineWorkspaceStore.getState().splitRight('terminal-1', MACHINE_NODE, before!.activePaneId);

    const workspace = selectWorkspace('terminal-1')(useMachineWorkspaceStore.getState());
    const firstPaneId = allPanes(workspace)[0].id;
    useMachineWorkspaceStore.getState().selectPane('terminal-1', MACHINE_NODE, firstPaneId);

    const after = selectWorkspace('terminal-1')(useMachineWorkspaceStore.getState());

    expect({
      given: 'selectPane',
      should: 'activate the chosen pane',
      actual: after?.activePaneId,
      expected: firstPaneId,
    }).toEqual({
      given: 'selectPane',
      should: 'activate the chosen pane',
      actual: firstPaneId,
      expected: firstPaneId,
    });
  });

  it('given pane actions on a machineId that was never ensured, should be a no-op', () => {
    store().splitRight('never-ensured', MACHINE_NODE, 'anything');
    store().splitDown('never-ensured', MACHINE_NODE, 'anything');
    store().closePane('never-ensured', MACHINE_NODE, 'anything');
    store().selectPane('never-ensured', MACHINE_NODE, 'anything');

    assert({
      given: 'pane actions naming a machineId with no workspace (never ensured, or already disposed)',
      should: 'be a no-op — a stale click racing an unmount must not resurrect a grid',
      actual: selectWorkspace('never-ensured')(store()),
      expected: undefined,
    });
  });

  it('given openTerminal on a node with no grid yet, should create that node grid on demand', () => {
    store().openTerminal('m1', { projectName: 'app', branchName: 'main', name: 'claude-a1b2c3' });

    const workspace = selectWorkspace('m1')(store());
    assert({
      given: 'a session opened under a node the user has never visited (so it owns no grid yet)',
      should: 'create that node grid and open the session in it — the alternative is a click that silently does nothing',
      actual: allPanes(workspace)[0]?.scope,
      expected: { projectName: 'app', branchName: 'main', name: 'claude-a1b2c3' },
    });
  });

  it('given a node is selected, should give it its own grid and leave the machine grid alone', () => {
    store().ensureWorkspace('m1');
    const machineFirstPane = allPanes(selectWorkspace('m1')(store()))[0].id;
    store().splitRight('m1', MACHINE_NODE, machineFirstPane);

    store().selectNode('m1', BRANCH_NODE);

    assert({
      given: 'a branch node selected after the machine node was split in two',
      should: 'show the branch its OWN fresh single-pane grid — a node is a workspace, not a view of one shared grid',
      actual: {
        onScreenPanes: allPanes(selectWorkspace('m1')(store())).length,
        machineNodePanes: allPanes(selectNodeWorkspace('m1', {})(store())).length,
        activeNode: selectActiveNode('m1')(store()),
      },
      expected: { onScreenPanes: 1, machineNodePanes: 2, activeNode: BRANCH_NODE },
    });
  });

  it('given a node is re-selected, should restore the grid it had, not a fresh one', () => {
    store().ensureWorkspace('m1');
    store().selectNode('m1', BRANCH_NODE);
    store().splitDown('m1', BRANCH_NODE, selectWorkspace('m1')(store())!.activePaneId);
    store().selectNode('m1', OTHER_BRANCH);

    store().selectNode('m1', BRANCH_NODE);

    assert({
      given: 'a branch re-selected after visiting another branch (reattach: its PTYs survive the reap window)',
      should: 'restore its pane grid — the panes come back and reattach, rather than the user losing their layout',
      actual: allPanes(selectWorkspace('m1')(store())).length,
      expected: 2,
    });
  });

  it('given a split on one node, should not touch a sibling node grid', () => {
    store().ensureWorkspace('m1');
    store().selectNode('m1', BRANCH_NODE);
    store().splitRight('m1', BRANCH_NODE, selectWorkspace('m1')(store())!.activePaneId);

    assert({
      given: 'a split performed while a branch node is active',
      should: 'land in that branch grid only — sibling nodes each keep their own layout',
      actual: {
        branch: allPanes(selectNodeWorkspace('m1', BRANCH_NODE)(store())).length,
        otherBranch: selectNodeWorkspace('m1', OTHER_BRANCH)(store()),
      },
      expected: { branch: 2, otherBranch: undefined },
    });
  });

  it('given openTerminal for a session under another node, should switch to that node and open it there', () => {
    store().ensureWorkspace('m1');

    store().openTerminal('m1', { ...BRANCH_NODE, name: 'claude-a1b2c3' });

    const workspace = selectWorkspace('m1')(store());
    assert({
      given: "a session opened from the sidebar that belongs to a branch other than the node on screen",
      should: 'switch to that branch grid and open the session there — never into a grid whose checkout it does not run in',
      actual: {
        activeNode: selectActiveNode('m1')(store()),
        scope: allPanes(workspace).find((pane) => pane.id === workspace?.activePaneId)?.scope,
        machineNodeUntouched: allPanes(selectNodeWorkspace('m1', {})(store()))[0].scope,
      },
      expected: {
        activeNode: BRANCH_NODE,
        scope: { ...BRANCH_NODE, name: 'claude-a1b2c3' },
        machineNodeUntouched: null,
      },
    });
  });

  it('given bindPaneTerminal, should bind the session and its starting prompt to that exact pane', () => {
    store().ensureWorkspace('m1');
    store().selectNode('m1', BRANCH_NODE);
    const paneId = selectWorkspace('m1')(store())!.activePaneId;
    store().splitRight('m1', BRANCH_NODE, paneId);

    store().bindPaneTerminal('m1', paneId, { ...BRANCH_NODE, name: 'claude-a1b2c3' }, 'fix the build');

    const pane = allPanes(selectWorkspace('m1')(store())).find((p) => p.id === paneId);
    assert({
      given: 'an agent picked in the first pane, resolving after a split moved focus to the new pane',
      should: 'bind it (and its starting prompt) to the pane it was picked in, and focus that pane',
      actual: { scope: pane?.scope, pendingPrompt: pane?.pendingPrompt, active: selectWorkspace('m1')(store())?.activePaneId === paneId },
      expected: { scope: { ...BRANCH_NODE, name: 'claude-a1b2c3' }, pendingPrompt: 'fix the build', active: true },
    });
  });

  it('given disposeWorkspace, should drop EVERY node grid of that machine', () => {
    store().ensureWorkspace('m1');
    store().selectNode('m1', BRANCH_NODE);
    store().ensureWorkspace('m2');

    store().disposeWorkspace('m1');

    assert({
      given: 'the Machine page unmounting after several nodes were visited',
      should: 'drop every one of its node grids (a per-node leak would be silently inherited by the next mount) and leave other machines alone',
      actual: {
        m1Keys: Object.keys(store().workspaces).filter((key) => key.startsWith('m1')).length,
        m1ActiveNode: store().activeNodes['m1'],
        m2: allPanes(selectWorkspace('m2')(store())).length,
      },
      expected: { m1Keys: 0, m1ActiveNode: undefined, m2: 1 },
    });
  });

  it('given the user opens another node while a spawn is in flight, should still bind to the pane it was picked in', () => {
    store().ensureWorkspace('m1');
    store().selectNode('m1', BRANCH_NODE);
    const paneId = selectWorkspace('m1')(store())!.activePaneId;

    // The spawn is in flight (a cold Sprite boot is seconds) and the user goes
    // and looks at another branch. THEN the spawn resolves.
    store().selectNode('m1', OTHER_BRANCH);
    store().bindPaneTerminal('m1', paneId, { ...BRANCH_NODE, name: 'claude-a1b2c3' }, 'fix the build');

    const pane = allPanes(selectNodeWorkspace('m1', BRANCH_NODE)(store())).find((p) => p.id === paneId);
    assert({
      given: 'a spawn that resolves after the user has switched to a different node',
      should:
        "bind it to the pane it was picked in, in ITS OWN node's grid — resolving the target against whatever is active at write time would drop the write, orphaning the session row and leaving the picked pane empty",
      actual: {
        boundScope: pane?.scope,
        boundPrompt: pane?.pendingPrompt,
        otherBranchUntouched: allPanes(selectNodeWorkspace('m1', OTHER_BRANCH)(store()))[0].scope,
      },
      expected: {
        boundScope: { ...BRANCH_NODE, name: 'claude-a1b2c3' },
        boundPrompt: 'fix the build',
        otherBranchUntouched: null,
      },
    });
  });

  it('given a pane action naming a node that is not the active one, should still apply to that node', () => {
    store().ensureWorkspace('m1');
    store().selectNode('m1', BRANCH_NODE);
    const paneId = selectWorkspace('m1')(store())!.activePaneId;
    store().selectNode('m1', OTHER_BRANCH);

    // e.g. an `agent-terminal:ready` arriving for a pane whose node the user has left.
    store().bindPaneTerminal('m1', paneId, { ...BRANCH_NODE, name: 'claude-a1b2c3' }, 'go');
    store().clearPanePrompt('m1', BRANCH_NODE, paneId);

    assert({
      given: 'a prompt delivered to a pane in a node the user has since navigated away from',
      should: 'clear it in THAT node grid — a pane id only means anything within its own node',
      actual: allPanes(selectNodeWorkspace('m1', BRANCH_NODE)(store())).find((p) => p.id === paneId)?.pendingPrompt,
      expected: undefined,
    });
  });
});

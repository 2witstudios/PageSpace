import { describe, it, expect, beforeEach } from 'vitest';
import { useMachineWorkspaceStore, selectWorkspace, type WorkspaceState } from '../useMachineWorkspaceStore';

const reset = () => useMachineWorkspaceStore.setState({ workspaces: {} });

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
    useMachineWorkspaceStore.getState().splitRight('terminal-1', before!.activePaneId);

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
    useMachineWorkspaceStore.getState().splitDown('terminal-1', before!.activePaneId);

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

    useMachineWorkspaceStore.getState().closePane('terminal-1', allPanes(before)[0].id);
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
    useMachineWorkspaceStore.getState().splitRight('terminal-1', before!.activePaneId);

    const workspace = selectWorkspace('terminal-1')(useMachineWorkspaceStore.getState());
    const firstPaneId = allPanes(workspace)[0].id;
    useMachineWorkspaceStore.getState().selectPane('terminal-1', firstPaneId);

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

  it('given actions on a machineId that was never ensured, should be a no-op', () => {
    useMachineWorkspaceStore.getState().openTerminal('never-ensured', { name: 'ghost' });
    useMachineWorkspaceStore.getState().splitRight('never-ensured', 'anything');
    useMachineWorkspaceStore.getState().splitDown('never-ensured', 'anything');
    useMachineWorkspaceStore.getState().closePane('never-ensured', 'anything');
    useMachineWorkspaceStore.getState().selectPane('never-ensured', 'anything');

    const workspace = selectWorkspace('never-ensured')(useMachineWorkspaceStore.getState());

    expect({
      given: 'actions on a machineId that was never ensured',
      should: 'be a no-op',
      actual: workspace,
      expected: undefined,
    }).toEqual({
      given: 'actions on a machineId that was never ensured',
      should: 'be a no-op',
      actual: undefined,
      expected: undefined,
    });
  });
});

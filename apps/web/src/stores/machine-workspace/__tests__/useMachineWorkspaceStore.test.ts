import { describe, it, beforeEach } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import {
  useMachineWorkspaceStore,
  selectActiveWorkspace,
  selectMachine,
  selectWorkspace,
  panesOf,
  type WorkspaceState,
} from '../useMachineWorkspaceStore';
import { workspacesOf, sessionWorkspaceId } from '../workspace-reducer';

const store = () => useMachineWorkspaceStore.getState();
const activeOf = (machineId: string) => selectActiveWorkspace(machineId)(store());
const paneIds = (workspace: WorkspaceState | undefined) => (workspace ? panesOf(workspace).map((pane) => pane.id) : []);

const BRANCH_SCOPE = { projectName: 'app', branchName: 'main' };
const SESSION = { ...BRANCH_SCOPE, name: 'claude-a1b2c3' };

describe('useMachineWorkspaceStore', () => {
  beforeEach(() => {
    useMachineWorkspaceStore.setState({ machines: {} });
  });

  it('given a machine is ensured, should give it one workspace, active, holding one empty pane', () => {
    store().ensureMachine('m1');

    assert({
      given: 'a Machine page mounting for the first time',
      should: 'open one auto-named workspace with a single empty pane — which is the agent picker',
      actual: {
        workspaces: workspacesOf(selectMachine('m1')(store())).length,
        name: activeOf('m1')?.name,
        panes: paneIds(activeOf('m1')).length,
        emptyPane: activeOf('m1')?.columns[0].panes[0].scope,
      },
      expected: { workspaces: 1, name: 'Workspace 1', panes: 1, emptyPane: null },
    });
  });

  it('given ensureMachine twice, should not reset the workspaces it already has', () => {
    store().ensureMachine('m1');
    store().splitRight('m1', activeOf('m1')!.id, activeOf('m1')!.activePaneId);
    const before = activeOf('m1');

    store().ensureMachine('m1');

    assert({
      given: 'a Machine page re-mounting (a tab switch, a re-render) over a workspace already split in two',
      should: 'leave it exactly as it was — re-ensuring must never wipe running agents off the screen',
      actual: activeOf('m1'),
      expected: before,
    });
  });

  // ---------------------------------------------------------------------
  // THE FIX: selecting a workspace switches the entire middle view.
  // ---------------------------------------------------------------------

  it('given a second workspace is selected, should switch the WHOLE middle view to its grid', () => {
    store().ensureMachine('m1');
    const first = activeOf('m1')!;
    // Give the first workspace a two-pane split, so the two grids differ.
    store().splitRight('m1', first.id, first.activePaneId);
    const firstPanes = paneIds(selectWorkspace('m1', first.id)(store()));

    store().createWorkspace('m1');
    const showingSecond = paneIds(activeOf('m1'));

    store().setActiveWorkspace('m1', first.id);
    const backToFirst = paneIds(activeOf('m1'));

    assert({
      given: 'workspace 1 holding a two-pane split, and a newly created workspace 2',
      should:
        'render exactly the selected workspace’s grid, switching the whole combination of panes on selection — the bug this fixes was one shared grid per machine that never switched',
      actual: {
        secondIsFresh: showingSecond.length,
        secondIsNotFirst: showingSecond[0] !== firstPanes[0],
        backToFirst,
        activeId: activeOf('m1')?.id,
      },
      expected: {
        secondIsFresh: 1,
        secondIsNotFirst: true,
        backToFirst: firstPanes,
        activeId: first.id,
      },
    });
  });

  it('given a split, should add the pane to the ACTIVE workspace only', () => {
    store().ensureMachine('m1');
    const firstId = activeOf('m1')!.id;
    const secondId = store().createWorkspace('m1');

    store().splitDown('m1', secondId, activeOf('m1')!.activePaneId);

    assert({
      given: 'a split performed while workspace 2 is on screen',
      should: 'grow workspace 2 and leave workspace 1 alone — a workspace owns its own pane combination',
      actual: {
        second: paneIds(selectWorkspace('m1', secondId)(store())).length,
        first: paneIds(selectWorkspace('m1', firstId)(store())).length,
      },
      expected: { second: 2, first: 1 },
    });
  });

  it('given two machines, should keep their workspaces independent', () => {
    store().ensureMachine('m1');
    store().ensureMachine('m2');
    store().createWorkspace('m1');

    assert({
      given: 'two Machine pages open at once',
      should: 'keep each machine’s workspaces to itself',
      actual: {
        m1: workspacesOf(selectMachine('m1')(store())).length,
        m2: workspacesOf(selectMachine('m2')(store())).length,
      },
      expected: { m1: 2, m2: 1 },
    });
  });

  // ---------------------------------------------------------------------
  // Opening an existing session (the sidebar's session rows — kept working).
  // ---------------------------------------------------------------------

  it('given an existing session is opened, should switch the view to that session’s own workspace', () => {
    store().ensureMachine('m1');
    const firstId = activeOf('m1')!.id;

    store().openTerminal('m1', SESSION);

    assert({
      given: 'a session row clicked in the sidebar',
      should: 'open ITS workspace — with the session already running in its first pane — and show it, instead of overwriting a pane of whatever grid was up',
      actual: {
        active: activeOf('m1')?.id,
        isOwnWorkspace: activeOf('m1')?.id !== firstId,
        scope: activeOf('m1')?.columns[0].panes[0].scope,
        name: activeOf('m1')?.name,
        workspaceScope: activeOf('m1')?.scope,
      },
      expected: {
        active: sessionWorkspaceId(SESSION),
        isOwnWorkspace: true,
        scope: SESSION,
        name: SESSION.name,
        workspaceScope: BRANCH_SCOPE,
      },
    });
  });

  it('given a session re-opened after panes were split into its workspace, should restore that grid', () => {
    store().ensureMachine('m1');
    store().openTerminal('m1', SESSION);
    const sessionWorkspace = activeOf('m1')!;
    store().splitRight('m1', sessionWorkspace.id, sessionWorkspace.activePaneId);
    store().setActiveWorkspace('m1', store().createWorkspace('m1'));

    store().openTerminal('m1', SESSION);

    assert({
      given: 'a session row clicked again after the user split a second agent into its workspace',
      should: 'restore the whole combination — the workspace is the unit, not the single session that named it',
      actual: { active: activeOf('m1')?.id, panes: paneIds(activeOf('m1')).length },
      expected: { active: sessionWorkspaceId(SESSION), panes: 2 },
    });
  });

  // ---------------------------------------------------------------------
  // One-step spawn: bind the agent to the leaf it was picked in.
  // ---------------------------------------------------------------------

  it('given a spawn resolves, should bind the session and its starting prompt to the pane it was picked in', () => {
    store().ensureMachine('m1');
    const workspace = activeOf('m1')!;
    const paneId = workspace.activePaneId;

    const bound = store().bindPaneTerminal('m1', workspace.id, paneId, SESSION, 'fix the build');

    const pane = panesOf(activeOf('m1')!).find((candidate) => candidate.id === paneId);
    assert({
      given: 'an agent picked in an empty pane, spawned in one action',
      should: 'land in that pane with its starting prompt, no modal and no naming step in between',
      actual: { bound, scope: pane?.scope, prompt: pane?.pendingPrompt },
      expected: { bound: true, scope: SESSION, prompt: 'fix the build' },
    });
  });

  it('given the user switches workspace while a spawn is in flight, should still bind it to the pane it was picked in', () => {
    store().ensureMachine('m1');
    const workspace = activeOf('m1')!;
    const paneId = workspace.activePaneId;

    // The spawn is in flight — a cold Sprite boot takes seconds — and the user
    // goes and looks at another workspace. THEN it resolves.
    const otherId = store().createWorkspace('m1');
    const bound = store().bindPaneTerminal('m1', workspace.id, paneId, SESSION);

    assert({
      given: 'a spawn that resolves after the user has switched to another workspace',
      should:
        'bind it to the pane it was picked in, in ITS OWN workspace — resolving the target against whatever is on screen at write time would drop the write, orphaning the session and leaving the picked pane empty',
      actual: {
        bound,
        picked: panesOf(selectWorkspace('m1', workspace.id)(store())!).find((pane) => pane.id === paneId)?.scope,
        otherUntouched: panesOf(selectWorkspace('m1', otherId)(store())!)[0].scope,
      },
      expected: { bound: true, picked: SESSION, otherUntouched: null },
    });
  });

  it('given the pane is gone when the spawn resolves, should report the bind failed', () => {
    store().ensureMachine('m1');
    const workspace = activeOf('m1')!;

    const bound = store().bindPaneTerminal('m1', workspace.id, 'closed-pane', SESSION);

    assert({
      given: 'a pane closed while its agent was still booting',
      should:
        'report false — the caller uses that to remove the session it just created, rather than strand a terminal the user never saw appear',
      actual: bound,
      expected: false,
    });
  });

  it('given a prompt was typed into the PTY, should clear it so a re-mount does not retype it', () => {
    store().ensureMachine('m1');
    const workspace = activeOf('m1')!;
    store().bindPaneTerminal('m1', workspace.id, workspace.activePaneId, SESSION, 'fix the build');

    store().clearPanePrompt('m1', workspace.id, workspace.activePaneId);

    assert({
      given: 'a starting prompt already delivered to a running agent',
      should: 'clear it — a pane that re-mounts reattaches, and must not type the prompt at the agent a second time',
      actual: panesOf(activeOf('m1')!)[0].pendingPrompt,
      expected: undefined,
    });
  });

  it('given actions on a machine that was never ensured, should be a no-op', () => {
    store().splitRight('never-ensured', 'ws', 'pane');
    store().splitDown('never-ensured', 'ws', 'pane');
    store().closePane('never-ensured', 'ws', 'pane');
    store().selectPane('never-ensured', 'ws', 'pane');
    store().setActiveWorkspace('never-ensured', 'ws');

    assert({
      given: 'pane actions naming a machine with no workspaces',
      should: 'be a no-op — a stale click racing an unmount must not resurrect a grid',
      actual: { machine: selectMachine('never-ensured')(store()), active: activeOf('never-ensured') },
      expected: { machine: undefined, active: undefined },
    });
  });
});

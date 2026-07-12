import { describe, it, beforeEach } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import {
  useMachineWorkspaceStore,
  selectActiveWorkspace,
  selectMachine,
  selectWorkspace,
  selectChildSessionIds,
  selectRunningPaneCount,
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
    window.localStorage.clear();
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

  it('given a session whose pane was closed, should show it again when its row is clicked', () => {
    store().ensureMachine('m1');
    store().openTerminal('m1', SESSION);
    const workspace = activeOf('m1')!;
    // The user splits, then closes the pane the session was opened in.
    store().splitRight('m1', workspace.id, workspace.activePaneId);
    store().closePane('m1', workspace.id, workspace.activePaneId === workspace.id ? workspace.activePaneId : panesOf(selectWorkspace('m1', workspace.id)(store())!)[0].id);

    store().openTerminal('m1', SESSION);

    assert({
      given: 'a session whose pane the user closed, then clicked its sidebar row again',
      should:
        'put it back on screen — selecting the workspace alone would show a grid that no longer contains it, stranding a PTY that is still running and billing',
      actual: panesOf(activeOf('m1')!).some((pane) => pane.scope?.name === SESSION.name),
      expected: true,
    });
  });

  it('given a persisted machine whose active workspace is missing, should repair it instead of rendering nothing', () => {
    // What a bad rehydrate (or a future shape change) can leave behind: the key
    // exists, but the workspace it points at does not.
    useMachineWorkspaceStore.setState({
      machines: { m1: { workspaces: {}, order: [], activeWorkspaceId: 'gone' } },
    });

    store().ensureMachine('m1');

    assert({
      given: 'a machine whose active workspace does not resolve',
      should:
        'rebuild it — skipping on the mere presence of the key would leave the Machine page blank forever, with no way for a user to clear this storage from inside the app',
      actual: { hasActive: activeOf('m1') !== undefined, panes: paneIds(activeOf('m1')).length },
      expected: { hasActive: true, panes: 1 },
    });
  });

  it('given the last workspace, should refuse to remove it', () => {
    store().ensureMachine('m1');
    const onlyId = activeOf('m1')!.id;

    store().removeWorkspace('m1', onlyId);

    assert({
      given: 'the only workspace a machine has',
      should: 'keep it — the middle view has to render something',
      actual: activeOf('m1')?.id,
      expected: onlyId,
    });
  });

  it('given a removed workspace, should show a neighbour', () => {
    store().ensureMachine('m1');
    const firstId = activeOf('m1')!.id;
    const secondId = store().createWorkspace('m1');

    store().removeWorkspace('m1', secondId);

    assert({
      given: 'the active workspace removed',
      should: 'drop it and show the one left',
      actual: { active: activeOf('m1')?.id, count: workspacesOf(selectMachine('m1')(store())).length },
      expected: { active: firstId, count: 1 },
    });
  });

  it('given a persisted blob from an older, incompatible version, should still come up usable', () => {
    // A real round trip through the persist middleware, not a hand-set state:
    // this is what a returning user's browser actually hands the store.
    window.localStorage.setItem(
      'machine-workspace-storage',
      JSON.stringify({
        version: 0,
        state: {
          machines: {
            m1: {
              // Written by a previous version of this app: no `columns`. Rendered
              // as-is it throws (columns.flatMap of undefined) and the Machine
              // page is dead for good — there is no in-app way to clear this key.
              workspaces: { old: { id: 'old', name: 'Old', scope: {}, activePaneId: 'p' } },
              order: ['old'],
              activeWorkspaceId: 'old',
            },
          },
        },
      }),
    );

    useMachineWorkspaceStore.persist.rehydrate();
    store().ensureMachine('m1');

    assert({
      given: "a returning user whose stored workspaces were written by an older, incompatible version",
      should: 'drop what cannot be rendered and rebuild a usable workspace, rather than crash the page or render nothing',
      actual: { panes: paneIds(activeOf('m1')).length, name: activeOf('m1')?.name },
      expected: { panes: 1, name: 'Workspace 1' },
    });
  });

  it('given a persisted blob this version CAN render, should restore the grid', () => {
    const workspace = {
      id: 'ws-1',
      name: 'claude-a1b2c3',
      scope: BRANCH_SCOPE,
      columns: [
        { id: 'c1', panes: [{ id: 'p1', scope: SESSION, pendingPrompt: 'stale prompt' }] },
        { id: 'c2', panes: [{ id: 'p2', scope: null }] },
      ],
      activePaneId: 'p1',
      pendingPickerPaneId: 'p2',
    };
    window.localStorage.setItem(
      'machine-workspace-storage',
      JSON.stringify({
        version: 1,
        state: { machines: { m1: { workspaces: { 'ws-1': workspace }, order: ['ws-1'], activeWorkspaceId: 'ws-1' } } },
      }),
    );

    useMachineWorkspaceStore.persist.rehydrate();

    const restored = activeOf('m1');
    assert({
      given: 'a workspace restored from storage after a reload (its PTYs survive their reap window)',
      should:
        'come back with its panes intact so they reattach — but WITHOUT the transient bits: an undelivered prompt must never be typed at an agent that has been running since, and a picker must not steal the caret on load',
      actual: {
        panes: paneIds(restored).length,
        session: panesOf(restored!)[0].scope,
        prompt: panesOf(restored!)[0].pendingPrompt,
        picker: restored?.pendingPickerPaneId,
      },
      expected: { panes: 2, session: SESSION, prompt: undefined, picker: null },
    });
  });

  it('given a session SPAWNED into a workspace, should open it where it actually lives', () => {
    store().ensureMachine('m1');
    const workspace = activeOf('m1')!;
    // Split-and-pick: the agent was bound into a pane of THIS workspace, so it
    // has no workspace of its own.
    store().bindPaneTerminal('m1', workspace.id, workspace.activePaneId, SESSION);
    store().setActiveWorkspace('m1', store().createWorkspace('m1'));

    store().openTerminal('m1', SESSION);

    assert({
      given: "a split-and-pick agent's row clicked in the sidebar",
      should:
        'switch to the workspace it was spawned into, NOT mint a second workspace for it — that would drag the user out of the grid they built it in and leave one PTY claimed by panes in two workspaces',
      actual: {
        active: activeOf('m1')?.id,
        workspaces: workspacesOf(selectMachine('m1')(store())).length,
      },
      expected: { active: workspace.id, workspaces: 2 },
    });
  });

  it('given agents spawned into a workspace, should expose them as CHILD sessions, not sidebar rows', () => {
    store().ensureMachine('m1');
    const workspace = activeOf('m1')!;
    // One session opened from the sidebar (its own workspace), one spawned into it.
    store().openTerminal('m1', SESSION);
    const sessionWorkspace = activeOf('m1')!;
    const spawned = { ...BRANCH_SCOPE, name: 'codex-b2c3d4' };
    store().splitRight('m1', sessionWorkspace.id, sessionWorkspace.activePaneId);
    store().bindPaneTerminal(
      'm1',
      sessionWorkspace.id,
      selectWorkspace('m1', sessionWorkspace.id)(store())!.activePaneId,
      spawned,
    );

    const children = selectChildSessionIds('m1')(store());

    assert({
      given: 'a workspace opened from a session row, with a second agent split-and-picked into it',
      should:
        'report only the SPAWNED one as a child — it belongs to the workspace that owns it, and listing it as its own sidebar row would put one agent in two places',
      actual: {
        spawnedIsChild: children.has(sessionWorkspaceId(spawned)),
        ownSessionIsNot: children.has(sessionWorkspaceId(SESSION)),
        running: selectRunningPaneCount('m1')(store()),
      },
      expected: { spawnedIsChild: true, ownSessionIsNot: false, running: 2 },
    });
    void workspace;
  });

  it('given the same state read twice, selectChildSessionIds should hand back the SAME set', () => {
    store().ensureMachine('m1');
    const workspace = activeOf('m1')!;
    store().bindPaneTerminal('m1', workspace.id, workspace.activePaneId, SESSION);

    const first = selectChildSessionIds('m1')(store());
    const second = selectChildSessionIds('m1')(store());
    // A write the derivation depends on must produce a new answer.
    store().splitRight('m1', workspace.id, workspace.activePaneId);
    const afterChange = selectChildSessionIds('m1')(store());

    assert({
      given: 'a selector that derives a Set, read twice from unchanged state, then after a write',
      should:
        'return the identical Set until the state changes — zustand v5 runs the selector inside getSnapshot, so allocating a fresh Set per read hands React a new snapshot every time and the component loops',
      actual: { stable: first === second, freshAfterChange: afterChange !== first },
      expected: { stable: true, freshAfterChange: true },
    });
  });
});

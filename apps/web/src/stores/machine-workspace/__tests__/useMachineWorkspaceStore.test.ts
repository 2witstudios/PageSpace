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
  MACHINE_NODE_SCOPE,
  type WorkspaceState,
} from '../useMachineWorkspaceStore';
import { workspacesOf, sessionWorkspaceId, newWorkspace } from '../workspace-reducer';

const store = () => useMachineWorkspaceStore.getState();
const activeOf = (machineId: string) => selectActiveWorkspace(machineId)(store());
const paneIds = (workspace: WorkspaceState | undefined) => (workspace ? panesOf(workspace).map((pane) => pane.id) : []);

/** A machine with one workspace open — the state most of these tests want to
 * start from. `ensureMachine` alone no longer gets you there: it creates the
 * machine's ENTRY and nothing else, because zero workspaces is a legal state and
 * fabricating a first one is exactly the bug this store used to have. */
const seedMachine = (machineId: string) => {
  store().ensureMachine(machineId);
  return store().createWorkspace(machineId);
};

const BRANCH_SCOPE = { projectName: 'app', branchName: 'main' };
/** A session opened at MACHINE scope — the node `seedMachine`'s workspaces sit
 * at. It has to match: a pane's checkout IS its workspace's, so binding a
 * branch-scoped session into a machine-scoped workspace is not a layout this
 * model can express (see the bind-time assertion test below). */
const SESSION = { name: 'shell-a1b2c3' };

describe('useMachineWorkspaceStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useMachineWorkspaceStore.setState({ machines: {} });
  });

  it('given a machine is ensured, should give it an entry with NO workspaces', () => {
    store().ensureMachine('m1');

    assert({
      given: 'a Machine page mounting for the first time',
      should:
        'create the entry and open nothing — a machine with no terminals is a legal state, and fabricating a first workspace here is what made a removed row come straight back',
      actual: {
        hasEntry: selectMachine('m1')(store()) !== undefined,
        workspaces: workspacesOf(selectMachine('m1')(store())).length,
        active: selectMachine('m1')(store())?.activeWorkspaceId,
      },
      expected: { hasEntry: true, workspaces: 0, active: '' },
    });
  });

  it('given a workspace created after ensureMachine, should auto-name it Workspace 1 with one empty pane', () => {
    seedMachine('m1');

    assert({
      given: 'the user opening the first terminal on a fresh machine',
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
    seedMachine('m1');
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

  it('given ensureMachine over a machine the user emptied, should NOT re-create a workspace', () => {
    const onlyId = seedMachine('m1');
    store().removeWorkspace('m1', onlyId);

    store().ensureMachine('m1');

    assert({
      given: 'a re-mount (tab switch, re-render) after the user removed the last view',
      should:
        'leave it empty — re-fabricating here would make the last row impossible to remove, since every mount would put it back',
      actual: workspacesOf(selectMachine('m1')(store())).length,
      expected: 0,
    });
  });

  // ---------------------------------------------------------------------
  // THE FIX: selecting a workspace switches the entire middle view.
  // ---------------------------------------------------------------------

  it('given a second workspace is selected, should switch the WHOLE middle view to its grid', () => {
    seedMachine('m1');
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
    seedMachine('m1');
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
    seedMachine('m1');
    seedMachine('m2');
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
    seedMachine('m1');
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
        workspaceScope: MACHINE_NODE_SCOPE,
      },
    });
  });

  it('given a session re-opened after panes were split into its workspace, should restore that grid', () => {
    seedMachine('m1');
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
    seedMachine('m1');
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
    seedMachine('m1');
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
    seedMachine('m1');
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
    seedMachine('m1');
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
    seedMachine('m1');
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

  it('given a persisted machine whose active workspace is missing, should re-target the active id', () => {
    // What a bad rehydrate (or a future shape change) can leave behind: the key
    // exists, but the workspace it points at does not.
    const workspace = { ...newWorkspace({ id: 'ws-real', name: 'W', scope: {}, firstPaneId: 'p1' }) };
    useMachineWorkspaceStore.setState({
      machines: { m1: { workspaces: { 'ws-real': workspace }, order: ['ws-real'], activeWorkspaceId: 'gone' } },
    });

    store().ensureMachine('m1');

    assert({
      given: 'a machine whose active workspace does not resolve, but which HAS workspaces',
      should:
        'point active at one that exists — a dangling id renders nothing, and there is no way for a user to clear this storage from inside the app',
      actual: activeOf('m1')?.id,
      expected: 'ws-real',
    });
  });

  it('given a persisted machine with a dangling active id and NO workspaces, should settle on nothing active', () => {
    useMachineWorkspaceStore.setState({
      machines: { m1: { workspaces: {}, order: [], activeWorkspaceId: 'gone' } },
    });

    store().ensureMachine('m1');

    assert({
      given: 'a machine whose active id dangles over an empty workspace list',
      should: "repair to '' — the empty state renders for this, so there is nothing to fabricate",
      actual: selectMachine('m1')(store())?.activeWorkspaceId,
      expected: '',
    });
  });

  it('given the last workspace, should remove it and leave nothing active', () => {
    const onlyId = seedMachine('m1');

    store().removeWorkspace('m1', onlyId);

    assert({
      given: 'the only workspace a machine has',
      should:
        'remove it — refusing here is what left an unremovable row in the sidebar that New terminal then duplicated',
      actual: {
        active: selectMachine('m1')(store())?.activeWorkspaceId,
        count: workspacesOf(selectMachine('m1')(store())).length,
      },
      expected: { active: '', count: 0 },
    });
  });

  it('given a removed workspace, should show a neighbour', () => {
    seedMachine('m1');
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
    seedMachine('m1');

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
      name: 'shell-a1b2c3',
      scope: BRANCH_SCOPE,
      columns: [
        // Stored WIDE, by a version of this app that duplicated the checkout
        // onto every pane. Read-time projection is the whole migration: the
        // checkout comes back off the workspace, so the pane keeps only its
        // name (and, when tagged, its surface kind).
        { id: 'c1', panes: [{ id: 'p1', scope: { ...BRANCH_SCOPE, ...SESSION }, pendingPrompt: 'stale prompt' }] },
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
      given: 'a workspace restored from storage after a reload, its panes written in the WIDE pre-narrowing shape',
      should:
        'come back with its panes intact so they reattach — PROJECTED to {name, kind} (the checkout is the workspace\'s, never a second copy per pane) and WITHOUT the transient bits: an undelivered prompt must never be typed at an agent that has been running since, and a picker must not steal the caret on load',
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
    seedMachine('m1');
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
    seedMachine('m1');
    const workspace = activeOf('m1')!;
    // One session opened from the sidebar (its own workspace), one spawned into it.
    store().openTerminal('m1', SESSION);
    const sessionWorkspace = activeOf('m1')!;
    const spawned = { name: 'shell-b2c3d4' };
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
    seedMachine('m1');
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

  // ---------------------------------------------------------------------
  // Server sync actions (#2048)
  // ---------------------------------------------------------------------

  it('given renameWorkspace, should rename only the named workspace', () => {
    seedMachine('m1');
    const workspace = activeOf('m1')!;

    store().renameWorkspace('m1', workspace.id, 'Renamed');

    assert({
      given: "a rename of a machine's only workspace",
      should: 'apply the new name in place',
      actual: activeOf('m1')?.name,
      expected: 'Renamed',
    });
  });

  it('given hydrateFromServer with no prior local state, should build a renderable machine from the server list', () => {
    store().hydrateFromServer('m1', [
      { id: 'ws-1', name: 'Workspace 1', scope: {}, columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }] },
    ]);

    assert({
      given: 'the sync hook\'s initial hydrate, for a machine this browser has never opened',
      should: 'adopt the server\'s workspace as this machine\'s state',
      actual: { active: activeOf('m1')?.id, name: activeOf('m1')?.name },
      expected: { active: 'ws-1', name: 'Workspace 1' },
    });
  });

  it('given hydrateFromServer for an already-open workspace, should preserve local focus', () => {
    seedMachine('m1');
    const workspace = activeOf('m1')!;
    store().splitRight('m1', workspace.id, workspace.activePaneId);
    const afterSplit = activeOf('m1')!;
    const secondPaneId = paneIds(afterSplit)[1];
    store().selectPane('m1', workspace.id, secondPaneId);

    store().hydrateFromServer('m1', [
      { id: workspace.id, name: workspace.name, scope: workspace.scope, columns: afterSplit.columns },
    ]);

    assert({
      given: 'a server payload for a workspace this browser already has open with a pane focused',
      should: 'keep the LOCAL activePaneId — focus never comes from the server',
      actual: activeOf('m1')?.activePaneId,
      expected: secondPaneId,
    });
  });

  it('given hydrateFromServer with a pane scope carrying the content kind, should round-trip it (#2166 phase 9)', () => {
    store().hydrateFromServer('m1', [
      {
        id: 'ws-1',
        name: 'Workspace 1',
        scope: {},
        columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: { name: 'pagespace-a1', kind: 'chat' } }] }],
      },
    ]);

    assert({
      given: "the sync hook's initial hydrate carrying a pane tagged kind: 'chat'",
      should: 'round-trip the content kind into the store',
      actual: panesOf(activeOf('m1')!)[0]?.scope,
      expected: { name: 'pagespace-a1', kind: 'chat' },
    });
  });

  // Migration is READ-TIME PROJECTION, not a backfill: a wide pane was
  // representable but never written by any path that disagreed with its
  // workspace, so there is nothing to reconcile — the duplicated checkout is
  // simply dropped on the way in, from BOTH merge paths (this one and
  // localStorage's `sanitizeMachines`, covered by the rehydrate test above).
  it('given hydrateFromServer with a WIDE pane scope, should project it to {name, kind}', () => {
    store().hydrateFromServer('m1', [
      {
        id: 'ws-1',
        name: 'W',
        scope: BRANCH_SCOPE,
        columns: [
          {
            id: 'col-1',
            panes: [{ id: 'pane-1', scope: { projectName: 'app', branchName: 'main', name: 'pagespace-a1', kind: 'chat' } }],
          },
        ],
      },
    ]);

    assert({
      given: 'a server layout whose pane still carries the pre-narrowing {projectName, branchName}',
      should:
        'keep only {name, kind} — the checkout is read back from the workspace, so storing it per pane is a second copy of one fact that could disagree with it',
      actual: {
        pane: panesOf(activeOf('m1')!)[0]?.scope,
        checkout: activeOf('m1')?.scope,
      },
      expected: {
        pane: { name: 'pagespace-a1', kind: 'chat' },
        checkout: BRANCH_SCOPE,
      },
    });
  });

  // The bind-time assertion. A pane's checkout is its workspace's, so a bind
  // naming a DIFFERENT node has no representation to fall back on — it is a
  // caller bug (a spawn addressed at the wrong node), not a race, and swallowing
  // it would silently file the session under a checkout it does not run in.
  it('given a bind whose node differs from the workspace\'s, should reject it', () => {
    store().hydrateFromServer('m1', [
      { id: 'ws-1', name: 'W', scope: BRANCH_SCOPE, columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }] },
    ]);

    let rejected = false;
    try {
      store().bindPaneTerminal('m1', 'ws-1', 'pane-1', { projectName: 'other', name: 'shell-x' });
    } catch {
      rejected = true;
    }

    assert({
      given: 'a session at project "other" bound into a workspace checked out at app/main',
      should: 'reject the bind and leave the pane empty — foreign panes are unrepresentable, not merely discouraged',
      actual: { rejected, pane: panesOf(selectWorkspace('m1', 'ws-1')(store())!)[0]?.scope },
      expected: { rejected: true, pane: null },
    });
  });

  it('given applyServerUpsert for an unseen workspace id, should add it', () => {
    seedMachine('m1');
    const existing = activeOf('m1')!;

    store().applyServerUpsert('m1', {
      id: 'ws-from-elsewhere',
      name: 'Created elsewhere',
      scope: {},
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }],
    });

    assert({
      given: 'a machine-workspace:created broadcast for a workspace another browser just made',
      should: "add it alongside this machine's existing workspace",
      actual: workspacesOf(selectMachine('m1')(store())).map((w) => w.id).sort(),
      expected: [existing.id, 'ws-from-elsewhere'].sort(),
    });
  });

  // The monotone-merge invariant (spawn double-row field bug): a pane's scope
  // only ever transitions null -> bound within its lifetime — no flow unbinds
  // (closing REMOVES the pane) — so a server pane with a null scope landing on
  // a same-id pane this browser already bound is always a STALE ECHO racing
  // this browser's own push, never a legitimate state.
  it('given a stale server echo with a null-scope pane, should keep the local pane\'s bind', () => {
    store().hydrateFromServer('m1', [
      { id: 'ws-1', name: 'W', scope: BRANCH_SCOPE, columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }] },
    ]);
    store().bindPaneTerminal('m1', 'ws-1', 'pane-1', { ...BRANCH_SCOPE, name: 'pagespace-x', kind: 'chat' });

    // The empty `created` echo from the workspace's own POST, arriving late.
    store().applyServerUpsert('m1', {
      id: 'ws-1',
      name: 'W',
      scope: BRANCH_SCOPE,
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }],
    });

    assert({
      given: 'a bound pane hit by its workspace\'s own stale empty created-echo',
      should:
        'keep the bind — losing it is what showed one agent as an empty workspace plus an unclaimed row; the null->bound invariant is unchanged in shape on the narrow pane type',
      actual: panesOf(selectWorkspace('m1', 'ws-1')(store())!)[0]?.scope,
      expected: { name: 'pagespace-x', kind: 'chat' },
    });
  });

  it('given a stale full-list hydrate with a null-scope pane, should keep the local bind too', () => {
    store().hydrateFromServer('m1', [
      { id: 'ws-1', name: 'W', scope: BRANCH_SCOPE, columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }] },
    ]);
    store().bindPaneTerminal('m1', 'ws-1', 'pane-1', { ...BRANCH_SCOPE, name: 'pagespace-x' });

    // A second sync instance's full-replace from a GET that predates the bind
    // PATCH (both merge paths funnel through the same mergeColumns).
    store().hydrateFromServer('m1', [
      { id: 'ws-1', name: 'W', scope: BRANCH_SCOPE, columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }] },
    ]);

    assert({
      given: 'a stale hydrate racing this browser\'s own bind',
      should: 'keep the local pane bound',
      actual: panesOf(selectWorkspace('m1', 'ws-1')(store())!)[0]?.scope,
      expected: { name: 'pagespace-x' },
    });
  });

  it('given a server pane with a NON-null scope, should still let the server win', () => {
    store().hydrateFromServer('m1', [
      { id: 'ws-1', name: 'W', scope: BRANCH_SCOPE, columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }] },
    ]);
    store().bindPaneTerminal('m1', 'ws-1', 'pane-1', { ...BRANCH_SCOPE, name: 'pagespace-old' });

    store().applyServerUpsert('m1', {
      id: 'ws-1',
      name: 'W',
      scope: BRANCH_SCOPE,
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: { ...BRANCH_SCOPE, name: 'pagespace-new', kind: 'chat' } }] }],
    });

    assert({
      given: 'a server pane carrying a real (non-null) scope',
      should: 'apply it — the guard is null-over-bound only, never a general local-wins rule — projected to the narrow shape like every other incoming pane',
      actual: panesOf(selectWorkspace('m1', 'ws-1')(store())!)[0]?.scope,
      expected: { name: 'pagespace-new', kind: 'chat' },
    });
  });

  it('given a server payload dropping a bound pane and adding an empty one, should mirror the server layout', () => {
    store().hydrateFromServer('m1', [
      { id: 'ws-1', name: 'W', scope: BRANCH_SCOPE, columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }, { id: 'pane-2', scope: null }] }] },
    ]);
    store().bindPaneTerminal('m1', 'ws-1', 'pane-1', { ...BRANCH_SCOPE, name: 'pagespace-x' });

    // pane-1 removed server-side (closed elsewhere); pane-2 still empty; pane-3 new and empty.
    store().applyServerUpsert('m1', {
      id: 'ws-1',
      name: 'W',
      scope: BRANCH_SCOPE,
      columns: [{ id: 'col-1', panes: [{ id: 'pane-2', scope: null }, { id: 'pane-3', scope: null }] }],
    });

    assert({
      given: 'a server layout that removed the bound pane and added a fresh empty one',
      should: 'drop the removed pane (the guard must not resurrect closed panes), keep null-over-null null, and admit the new empty pane',
      actual: panesOf(selectWorkspace('m1', 'ws-1')(store())!).map((pane) => ({ id: pane.id, scope: pane.scope })),
      expected: [
        { id: 'pane-2', scope: null },
        { id: 'pane-3', scope: null },
      ],
    });
  });

  it('given openTerminal with a chat-kind scope, should carry the kind onto the materialized pane', () => {
    store().ensureMachine('m1');
    const scope = { ...BRANCH_SCOPE, name: 'pagespace-k1', kind: 'chat' as const };

    store().openTerminal('m1', scope);

    assert({
      given: 'the instant-spawn path materializing a session\'s own workspace',
      should:
        'preserve scope.kind on the first pane — the pane grid renders MachinePaneChat from this tag — while the checkout lands on the WORKSPACE, not a second copy on the pane',
      actual: {
        pane: panesOf(selectWorkspace('m1', sessionWorkspaceId(scope))(store())!)[0]?.scope,
        checkout: selectWorkspace('m1', sessionWorkspaceId(scope))(store())?.scope,
      },
      expected: { pane: { name: 'pagespace-k1', kind: 'chat' }, checkout: BRANCH_SCOPE },
    });
  });

  it('given applyServerDelete for the active workspace, should show a neighbour', () => {
    seedMachine('m1');
    const first = activeOf('m1')!;
    const secondId = store().createWorkspace('m1');
    store().setActiveWorkspace('m1', secondId);

    store().applyServerDelete('m1', secondId);

    assert({
      given: 'a machine-workspace:deleted broadcast for the workspace currently on screen',
      should: 'drop it and fall back to a neighbour, same as a local removeWorkspace',
      actual: activeOf('m1')?.id,
      expected: first.id,
    });
  });
});

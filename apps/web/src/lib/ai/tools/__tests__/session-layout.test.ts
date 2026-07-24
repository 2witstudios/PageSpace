import { describe, it, beforeEach } from 'vitest';
import { assert } from './riteway';

import { planCloseSession, planMoveSession, planPlaceSession, type SessionView } from '../session-layout';
import { applyVerbLocal, type WorkspaceVerb } from '@/stores/machine-workspace/workspace-verbs';
import {
  machineNodeScope,
  type MachineWorkspacesState,
  type TerminalColumnState,
  type WorkspaceState,
} from '@/stores/machine-workspace/workspace-reducer';
import {
  useMachineWorkspaceStore,
  sessionWorkspaceId,
  nodeScopeNames,
  type OpenTerminalScope,
} from '@/stores/machine-workspace/useMachineWorkspaceStore';

/**
 * The server's placement decision must produce the SAME grid the phase-1
 * client writer produces for the same act — that is the whole reason
 * `applyVerbLocal` (imported here, applied to the planner's own verbs) is the
 * SAME function the client's optimistic apply and the HTTP verb engine both
 * use, rather than a server-side re-implementation of "what a workspace looks
 * like". These cases drive the REAL client store (`openTerminal`, `splitDown`
 * + `bindPaneTerminal`) and byte-compare its resulting columns against
 * `applyVerbLocal(plan.verbs)`'s, with the client's own generated ids fed
 * back in so the only remaining difference would be a genuine shape
 * difference.
 */

const MACHINE_ID = 'machine-page-1';

function resetStore(): void {
  useMachineWorkspaceStore.setState({ machines: {} });
}

function stripLocal(columns: TerminalColumnState[]) {
  return columns.map((column) => ({ id: column.id, panes: column.panes.map((pane) => ({ id: pane.id, scope: pane.scope })) }));
}

/** The wire form of one of this browser's workspaces — what `useMachineWorkspaceSync` would push. */
function clientWire(workspaceId: string) {
  const workspace = useMachineWorkspaceStore.getState().machines[MACHINE_ID].workspaces[workspaceId];
  return {
    id: workspace.id,
    name: workspace.name,
    scope: nodeScopeNames(workspace.scope),
    columns: stripLocal(workspace.columns),
  };
}

/** Reconstructs the `MachineWorkspacesState` the planner saw from its `views` input — the test-side mirror of `session-layout.ts`'s private `toMachineState`. */
function stateFromViews(views: SessionView[]): MachineWorkspacesState {
  const workspaces: Record<string, WorkspaceState> = {};
  const order: string[] = [];
  for (const view of views) {
    const paneIds = view.columns.flatMap((column) => column.panes.map((pane) => pane.id));
    workspaces[view.id] = {
      id: view.id,
      name: view.name,
      scope: machineNodeScope({
        ...(view.projectName ? { projectName: view.projectName } : {}),
        ...(view.branchName ? { branchName: view.branchName } : {}),
      }),
      columns: view.columns,
      activePaneId: paneIds[0] ?? '',
      pendingPickerPaneId: null,
    };
    order.push(view.id);
  }
  return { workspaces, order, activeWorkspaceId: '' };
}

/** Applies a plan's verbs, in order, through the SAME `applyVerbLocal` the client and the HTTP verb engine use. */
function applyPlanVerbs(state: MachineWorkspacesState, verbs: WorkspaceVerb[]): MachineWorkspacesState {
  let current = state;
  for (const verb of verbs) current = applyVerbLocal(current, verb).state;
  return current;
}

describe('planPlaceSession', () => {
  beforeEach(resetStore);

  it('given a new session at a project node, should byte-match the client writer\'s born-bound workspace', () => {
    const scope: OpenTerminalScope = { projectName: 'repo', name: 'pagespace-a1b2c3', kind: 'chat' };

    useMachineWorkspaceStore.getState().openTerminal(MACHINE_ID, scope);
    const workspaceId = sessionWorkspaceId(scope);
    const client = clientWire(workspaceId);
    const paneId = client.columns[0].panes[0].id;

    const plan = planPlaceSession([], scope, 'new-view', { paneId, columnId: 'unused-column-id' });
    if (!plan.ok) throw new Error(`expected a plan, got ${plan.reason}`);
    const after = applyPlanVerbs(stateFromViews([]), plan.verbs);

    assert({
      given: 'a session with no existing views',
      should: 'plan a create-workspace verb whose applied grid matches the client\'s born-bound workspace',
      actual: { verbs: plan.verbs, columns: stripLocal(after.workspaces[plan.viewId].columns) },
      expected: {
        verbs: [{ type: 'create-workspace', workspaceId, name: client.name, scope: client.scope, firstPaneId: paneId, session: { name: scope.name, kind: 'chat' } }],
        columns: client.columns,
      },
    });
  });

  it('given a split into an existing view, should byte-match the client\'s split-and-bind layout', () => {
    const scope: OpenTerminalScope = { name: 'shell-b2c3d4', kind: 'terminal' };

    const workspaceId = useMachineWorkspaceStore.getState().createWorkspace(MACHINE_ID);
    const before = clientWire(workspaceId);
    const anchorPaneId = before.columns[0].panes[0].id;

    useMachineWorkspaceStore.getState().splitDown(MACHINE_ID, workspaceId, anchorPaneId);
    const split = clientWire(workspaceId);
    const newPaneId = split.columns[0].panes[1].id;
    useMachineWorkspaceStore.getState().bindPaneTerminal(MACHINE_ID, workspaceId, newPaneId, scope);
    const client = clientWire(workspaceId);

    const view: SessionView = { id: before.id, name: before.name, projectName: null, branchName: null, columns: before.columns };
    const plan = planPlaceSession([view], scope, { splitInto: workspaceId, direction: 'down' }, { paneId: newPaneId, columnId: 'unused-column-id' });
    if (!plan.ok) throw new Error(`expected a plan, got ${plan.reason}`);
    const after = applyPlanVerbs(stateFromViews([view]), plan.verbs);

    assert({
      given: 'a split-down placement into a machine-scoped view',
      should: 'plan a split-pane verb whose applied columns match the client\'s split-and-bind result',
      actual: stripLocal(after.workspaces[workspaceId].columns),
      expected: client.columns,
    });
  });

  it('given a split into a view at another node, should refuse rather than misfile the session', () => {
    const scope: OpenTerminalScope = { projectName: 'repo', name: 'pagespace-c3d4e5', kind: 'chat' };
    const view: SessionView = {
      id: 'view-at-machine-root',
      name: 'Workspace 1',
      projectName: null,
      branchName: null,
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }],
    };

    const plan = planPlaceSession([view], scope, { splitInto: view.id, direction: 'right' }, { paneId: 'pane-2', columnId: 'col-2' });

    assert({
      given: 'a project-scoped session split into a machine-root view',
      should: 'refuse as a cross-node placement',
      actual: plan,
      expected: { ok: false, reason: 'cross_node' },
    });
  });

  it('given a split into a view that does not exist, should refuse', () => {
    const scope: OpenTerminalScope = { name: 'shell-d4e5f6', kind: 'terminal' };

    const plan = planPlaceSession([], scope, { splitInto: 'gone', direction: 'down' }, { paneId: 'pane-2', columnId: 'col-2' });

    assert({
      given: 'a placement naming an unknown view',
      should: 'refuse as view_not_found',
      actual: plan,
      expected: { ok: false, reason: 'view_not_found' },
    });
  });

  it('given a session whose own view already exists, should reuse it instead of creating a second', () => {
    const scope: OpenTerminalScope = { name: 'shell-e5f6a7', kind: 'terminal' };
    const workspaceId = sessionWorkspaceId(scope);
    const view: SessionView = {
      id: workspaceId,
      name: scope.name,
      projectName: null,
      branchName: null,
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }],
    };

    const plan = planPlaceSession([view], scope, 'new-view', { paneId: 'pane-2', columnId: 'col-2' });
    if (!plan.ok) throw new Error(`expected a plan, got ${plan.reason}`);
    const after = applyPlanVerbs(stateFromViews([view]), plan.verbs);

    assert({
      given: 'a new-view placement for a session whose derived view still exists',
      should: 'bind the session into that view\'s empty pane (add-pane), not create a duplicate workspace',
      actual: { verbs: plan.verbs.map((v) => v.type), columns: stripLocal(after.workspaces[workspaceId].columns) },
      expected: {
        verbs: ['add-pane'],
        columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: { name: scope.name, kind: 'terminal' } }] }],
      },
    });
  });
});

describe('planCloseSession', () => {
  it('given the session\'s only pane, should remove the whole view', () => {
    const scope: OpenTerminalScope = { name: 'shell-a1', kind: 'terminal' };
    const view: SessionView = {
      id: 'w1',
      name: 'shell-a1',
      projectName: null,
      branchName: null,
      columns: [{ id: 'c1', panes: [{ id: 'p1', scope: { name: 'shell-a1', kind: 'terminal' } }] }],
    };

    assert({
      given: 'a session that is the only pane of its view',
      should: 'emit one close-pane verb and report the view as removed',
      actual: planCloseSession([view], scope),
      expected: { verbs: [{ type: 'close-pane', workspaceId: 'w1', paneId: 'p1' }], closedWorkspaceIds: ['w1'] },
    });
  });

  it('given a session sharing a view, should close only its pane', () => {
    const scope: OpenTerminalScope = { name: 'shell-a1', kind: 'terminal' };
    const view: SessionView = {
      id: 'w1',
      name: 'Workspace 1',
      projectName: null,
      branchName: null,
      columns: [
        {
          id: 'c1',
          panes: [
            { id: 'p1', scope: { name: 'other' } },
            { id: 'p2', scope: { name: 'shell-a1', kind: 'terminal' } },
          ],
        },
      ],
    };

    const plan = planCloseSession([view], scope);
    const after = applyPlanVerbs(stateFromViews([view]), plan.verbs);

    assert({
      given: 'a session sharing its view with another',
      should: 'close only its pane and NOT remove the view',
      actual: { verbs: plan.verbs, closedWorkspaceIds: plan.closedWorkspaceIds, columns: stripLocal(after.workspaces.w1.columns) },
      expected: {
        verbs: [{ type: 'close-pane', workspaceId: 'w1', paneId: 'p2' }],
        closedWorkspaceIds: [],
        columns: [{ id: 'c1', panes: [{ id: 'p1', scope: { name: 'other' } }] }],
      },
    });
  });

  it('given a session at another node with the same name, should leave it alone', () => {
    const scope: OpenTerminalScope = { name: 'shell-a1', kind: 'terminal' };
    const view: SessionView = {
      id: 'w1',
      name: 'shell-a1',
      projectName: 'repo',
      branchName: null,
      columns: [{ id: 'c1', panes: [{ id: 'p1', scope: { name: 'shell-a1', kind: 'terminal' } }] }],
    };

    assert({
      given: 'a same-named session in a project-scoped view',
      should: 'plan nothing for a machine-scoped kill',
      actual: planCloseSession([view], scope),
      expected: { verbs: [], closedWorkspaceIds: [] },
    });
  });
});

describe('planMoveSession', () => {
  beforeEach(resetStore);

  it('given a re-home into another view at the same node, should close the old manifestation and place the new one', () => {
    const scope: OpenTerminalScope = { name: 'shell-a1', kind: 'terminal' };
    const source: SessionView = {
      id: 'w1',
      name: 'shell-a1',
      projectName: null,
      branchName: null,
      columns: [{ id: 'c1', panes: [{ id: 'p1', scope: { name: 'shell-a1', kind: 'terminal' } }] }],
    };
    const destination: SessionView = {
      id: 'w2',
      name: 'Workspace 1',
      projectName: null,
      branchName: null,
      columns: [{ id: 'c2', panes: [{ id: 'p2', scope: { name: 'other' } }] }],
    };

    const plan = planMoveSession([source, destination], scope, { splitInto: 'w2', direction: 'down' }, { paneId: 'p3', columnId: 'c3' });
    if (!plan.ok) throw new Error(`expected a plan, got ${plan.reason}`);
    const after = applyPlanVerbs(stateFromViews([source, destination]), plan.verbs);

    assert({
      given: 'a session moved out of its own view into another',
      should: 'remove the emptied source view and bind a fresh pane in the destination',
      actual: {
        verbs: plan.verbs,
        sourceGone: after.workspaces.w1 === undefined,
        destinationColumns: stripLocal(after.workspaces.w2.columns),
      },
      expected: {
        verbs: [
          { type: 'close-pane', workspaceId: 'w1', paneId: 'p1' },
          { type: 'split-pane', workspaceId: 'w2', fromPaneId: 'p2', direction: 'down', newColumnId: 'c3', newPaneId: 'p3', session: { name: 'shell-a1', kind: 'terminal' } },
        ],
        sourceGone: true,
        destinationColumns: [
          {
            id: 'c2',
            panes: [
              { id: 'p2', scope: { name: 'other' } },
              { id: 'p3', scope: { name: 'shell-a1', kind: 'terminal' } },
            ],
          },
        ],
      },
    });
  });

  it('given a move into a view at another node, should refuse — a move never changes a session\'s sandbox', () => {
    const scope: OpenTerminalScope = { projectName: 'repo', name: 'pagespace-a1', kind: 'chat' };
    const source: SessionView = {
      id: 'w1',
      name: 'pagespace-a1',
      projectName: 'repo',
      branchName: null,
      columns: [{ id: 'c1', panes: [{ id: 'p1', scope: { name: 'pagespace-a1', kind: 'chat' } }] }],
    };
    const destination: SessionView = {
      id: 'w2',
      name: 'Workspace 1',
      projectName: null,
      branchName: null,
      columns: [{ id: 'c2', panes: [{ id: 'p2', scope: null }] }],
    };

    assert({
      given: 'a project-scoped session moved into a machine-root view',
      should: 'refuse as a cross-node move',
      actual: planMoveSession([source, destination], scope, { splitInto: 'w2', direction: 'down' }, { paneId: 'p3', columnId: 'c3' }),
      expected: { ok: false, reason: 'cross_node' },
    });
  });

  it('given a moved session, should survive a stale null-scope echo of its new view', () => {
    const scope: OpenTerminalScope = { name: 'shell-a1', kind: 'terminal' };
    const source: SessionView = {
      id: 'w1',
      name: 'shell-a1',
      projectName: null,
      branchName: null,
      columns: [{ id: 'c1', panes: [{ id: 'p1', scope: { name: 'shell-a1', kind: 'terminal' } }] }],
    };
    const destination: SessionView = {
      id: 'w2',
      name: 'Workspace 1',
      projectName: null,
      branchName: null,
      columns: [{ id: 'c2', panes: [{ id: 'p2', scope: { name: 'other' } }] }],
    };

    // A browser holding both views, exactly as the server does.
    const store = useMachineWorkspaceStore.getState();
    store.hydrateFromServer(
      MACHINE_ID,
      [source, destination].map((view) => ({ id: view.id, name: view.name, scope: {}, columns: view.columns })),
    );

    const plan = planMoveSession([source, destination], scope, { splitInto: 'w2', direction: 'down' }, { paneId: 'p3', columnId: 'c3' });
    if (!plan.ok) throw new Error(`expected a plan, got ${plan.reason}`);

    // Apply the move's verbs in plan order, broadcasting exactly as
    // `broadcastWorkspaceVerbResult` would — the way the sync hook consumes them.
    let state = stateFromViews([source, destination]);
    for (const verb of plan.verbs) {
      const outcome = applyVerbLocal(state, verb);
      state = outcome.state;
      if (outcome.removedWorkspaceId) {
        useMachineWorkspaceStore.getState().applyServerDelete(MACHINE_ID, outcome.removedWorkspaceId);
      } else {
        const ws = state.workspaces[verb.workspaceId];
        useMachineWorkspaceStore.getState().applyServerUpsert(MACHINE_ID, { id: ws.id, name: ws.name, scope: {}, columns: stripLocal(ws.columns) });
      }
    }

    // …and then a STALE echo of the destination, snapshotted before the bind
    // landed (another browser's in-flight full-list read).
    useMachineWorkspaceStore.getState().applyServerUpsert(MACHINE_ID, {
      id: 'w2',
      name: destination.name,
      scope: {},
      columns: [
        {
          id: 'c2',
          panes: [
            { id: 'p2', scope: { name: 'other' } },
            { id: 'p3', scope: null },
          ],
        },
      ],
    });

    const machine = useMachineWorkspaceStore.getState().machines[MACHINE_ID];
    assert({
      given: 'a stale pre-bind echo of the view a session was moved into',
      should: 'keep the moved session bound, and keep its old view gone',
      actual: {
        source: machine.workspaces.w1 !== undefined,
        moved: machine.workspaces.w2.columns[0].panes.map((pane) => pane.scope),
      },
      expected: {
        source: false,
        moved: [{ name: 'other' }, { name: 'shell-a1', kind: 'terminal' }],
      },
    });
  });
});

import { describe, it, beforeEach } from 'vitest';
import { assert } from './riteway';

import { planPlaceSession, toWireColumns, type SessionView } from '../session-layout';
import {
  useMachineWorkspaceStore,
  sessionWorkspaceId,
  nodeScopeNames,
  type OpenTerminalScope,
} from '@/stores/machine-workspace/useMachineWorkspaceStore';

/**
 * The server's placement writer must produce the SAME layout blob the phase-1
 * client writer produces for the same act — that is the whole reason it
 * composes the client reducer rather than re-implementing "what a workspace
 * looks like". These cases drive the REAL client store (`openTerminal`,
 * `splitDown` + `bindPaneTerminal`) and byte-compare its resulting wire layout
 * against the server plan, with the client's own generated ids fed back in so
 * the only remaining difference would be a genuine shape difference.
 */

const MACHINE_ID = 'machine-page-1';

function resetStore(): void {
  useMachineWorkspaceStore.setState({ machines: {} });
}

/** The wire form of one of this browser's workspaces — what `useMachineWorkspaceSync` POSTs. */
function clientWire(workspaceId: string) {
  const workspace = useMachineWorkspaceStore.getState().machines[MACHINE_ID].workspaces[workspaceId];
  return {
    id: workspace.id,
    name: workspace.name,
    scope: nodeScopeNames(workspace.scope),
    columns: toWireColumns(workspace.columns),
  };
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

    assert({
      given: 'a session with no existing views',
      should: 'plan a create write identical to the client\'s born-bound workspace',
      actual: plan.ok ? plan.writes : plan,
      expected: [{ kind: 'create', ...client }],
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

    const view: SessionView = {
      id: before.id,
      name: before.name,
      projectName: null,
      branchName: null,
      columns: before.columns,
    };
    const plan = planPlaceSession([view], scope, { splitInto: workspaceId, direction: 'down' }, {
      paneId: newPaneId,
      columnId: 'unused-column-id',
    });

    assert({
      given: 'a split-down placement into a machine-scoped view',
      should: 'plan an update write whose columns match the client\'s split-and-bind result',
      actual: plan.ok ? plan.writes : plan,
      expected: [{ kind: 'update', id: workspaceId, columns: client.columns }],
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

    const plan = planPlaceSession([view], scope, { splitInto: view.id, direction: 'right' }, {
      paneId: 'pane-2',
      columnId: 'col-2',
    });

    assert({
      given: 'a project-scoped session split into a machine-root view',
      should: 'refuse as a cross-node placement',
      actual: plan,
      expected: { ok: false, reason: 'cross_node' },
    });
  });

  it('given a split into a view that does not exist, should refuse', () => {
    const scope: OpenTerminalScope = { name: 'shell-d4e5f6', kind: 'terminal' };

    const plan = planPlaceSession([], scope, { splitInto: 'gone', direction: 'down' }, {
      paneId: 'pane-2',
      columnId: 'col-2',
    });

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

    assert({
      given: 'a new-view placement for a session whose derived view still exists',
      should: 'bind the session into that view\'s empty pane, not create a duplicate',
      actual: plan.ok ? plan.writes : plan,
      expected: [
        {
          kind: 'update',
          id: workspaceId,
          columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: { name: scope.name, kind: 'terminal' } }] }],
        },
      ],
    });
  });
});

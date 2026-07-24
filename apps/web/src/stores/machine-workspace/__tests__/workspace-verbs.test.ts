import { describe, it } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import { applyVerbLocal, workspaceIdOf, type WorkspaceVerb } from '../workspace-verbs';
import { newWorkspace, panesOf, workspacesOf, type MachineWorkspacesState, type WorkspaceState } from '../workspace-reducer';

const BRANCH_SCOPE = { level: 'branch', projectName: 'app', branchName: 'main' } as const;

const aWorkspace = (id = 'ws-1', firstPaneId = 'pane-1'): WorkspaceState =>
  newWorkspace({ id, name: id, scope: BRANCH_SCOPE, firstPaneId });

const machineWith = (...workspaces: WorkspaceState[]): MachineWorkspacesState => ({
  workspaces: Object.fromEntries(workspaces.map((w) => [w.id, w])),
  order: workspaces.map((w) => w.id),
  activeWorkspaceId: workspaces[0]?.id ?? '',
});

const EMPTY_MACHINE: MachineWorkspacesState = { workspaces: {}, order: [], activeWorkspaceId: '' };

describe('applyVerbLocal: create-workspace', () => {
  it('born empty: adds a workspace with one empty pane and shows it', () => {
    const verb: WorkspaceVerb = {
      type: 'create-workspace',
      workspaceId: 'ws-1',
      name: 'Workspace 1',
      scope: {},
      firstPaneId: 'pane-1',
      session: null,
    };
    const outcome = applyVerbLocal(EMPTY_MACHINE, verb);
    assert({
      given: 'create-workspace with session: null',
      should: 'apply and open with one empty (unbound) pane',
      actual: { applied: outcome.applied, panes: panesOf(outcome.state.workspaces['ws-1']) },
      expected: { applied: true, panes: [{ id: 'pane-1', scope: null }] },
    });
  });

  it('born-bound: opens with the session already in the first pane', () => {
    const verb: WorkspaceVerb = {
      type: 'create-workspace',
      workspaceId: 'ws-1',
      name: 'claude-a1',
      scope: { projectName: 'repo' },
      firstPaneId: 'pane-1',
      session: { name: 'claude-a1', kind: 'chat' },
    };
    const outcome = applyVerbLocal(EMPTY_MACHINE, verb);
    assert({
      given: 'create-workspace with a session',
      should: 'open with that session bound in the first pane',
      actual: panesOf(outcome.state.workspaces['ws-1']),
      expected: [{ id: 'pane-1', scope: { name: 'claude-a1', kind: 'chat' } }],
    });
  });

  it('idempotent retry: an id that already exists is a no-op', () => {
    const existing = aWorkspace();
    const state = machineWith(existing);
    const verb: WorkspaceVerb = {
      type: 'create-workspace',
      workspaceId: 'ws-1',
      name: 'a different name',
      scope: {},
      firstPaneId: 'pane-x',
      session: null,
    };
    const outcome = applyVerbLocal(state, verb);
    assert({
      given: 'create-workspace retried for an id that already exists',
      should: 'not apply and leave the existing workspace untouched',
      actual: { applied: outcome.applied, state: outcome.state },
      expected: { applied: false, state },
    });
  });
});

describe('applyVerbLocal: rename-workspace', () => {
  it('renames an existing workspace', () => {
    const state = machineWith(aWorkspace());
    const outcome = applyVerbLocal(state, { type: 'rename-workspace', workspaceId: 'ws-1', name: 'Renamed' });
    assert({
      given: 'rename-workspace on an existing workspace',
      should: 'apply and update the name',
      actual: { applied: outcome.applied, name: outcome.state.workspaces['ws-1'].name },
      expected: { applied: true, name: 'Renamed' },
    });
  });

  it('renaming to the SAME name is a no-op', () => {
    const state = machineWith(aWorkspace());
    const outcome = applyVerbLocal(state, { type: 'rename-workspace', workspaceId: 'ws-1', name: 'ws-1' });
    assert({ given: 'rename-workspace to an unchanged name', should: 'not apply', actual: outcome.applied, expected: false });
  });

  it('an unknown workspace id is a no-op', () => {
    const outcome = applyVerbLocal(EMPTY_MACHINE, { type: 'rename-workspace', workspaceId: 'missing', name: 'X' });
    assert({ given: 'rename-workspace on an unknown id', should: 'not apply', actual: outcome, expected: { state: EMPTY_MACHINE, applied: false } });
  });
});

describe('applyVerbLocal: remove-workspace', () => {
  it('removes an existing workspace and reports the removed id', () => {
    const state = machineWith(aWorkspace());
    const outcome = applyVerbLocal(state, { type: 'remove-workspace', workspaceId: 'ws-1' });
    assert({
      given: 'remove-workspace on an existing workspace',
      should: 'apply, remove it, and report removedWorkspaceId',
      actual: { applied: outcome.applied, removedWorkspaceId: outcome.removedWorkspaceId, workspaces: workspacesOf(outcome.state) },
      expected: { applied: true, removedWorkspaceId: 'ws-1', workspaces: [] },
    });
  });

  it('an unknown workspace id is a no-op', () => {
    const outcome = applyVerbLocal(EMPTY_MACHINE, { type: 'remove-workspace', workspaceId: 'missing' });
    assert({ given: 'remove-workspace on an unknown id', should: 'not apply', actual: outcome.applied, expected: false });
  });
});

describe('applyVerbLocal: split-pane', () => {
  it('splits right, creating a new empty pane', () => {
    const state = machineWith(aWorkspace());
    const outcome = applyVerbLocal(state, {
      type: 'split-pane',
      workspaceId: 'ws-1',
      fromPaneId: 'pane-1',
      direction: 'right',
      newPaneId: 'pane-2',
    });
    assert({
      given: 'split-pane right with no session',
      should: 'apply and add an empty pane in a new column',
      actual: { applied: outcome.applied, panes: panesOf(outcome.state.workspaces['ws-1']) },
      expected: { applied: true, panes: [{ id: 'pane-1', scope: null }, { id: 'pane-2', scope: null }] },
    });
  });

  it('splits down with a session bound in the same verb (AI split-into placement)', () => {
    const state = machineWith(aWorkspace());
    const outcome = applyVerbLocal(state, {
      type: 'split-pane',
      workspaceId: 'ws-1',
      fromPaneId: 'pane-1',
      direction: 'down',
      newPaneId: 'pane-2',
      session: { name: 'claude-a1' },
    });
    assert({
      given: 'split-pane down with a session',
      should: 'apply and bind the session into the new pane — never unbound on the wire',
      actual: panesOf(outcome.state.workspaces['ws-1']).find((p) => p.id === 'pane-2'),
      expected: { id: 'pane-2', scope: { name: 'claude-a1' } },
    });
  });

  it('an unresolvable fromPaneId is a no-op', () => {
    const state = machineWith(aWorkspace());
    const outcome = applyVerbLocal(state, {
      type: 'split-pane',
      workspaceId: 'ws-1',
      fromPaneId: 'missing-pane',
      direction: 'right',
      newPaneId: 'pane-2',
    });
    assert({ given: 'split-pane from an unresolvable pane', should: 'not apply', actual: outcome, expected: { state, applied: false } });
  });

  it('an unknown workspace id is a no-op', () => {
    const outcome = applyVerbLocal(EMPTY_MACHINE, {
      type: 'split-pane',
      workspaceId: 'missing',
      fromPaneId: 'pane-1',
      direction: 'right',
      newPaneId: 'pane-2',
    });
    assert({ given: 'split-pane on an unknown workspace', should: 'not apply', actual: outcome.applied, expected: false });
  });
});

describe('applyVerbLocal: bind-pane', () => {
  it('binds a session into an empty pane', () => {
    const state = machineWith(aWorkspace());
    const outcome = applyVerbLocal(state, {
      type: 'bind-pane',
      workspaceId: 'ws-1',
      paneId: 'pane-1',
      session: { name: 'shell', kind: 'terminal' },
    });
    assert({
      given: 'bind-pane on an existing empty pane',
      should: 'apply and bind the session',
      actual: { applied: outcome.applied, panes: panesOf(outcome.state.workspaces['ws-1']) },
      expected: { applied: true, panes: [{ id: 'pane-1', scope: { name: 'shell', kind: 'terminal' } }] },
    });
  });

  it('always binds at the WORKSPACE\'s own node scope — a SessionRef carries no checkout, so cross-node binding is inexpressible on the wire', () => {
    const state = machineWith(aWorkspace());
    const outcome = applyVerbLocal(state, {
      type: 'bind-pane',
      workspaceId: 'ws-1',
      paneId: 'pane-1',
      session: { name: 'shell' },
    });
    assert({
      given: 'bind-pane, whose SessionRef has no project/branch fields',
      should: 'bind under the workspace\'s own scope without needing (or being able to express) a node match',
      actual: { applied: outcome.applied, panes: panesOf(outcome.state.workspaces['ws-1']) },
      expected: { applied: true, panes: [{ id: 'pane-1', scope: { name: 'shell' } }] },
    });
  });

  it('an unresolvable paneId is a no-op', () => {
    const state = machineWith(aWorkspace());
    const outcome = applyVerbLocal(state, {
      type: 'bind-pane',
      workspaceId: 'ws-1',
      paneId: 'missing-pane',
      session: { name: 'shell' },
    });
    assert({ given: 'bind-pane on an unresolvable pane', should: 'not apply', actual: outcome.applied, expected: false });
  });

  it('an unknown workspace id is a no-op', () => {
    const outcome = applyVerbLocal(EMPTY_MACHINE, {
      type: 'bind-pane',
      workspaceId: 'missing',
      paneId: 'pane-1',
      session: { name: 'shell' },
    });
    assert({ given: 'bind-pane on an unknown workspace', should: 'not apply', actual: outcome.applied, expected: false });
  });
});

describe('applyVerbLocal: close-pane', () => {
  it('closes one of several panes, leaving the workspace intact', () => {
    const withSplit = applyVerbLocal(machineWith(aWorkspace()), {
      type: 'split-pane',
      workspaceId: 'ws-1',
      fromPaneId: 'pane-1',
      direction: 'right',
      newPaneId: 'pane-2',
    }).state;
    const outcome = applyVerbLocal(withSplit, { type: 'close-pane', workspaceId: 'ws-1', paneId: 'pane-2' });
    assert({
      given: 'close-pane on a workspace with more than one pane',
      should: 'apply, remove just that pane, and NOT report a removed workspace',
      actual: { applied: outcome.applied, removedWorkspaceId: outcome.removedWorkspaceId, panes: panesOf(outcome.state.workspaces['ws-1']) },
      expected: { applied: true, removedWorkspaceId: undefined, panes: [{ id: 'pane-1', scope: null }] },
    });
  });

  it('closing the LAST pane removes the whole workspace and reports removedWorkspaceId', () => {
    const state = machineWith(aWorkspace());
    const outcome = applyVerbLocal(state, { type: 'close-pane', workspaceId: 'ws-1', paneId: 'pane-1' });
    assert({
      given: 'close-pane on a workspace\'s last pane',
      should: 'remove the whole workspace and report it as removed',
      actual: { applied: outcome.applied, removedWorkspaceId: outcome.removedWorkspaceId, workspaces: workspacesOf(outcome.state) },
      expected: { applied: true, removedWorkspaceId: 'ws-1', workspaces: [] },
    });
  });

  it('an unresolvable paneId is a no-op', () => {
    const state = machineWith(aWorkspace());
    const outcome = applyVerbLocal(state, { type: 'close-pane', workspaceId: 'ws-1', paneId: 'missing-pane' });
    assert({ given: 'close-pane on an unresolvable pane', should: 'not apply', actual: outcome, expected: { state, applied: false } });
  });

  it('an unknown workspace id is a no-op', () => {
    const outcome = applyVerbLocal(EMPTY_MACHINE, { type: 'close-pane', workspaceId: 'missing', paneId: 'pane-1' });
    assert({ given: 'close-pane on an unknown workspace', should: 'not apply', actual: outcome.applied, expected: false });
  });
});

describe('applyVerbLocal: add-pane (server-side showSessionIn)', () => {
  it('fills an empty pane with the session when one exists', () => {
    const state = machineWith(aWorkspace());
    const outcome = applyVerbLocal(state, {
      type: 'add-pane',
      workspaceId: 'ws-1',
      newPaneId: 'pane-unused',
      session: { name: 'claude-a1' },
    });
    assert({
      given: 'add-pane on a workspace with one empty pane',
      should: 'apply and bind the session into the existing empty pane, not mint a new one',
      actual: { applied: outcome.applied, panes: panesOf(outcome.state.workspaces['ws-1']) },
      expected: { applied: true, panes: [{ id: 'pane-1', scope: { name: 'claude-a1' } }] },
    });
  });

  it('splits a new pane for the session when no empty pane exists', () => {
    const bound = applyVerbLocal(machineWith(aWorkspace()), {
      type: 'bind-pane',
      workspaceId: 'ws-1',
      paneId: 'pane-1',
      session: { name: 'shell' },
    }).state;
    const outcome = applyVerbLocal(bound, {
      type: 'add-pane',
      workspaceId: 'ws-1',
      newPaneId: 'pane-2',
      session: { name: 'claude-a1' },
    });
    assert({
      given: 'add-pane on a workspace with no empty pane',
      should: 'apply and split a new pane for the session',
      actual: panesOf(outcome.state.workspaces['ws-1']).map((p) => p.scope),
      expected: [{ name: 'shell' }, { name: 'claude-a1' }],
    });
  });

  it('focuses the pane already showing the session, without duplicating it', () => {
    const bound = applyVerbLocal(machineWith(aWorkspace()), {
      type: 'bind-pane',
      workspaceId: 'ws-1',
      paneId: 'pane-1',
      session: { name: 'shell' },
    }).state;
    const outcome = applyVerbLocal(bound, {
      type: 'add-pane',
      workspaceId: 'ws-1',
      newPaneId: 'pane-unused',
      session: { name: 'shell' },
    });
    assert({
      given: 'add-pane for a session already shown in this workspace',
      should: 'focus the existing pane, not create another',
      actual: { activePaneId: outcome.state.workspaces['ws-1'].activePaneId, panes: panesOf(outcome.state.workspaces['ws-1']) },
      expected: { activePaneId: 'pane-1', panes: [{ id: 'pane-1', scope: { name: 'shell' } }] },
    });
  });

  it('an unknown workspace id is a no-op', () => {
    const outcome = applyVerbLocal(EMPTY_MACHINE, {
      type: 'add-pane',
      workspaceId: 'missing',
      newPaneId: 'pane-1',
      session: { name: 'shell' },
    });
    assert({ given: 'add-pane on an unknown workspace', should: 'not apply', actual: outcome.applied, expected: false });
  });
});

describe('workspaceIdOf', () => {
  it('extracts the workspaceId from any verb shape', () => {
    const verbs: WorkspaceVerb[] = [
      { type: 'create-workspace', workspaceId: 'a', name: 'A', scope: {}, firstPaneId: 'p', session: null },
      { type: 'rename-workspace', workspaceId: 'b', name: 'B' },
      { type: 'remove-workspace', workspaceId: 'c' },
      { type: 'split-pane', workspaceId: 'd', fromPaneId: 'p1', direction: 'right', newPaneId: 'p2' },
      { type: 'bind-pane', workspaceId: 'e', paneId: 'p1', session: { name: 'shell' } },
      { type: 'close-pane', workspaceId: 'f', paneId: 'p1' },
      { type: 'add-pane', workspaceId: 'g', newPaneId: 'p1', session: { name: 'shell' } },
    ];
    assert({
      given: 'every verb shape',
      should: 'return each one\'s workspaceId',
      actual: verbs.map(workspaceIdOf),
      expected: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    });
  });
});

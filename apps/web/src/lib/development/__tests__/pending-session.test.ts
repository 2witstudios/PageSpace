import { describe, test, expect } from 'vitest';
import type { WorkspaceState } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import { resolvePendingSession, type PendingSession } from '../pending-session';

const SCOPE = { projectName: 'repo', branchName: 'main', name: 'agent-1' };
const PENDING: PendingSession = { machineId: 'machine-1', scope: SCOPE };

/** A workspace whose active pane holds `scope` (null = a fresh, empty pane). */
const workspaceWith = (scope: WorkspaceState['columns'][number]['panes'][number]['scope']): WorkspaceState => ({
  columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope }] }],
  activePaneId: 'pane-1',
});

describe('resolvePendingSession', () => {
  test('opens the session once the target machine has a workspace', () => {
    expect(resolvePendingSession(PENDING, 'machine-1', workspaceWith(null))).toEqual({
      type: 'open',
      machineId: 'machine-1',
      scope: SCOPE,
    });
  });

  test('holds the intent while the machine has no workspace yet', () => {
    // The pane region mounts after the navigation lands; the intent waits for it
    // rather than being written into a workspace that does not exist.
    expect(resolvePendingSession(PENDING, 'machine-1', undefined)).toEqual({ type: 'wait' });
  });

  test('re-opens against a workspace that was torn down and rebuilt', () => {
    // The bug this guards: MachineWorkspace disposes on unmount and re-creates on
    // mount (StrictMode double-invokes this on the first visit). A fire-once
    // intent would be destroyed by the rebuild; a convergent one re-applies.
    const rebuiltEmpty = workspaceWith(null);

    expect(resolvePendingSession(PENDING, 'machine-1', rebuiltEmpty)).toEqual({
      type: 'open',
      machineId: 'machine-1',
      scope: SCOPE,
    });
  });

  test('clears once the session is actually in the active pane', () => {
    expect(resolvePendingSession(PENDING, 'machine-1', workspaceWith(SCOPE))).toEqual({ type: 'clear' });
  });

  test('a satisfied intent is dropped, so it cannot clobber the user\'s next pane change', () => {
    const satisfied = resolvePendingSession(PENDING, 'machine-1', workspaceWith(SCOPE));
    expect(satisfied).toEqual({ type: 'clear' });
    // And with no intent left, nothing is ever re-applied.
    expect(resolvePendingSession(null, 'machine-1', workspaceWith({ ...SCOPE, name: 'agent-2' }))).toEqual({
      type: 'clear',
    });
  });

  test('drops the intent when the user navigated to a different machine', () => {
    expect(resolvePendingSession(PENDING, 'machine-2', workspaceWith(null))).toEqual({ type: 'clear' });
  });

  test('drops the intent when the user left the surface entirely', () => {
    expect(resolvePendingSession(PENDING, null, workspaceWith(null))).toEqual({ type: 'clear' });
  });

  test('distinguishes same-named sessions at different scopes', () => {
    // A machine-scope "agent-1" is not the branch-scope "agent-1"; treating them
    // as the same would report the intent satisfied by the wrong session.
    const machineScoped = workspaceWith({ name: 'agent-1' });

    expect(resolvePendingSession(PENDING, 'machine-1', machineScoped)).toEqual({
      type: 'open',
      machineId: 'machine-1',
      scope: SCOPE,
    });
  });

  test('no intent is a no-op', () => {
    expect(resolvePendingSession(null, 'machine-1', undefined)).toEqual({ type: 'clear' });
  });
});

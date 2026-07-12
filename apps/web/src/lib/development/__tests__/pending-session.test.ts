import { describe, test, expect } from 'vitest';
import type { WorkspaceState } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import { resolvePendingSession, type PendingSession } from '../pending-session';

const SCOPE = { projectName: 'repo', branchName: 'main', name: 'agent-1' };
/** Clicked on machine-1's tree while machine-1 was already the open machine. */
const PENDING: PendingSession = { machineId: 'machine-1', scope: SCOPE, fromMachineId: 'machine-1' };
/** Clicked on machine-1's tree while machine-9 was the open machine — the navigation is in flight. */
const PENDING_FROM_ELSEWHERE: PendingSession = { machineId: 'machine-1', scope: SCOPE, fromMachineId: 'machine-9' };

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

  test('HOLDS the intent while the click\'s own navigation is still in flight', () => {
    // The bug this guards, and the reason the surface's headline flow was
    // silently dead: the click (a store write) lands in the SYNC lane, while
    // router.push dispatches inside a TRANSITION. React commits the sync update
    // first, so there is an intermediate commit holding the new intent and the
    // OLD pathname — selectedMachineId is still the machine we came FROM.
    // Reading that as "the user navigated away" threw the intent away before the
    // navigation it was waiting for ever arrived.
    expect(resolvePendingSession(PENDING_FROM_ELSEWHERE, 'machine-9', undefined)).toEqual({ type: 'wait' });
  });

  test('opens once that navigation lands', () => {
    expect(resolvePendingSession(PENDING_FROM_ELSEWHERE, 'machine-1', workspaceWith(null))).toEqual({
      type: 'open',
      machineId: 'machine-1',
      scope: SCOPE,
    });
  });

  test('drops the intent when the user genuinely goes to a THIRD machine', () => {
    // Neither the target nor the origin — a real navigation away, not a pending one.
    expect(resolvePendingSession(PENDING_FROM_ELSEWHERE, 'machine-2', workspaceWith(null))).toEqual({
      type: 'clear',
    });
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

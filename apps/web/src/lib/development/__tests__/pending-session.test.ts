import { describe, test, expect } from 'vitest';
import type { WorkspaceState } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import { resolvePendingSession, type PendingSession } from '../pending-session';

const SCOPE = { projectName: 'repo', branchName: 'main', name: 'agent-1' };
const PENDING: PendingSession = { machineId: 'machine-1', scope: SCOPE };

/** A workspace whose active pane holds `scope` (null = a fresh, empty pane). */
const workspaceWith = (scope: WorkspaceState['columns'][number]['panes'][number]['scope']): WorkspaceState => ({
  id: 'ws-1',
  name: 'Workspace 1',
  scope: {},
  columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope }] }],
  activePaneId: 'pane-1',
  pendingPickerPaneId: null,
});

describe('resolvePendingSession', () => {
  test('opens the session once the user is on the machine and it has a workspace', () => {
    // Also the rebuild case: MachineWorkspace disposes on unmount and re-creates on
    // mount (StrictMode double-invokes exactly this on the first visit), so the
    // intent must still resolve to `open` against a fresh, empty workspace rather
    // than being a one-shot that the rebuild destroys.
    expect(resolvePendingSession(PENDING, 'machine-1', workspaceWith(null))).toEqual({
      type: 'open',
      machineId: 'machine-1',
      scope: SCOPE,
    });
  });

  test('holds while the click\'s own navigation is still in flight', () => {
    // The bug this guards, and the reason the surface's headline flow was
    // silently dead: the click (a store write) lands in React's SYNC lane, while
    // router.push dispatches inside a TRANSITION. React commits the sync update
    // first, so there is an intermediate commit holding the new intent and the
    // OLD pathname. Reading that as "the user navigated away" threw the intent
    // away before the navigation it was waiting for ever arrived.
    expect(resolvePendingSession(PENDING, 'machine-9', undefined)).toEqual({ type: 'wait' });
  });

  test('holds until the machine\'s pane region has mounted', () => {
    expect(resolvePendingSession(PENDING, 'machine-1', undefined)).toEqual({ type: 'wait' });
  });

  test('clears once the session is actually in the active pane', () => {
    expect(resolvePendingSession(PENDING, 'machine-1', workspaceWith(SCOPE))).toEqual({ type: 'clear' });
  });

  test('a satisfied intent is dropped, so it cannot clobber the user\'s next pane change', () => {
    // With no intent left, nothing is ever re-applied over the user's own choice.
    expect(
      resolvePendingSession(null, 'machine-1', workspaceWith({ ...SCOPE, name: 'agent-2' })),
    ).toEqual({ type: 'clear' });
  });

  test('distinguishes same-named sessions at different scopes', () => {
    // A machine-scope "agent-1" is not the branch-scope "agent-1"; treating them
    // as the same would report the intent satisfied by the wrong session.
    expect(resolvePendingSession(PENDING, 'machine-1', workspaceWith({ name: 'agent-1' }))).toEqual({
      type: 'open',
      machineId: 'machine-1',
      scope: SCOPE,
    });
  });

  test('no intent is a no-op', () => {
    expect(resolvePendingSession(null, 'machine-1', undefined)).toEqual({ type: 'clear' });
  });
});

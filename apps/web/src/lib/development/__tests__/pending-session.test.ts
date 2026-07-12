import { describe, test, expect } from 'vitest';
import type { WorkspaceState } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import {
  resolvePendingSession,
  PENDING_SESSION_TTL_MS,
  type PendingSession,
} from '../pending-session';

const NOW = 1_000_000;
const SCOPE = { projectName: 'repo', branchName: 'main', name: 'agent-1' };
const PENDING: PendingSession = { machineId: 'machine-1', scope: SCOPE, createdAt: NOW };

/** A workspace whose active pane holds `scope` (null = a fresh, empty pane). */
const workspaceWith = (scope: WorkspaceState['columns'][number]['panes'][number]['scope']): WorkspaceState => ({
  columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope }] }],
  activePaneId: 'pane-1',
});

describe('resolvePendingSession', () => {
  test('opens the session once the user is on the machine and it has a workspace', () => {
    expect(resolvePendingSession(PENDING, 'machine-1', workspaceWith(null), NOW)).toEqual({
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
    expect(resolvePendingSession(PENDING, 'machine-9', undefined, NOW)).toEqual({ type: 'wait' });
  });

  test('holds until the machine\'s pane region has mounted', () => {
    expect(resolvePendingSession(PENDING, 'machine-1', undefined, NOW)).toEqual({ type: 'wait' });
  });

  test('re-opens against a workspace that was torn down and rebuilt', () => {
    // MachineWorkspace disposes on unmount and re-creates on mount (StrictMode
    // double-invokes exactly this on the first visit). A fire-once intent would
    // be destroyed by the rebuild; a convergent one re-applies to the new one.
    expect(resolvePendingSession(PENDING, 'machine-1', workspaceWith(null), NOW)).toEqual({
      type: 'open',
      machineId: 'machine-1',
      scope: SCOPE,
    });
  });

  test('clears once the session is actually in the active pane', () => {
    expect(resolvePendingSession(PENDING, 'machine-1', workspaceWith(SCOPE), NOW)).toEqual({ type: 'clear' });
  });

  test('expires rather than lying in wait to hijack a pane later', () => {
    // The leak this closes: an intent that never converged (the machine never
    // mounted, or the user turned back) used to be held indefinitely in a
    // module-level store. Returning to that machine much later — warm, with a
    // terminal running in its active pane — would fire the stale intent and
    // overwrite that pane. Past the TTL it is simply dropped.
    const stale = resolvePendingSession(
      PENDING,
      'machine-1',
      workspaceWith({ name: 'something-the-user-is-using' }),
      NOW + PENDING_SESSION_TTL_MS + 1,
    );

    expect(stale).toEqual({ type: 'clear' });
  });

  test('a slow-but-live navigation is not expired', () => {
    expect(resolvePendingSession(PENDING, 'machine-1', workspaceWith(null), NOW + PENDING_SESSION_TTL_MS - 1)).toEqual({
      type: 'open',
      machineId: 'machine-1',
      scope: SCOPE,
    });
  });

  test('a satisfied intent is dropped, so it cannot clobber the user\'s next pane change', () => {
    expect(resolvePendingSession(PENDING, 'machine-1', workspaceWith(SCOPE), NOW)).toEqual({ type: 'clear' });
    // And with no intent left, nothing is ever re-applied.
    expect(
      resolvePendingSession(null, 'machine-1', workspaceWith({ ...SCOPE, name: 'agent-2' }), NOW),
    ).toEqual({ type: 'clear' });
  });

  test('distinguishes same-named sessions at different scopes', () => {
    // A machine-scope "agent-1" is not the branch-scope "agent-1"; treating them
    // as the same would report the intent satisfied by the wrong session.
    expect(resolvePendingSession(PENDING, 'machine-1', workspaceWith({ name: 'agent-1' }), NOW)).toEqual({
      type: 'open',
      machineId: 'machine-1',
      scope: SCOPE,
    });
  });

  test('no intent is a no-op', () => {
    expect(resolvePendingSession(null, 'machine-1', undefined, NOW)).toEqual({ type: 'clear' });
  });
});

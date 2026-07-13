import { describe, test, expect } from 'vitest';
import { resolvePendingWorkspace, type PendingWorkspace } from '../pending-workspace';

const PENDING: PendingWorkspace = { machineId: 'machine-1', workspaceId: 'ws-1' };

describe('resolvePendingWorkspace', () => {
  test('selects the workspace once the user is on the machine and it has a workspace set', () => {
    // Also the rebuild case: StrictMode double-invokes the machine's mount
    // effect on first visit, so the intent must still resolve to `select`
    // against a freshly-ensured workspace set rather than being a one-shot.
    expect(resolvePendingWorkspace(PENDING, 'machine-1', 'ws-other')).toEqual({
      type: 'select',
      machineId: 'machine-1',
      workspaceId: 'ws-1',
    });
  });

  test('holds while the click\'s own navigation is still in flight', () => {
    // The bug this guards, and the reason the surface's headline flow was
    // silently dead: the click (a store write) lands in React's SYNC lane, while
    // router.push dispatches inside a TRANSITION. React commits the sync update
    // first, so there is an intermediate commit holding the new intent and the
    // OLD pathname. Reading that as "the user navigated away" threw the intent
    // away before the navigation it was waiting for ever arrived.
    expect(resolvePendingWorkspace(PENDING, 'machine-9', undefined)).toEqual({ type: 'wait' });
  });

  test('holds until the machine\'s pane region has mounted', () => {
    expect(resolvePendingWorkspace(PENDING, 'machine-1', undefined)).toEqual({ type: 'wait' });
  });

  test('clears once the workspace is already the active one', () => {
    expect(resolvePendingWorkspace(PENDING, 'machine-1', 'ws-1')).toEqual({ type: 'clear' });
  });

  test('a satisfied intent is dropped, so it cannot clobber the user\'s next workspace switch', () => {
    // With no intent left, nothing is ever re-applied over the user's own choice.
    expect(resolvePendingWorkspace(null, 'machine-1', 'ws-2')).toEqual({ type: 'clear' });
  });

  test('no intent is a no-op', () => {
    expect(resolvePendingWorkspace(null, 'machine-1', undefined)).toEqual({ type: 'clear' });
  });
});

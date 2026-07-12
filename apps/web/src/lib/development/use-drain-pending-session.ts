'use client';

import { useEffect } from 'react';
import { useMachineWorkspaceStore } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import { usePendingSessionStore } from '@/stores/development/usePendingSessionStore';
import { resolvePendingSession } from '@/lib/development/pending-session';

/**
 * Honours a session the user clicked in the sidebar, once the machine it
 * belongs to actually has a workspace to open it into. Shared by every
 * Development surface's layout (drive-scoped and global) — the decision is
 * drive-agnostic, since a pending session names only a machine id and a scope.
 *
 * The decision is the pure `resolvePendingSession`; this is the plumbing. It
 * re-evaluates whenever the workspace changes, so an intent applied against a
 * workspace that is then torn down and rebuilt (a remount — StrictMode's
 * double-invoke does this on first mount) re-applies to the new one instead of
 * being silently lost.
 *
 * Leaving the surface drops any unconverged intent: the store is a module
 * singleton, so an intent left behind here would otherwise still be sitting
 * there on the user's next visit, ready to fire into whatever pane was active.
 */
export function useDrainPendingSession(displayedMachineId: string | null) {
  const pending = usePendingSessionStore((state) => state.pending);
  const clearPending = usePendingSessionStore((state) => state.clearPending);
  const openTerminal = useMachineWorkspaceStore((state) => state.openTerminal);
  const workspace = useMachineWorkspaceStore((state) =>
    pending ? state.workspaces[pending.machineId] : undefined,
  );

  useEffect(() => {
    const action = resolvePendingSession(pending, displayedMachineId, workspace);
    if (action.type === 'open') openTerminal(action.machineId, action.scope);
    // A 'clear' with no pending intent is a no-op, so this cannot loop.
    else if (action.type === 'clear') clearPending();
  }, [pending, displayedMachineId, workspace, openTerminal, clearPending]);

  useEffect(() => () => clearPending(), [clearPending]);
}

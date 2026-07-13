'use client';

import { useEffect } from 'react';
import { useMachineWorkspaceStore, selectActiveWorkspace } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import { usePendingSessionStore } from '@/stores/development/usePendingSessionStore';
import { resolvePendingSession } from '@/lib/development/pending-session';

/**
 * Honours a session the user clicked in the sidebar, once the machine it
 * belongs to actually has a workspace to open it into. Shared by every
 * Development surface's layout (drive-scoped and global) — the decision is
 * drive-agnostic, since a pending session names only a machine id and a scope.
 *
 * The decision is the pure `resolvePendingSession`; this is the plumbing. It
 * re-evaluates whenever the workspace on screen changes, so an intent that has
 * not converged yet — the pane region has not mounted, or the user is en route —
 * is re-applied as soon as it can be, instead of being silently lost.
 *
 * Leaving the surface drops any unconverged intent: the store is a module
 * singleton, so an intent left behind here would otherwise still be sitting
 * there on the user's next visit, ready to fire into whatever pane was active.
 */
export function useDrainPendingSession(displayedMachineId: string | null) {
  const pending = usePendingSessionStore((state) => state.pending);
  const clearPending = usePendingSessionStore((state) => state.clearPending);
  const openTerminal = useMachineWorkspaceStore((state) => state.openTerminal);
  // The machine's ACTIVE workspace — the grid the middle view is actually
  // showing. A machine now holds many workspaces (each sidebar item owns one),
  // and the intent converges when the session it names is in the active pane of
  // the workspace on screen.
  const workspace = useMachineWorkspaceStore((state) =>
    pending ? selectActiveWorkspace(pending.machineId)(state) : undefined,
  );

  useEffect(() => {
    const action = resolvePendingSession(pending, displayedMachineId, workspace);
    if (action.type === 'open') openTerminal(action.machineId, action.scope);
    // A 'clear' with no pending intent is a no-op, so this cannot loop.
    else if (action.type === 'clear') clearPending();
  }, [pending, displayedMachineId, workspace, openTerminal, clearPending]);

  useEffect(() => () => clearPending(), [clearPending]);
}

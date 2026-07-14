'use client';

import { useEffect } from 'react';
import { useMachineWorkspaceStore, selectMachine } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import { usePendingWorkspaceStore } from '@/stores/development/usePendingWorkspaceStore';
import { resolvePendingWorkspace } from '@/lib/development/pending-workspace';

/**
 * Honours a workspace the user clicked in the sidebar, once the machine it
 * belongs to actually has that workspace to activate. Shared by every
 * Development surface's layout (drive-scoped and global) — the decision is
 * drive-agnostic, since a pending workspace names only a machine id and a
 * workspace id.
 *
 * The decision is the pure `resolvePendingWorkspace`; this is the plumbing. It
 * re-evaluates whenever the machine's active workspace changes, so an intent
 * that has not converged yet — the pane region has not mounted, or the user is
 * en route — is re-applied as soon as it can be, instead of being silently
 * lost.
 *
 * Leaving the surface drops any unconverged intent: the store is a module
 * singleton, so an intent left behind here would otherwise still be sitting
 * there on the user's next visit, ready to fire into whatever machine was active.
 */
export function useDrainPendingWorkspace(displayedMachineId: string | null) {
  const pending = usePendingWorkspaceStore((state) => state.pending);
  const clearPending = usePendingWorkspaceStore((state) => state.clearPending);
  const setActiveWorkspace = useMachineWorkspaceStore((state) => state.setActiveWorkspace);
  // The machine's current `activeWorkspaceId` — undefined until its pane region
  // has mounted and ensured a workspace set. A machine now holds many
  // workspaces (each sidebar item owns one), and the intent converges when this
  // matches the one the user clicked.
  const activeWorkspaceId = useMachineWorkspaceStore((state) =>
    pending ? selectMachine(pending.machineId)(state)?.activeWorkspaceId : undefined,
  );

  useEffect(() => {
    const action = resolvePendingWorkspace(pending, displayedMachineId, activeWorkspaceId);
    if (action.type === 'select') setActiveWorkspace(action.machineId, action.workspaceId);
    // A 'clear' with no pending intent is a no-op, so this cannot loop.
    else if (action.type === 'clear') clearPending();
  }, [pending, displayedMachineId, activeWorkspaceId, setActiveWorkspace, clearPending]);

  useEffect(() => () => clearPending(), [clearPending]);
}

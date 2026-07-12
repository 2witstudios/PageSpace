import type { OpenTerminalScope, WorkspaceState } from '@/stores/machine-workspace/useMachineWorkspaceStore';

/** A session the user clicked in the Development sidebar, to be opened on the machine it belongs to. */
export interface PendingSession {
  machineId: string;
  scope: OpenTerminalScope;
}

export type PendingSessionAction =
  /** The user isn't on that machine yet, or its pane region isn't there — hold. */
  | { type: 'wait' }
  /** Apply the intent (idempotent: `openTerminal` sets the active pane's scope). */
  | { type: 'open'; machineId: string; scope: OpenTerminalScope }
  /** Done, superseded, or expired — drop the intent. */
  | { type: 'clear' };

function sameScope(a: OpenTerminalScope | null, b: OpenTerminalScope): boolean {
  return (
    a !== null &&
    a.name === b.name &&
    (a.projectName ?? null) === (b.projectName ?? null) &&
    (a.branchName ?? null) === (b.branchName ?? null)
  );
}

function activePaneScope(workspace: WorkspaceState): OpenTerminalScope | null {
  for (const column of workspace.columns) {
    for (const pane of column.panes) {
      if (pane.id === workspace.activePaneId) return pane.scope;
    }
  }
  return null;
}

/**
 * What to do with a sidebar session-click intent, given where the user now is
 * and whether the target machine's workspace exists yet.
 *
 * Two things make this trickier than it looks, and both were live bugs:
 *
 * 1. The intent CANNOT be applied when it is made. The clicked session may
 *    belong to a machine whose pane region isn't mounted, and writing a pane
 *    into the store ahead of that mount does not survive: `MachineWorkspace`
 *    disposes its workspace on unmount and rebuilds it on mount, destroying
 *    anything authored early. So the intent is held and re-evaluated as state
 *    arrives, and it CONVERGES rather than firing once — it keeps asking until
 *    the workspace reports the session in its active pane. That is what makes it
 *    survive the workspace being torn down and rebuilt underneath it (React
 *    StrictMode does exactly this on first mount). Re-applying is harmless
 *    because `openTerminal` is idempotent.
 *
 * 2. "The user isn't on that machine yet" and "the user went somewhere else"
 *    are INDISTINGUISHABLE from a single commit — both are just
 *    `selectedMachineId !== pending.machineId`. They can't be told apart because
 *    the click (a store write) lands in React's sync lane while `router.push`
 *    dispatches in a transition, so there is a commit holding the new intent and
 *    the old pathname. An earlier version treated that commit as "navigated
 *    away" and dropped the intent before its own navigation landed — which
 *    silently broke every session click on a machine the user wasn't already
 *    viewing. So a mismatch WAITS.
 *
 * An intent that never converges is therefore held — but it cannot outlive its
 * usefulness, because the two things that would make it stale both clear it
 * outright: leaving the surface (the layout clears on unmount) and picking a
 * machine ROW rather than one of its sessions (the sidebar clears, since that
 * says "this machine as it is"). Once satisfied it clears too, so the user's own
 * later pane changes are never clobbered.
 */
export function resolvePendingSession(
  pending: PendingSession | null,
  selectedMachineId: string | null,
  workspace: WorkspaceState | undefined,
): PendingSessionAction {
  if (!pending) return { type: 'clear' };

  // Not there yet: either the click's own navigation hasn't committed, or the
  // user is en route. Holding is safe — see the note above on what clears it.
  if (pending.machineId !== selectedMachineId) return { type: 'wait' };

  // On the machine, but its pane region hasn't mounted (and ensured a workspace).
  if (!workspace) return { type: 'wait' };

  // Satisfied: the session is in the active pane.
  if (sameScope(activePaneScope(workspace), pending.scope)) return { type: 'clear' };

  return { type: 'open', machineId: pending.machineId, scope: pending.scope };
}

/** A workspace the user clicked in the Development sidebar, to be activated on the machine it belongs to. */
export interface PendingWorkspace {
  machineId: string;
  workspaceId: string;
}

export type PendingWorkspaceAction =
  /** The user isn't on that machine yet, or its pane region isn't there — hold. */
  | { type: 'wait' }
  /** Apply the intent (idempotent: `setActiveWorkspace` is a no-op once already active). */
  | { type: 'select'; machineId: string; workspaceId: string }
  /** Done, superseded, or expired — drop the intent. */
  | { type: 'clear' };

/**
 * What to do with a sidebar workspace-click intent, given where the user now is
 * and whether the target machine's workspace set exists yet.
 *
 * Mirrors the two subtleties that made the session-click version of this
 * (`resolvePendingSession`) tricky, both still live here:
 *
 * 1. The intent CANNOT be applied when it is made. The clicked workspace may
 *    belong to a machine whose pane region isn't mounted, so its store entry
 *    may not exist yet either. The intent is therefore held and re-evaluated as
 *    state arrives, and it CONVERGES rather than firing once — it keeps asking
 *    until the machine's `activeWorkspaceId` matches. Converging is also what
 *    makes it survive a remount of the pane region, which React StrictMode does
 *    on first mount. Re-applying is harmless because `setActiveWorkspace` is
 *    idempotent.
 *
 * 2. "The user isn't on that machine yet" and "the user went somewhere else"
 *    are INDISTINGUISHABLE from a single commit — both are just
 *    `selectedMachineId !== pending.machineId`. They can't be told apart because
 *    the click (a store write) lands in React's sync lane while `router.push`
 *    dispatches in a transition, so there is a commit holding the new intent and
 *    the old pathname. So a mismatch WAITS rather than being read as "navigated
 *    away".
 *
 * An intent that never converges is therefore held — but it cannot outlive its
 * usefulness, because the two things that would make it stale both clear it
 * outright: leaving the surface (the layout clears on unmount) and picking a
 * machine ROW rather than one of its workspaces (the sidebar clears, since that
 * says "this machine as it is"). Once satisfied it clears too, so the user's own
 * later workspace switches are never clobbered.
 */
export function resolvePendingWorkspace(
  pending: PendingWorkspace | null,
  selectedMachineId: string | null,
  activeWorkspaceId: string | undefined,
): PendingWorkspaceAction {
  if (!pending) return { type: 'clear' };

  // Not there yet: either the click's own navigation hasn't committed, or the
  // user is en route. Holding is safe — see the note above on what clears it.
  if (pending.machineId !== selectedMachineId) return { type: 'wait' };

  // On the machine, but its pane region hasn't mounted (and ensured a workspace set).
  if (activeWorkspaceId === undefined) return { type: 'wait' };

  // Satisfied: the workspace is already the one on screen.
  if (activeWorkspaceId === pending.workspaceId) return { type: 'clear' };

  return { type: 'select', machineId: pending.machineId, workspaceId: pending.workspaceId };
}

import type { OpenTerminalScope, WorkspaceState } from '@/stores/machine-workspace/useMachineWorkspaceStore';

/** A session the user clicked in the Development sidebar, to be opened on the machine it belongs to. */
export interface PendingSession {
  machineId: string;
  scope: OpenTerminalScope;
  /**
   * The machine that was selected when the click happened (null = none).
   *
   * This is what lets "my navigation hasn't landed yet" be told apart from "the
   * user went somewhere else" — two states that otherwise look identical, since
   * both simply have `selectedMachineId !== pending.machineId`.
   *
   * They must be told apart, because the click and the navigation land in
   * DIFFERENT React lanes: `requestSession` is a plain store write (sync lane),
   * while `router.push` dispatches inside a transition. React commits the sync
   * update first, so there is an intermediate commit holding the NEW intent and
   * the OLD pathname. Treating that commit as "navigated away" drops the intent
   * before the navigation it is waiting for ever arrives — which silently broke
   * every session click on a machine the user wasn't already viewing.
   */
  fromMachineId: string | null;
}

export type PendingSessionAction =
  /** The machine's pane region isn't there yet — hold the intent. */
  | { type: 'wait' }
  /** Apply the intent (idempotent: `openTerminal` sets the active pane's scope). */
  | { type: 'open'; machineId: string; scope: OpenTerminalScope }
  /** Done, or moot — drop the intent. */
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
 * A clicked session belongs to a machine whose pane region may not be mounted —
 * the user could be on another machine, or on none. Authoring the pane straight
 * into the store before that machine mounts does not survive: `MachineWorkspace`
 * disposes its workspace on unmount and re-creates it on mount, so a pane
 * written ahead of the mount is destroyed by the very component meant to display
 * it (React's StrictMode double-invoke makes this bite on the first visit, and a
 * remount would do the same in production).
 *
 * So the intent is HELD instead, and re-evaluated as state arrives. This
 * converges rather than fires once: it keeps asking to open until the workspace
 * actually reports the session in its active pane, at which point the intent is
 * satisfied and dropped. That is what makes it robust to the workspace being
 * torn down and rebuilt underneath it — the intent simply re-applies to the new
 * workspace. Being idempotent, a repeat `open` is harmless.
 *
 * Once satisfied, the intent is cleared, so the user's own later pane changes on
 * that machine are never clobbered by a stale intent.
 */
export function resolvePendingSession(
  pending: PendingSession | null,
  selectedMachineId: string | null,
  workspace: WorkspaceState | undefined,
): PendingSessionAction {
  if (!pending) return { type: 'clear' };

  if (pending.machineId !== selectedMachineId) {
    // Still where we were when the session was clicked: the router's transition
    // simply hasn't committed yet. Hold — this is NOT the user navigating away.
    if (selectedMachineId === pending.fromMachineId) return { type: 'wait' };
    // A different machine than either the target or the origin: the user chose
    // to go elsewhere, so the intent is moot.
    return { type: 'clear' };
  }

  if (!workspace) return { type: 'wait' };
  // Satisfied: the session is in the active pane.
  if (sameScope(activePaneScope(workspace), pending.scope)) return { type: 'clear' };
  return { type: 'open', machineId: pending.machineId, scope: pending.scope };
}

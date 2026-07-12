'use client';

import { useEffect } from 'react';
import { useParams, usePathname } from 'next/navigation';
import MachineKeepAliveHost from '@/components/layout/middle-content/MachineKeepAliveHost';
import { useMachineWorkspaceStore } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import { usePendingSessionStore } from '@/stores/development/usePendingSessionStore';
import { parseSelectedMachineId } from '@/lib/development/development-route';
import { resolvePendingSession } from '@/lib/development/pending-session';

/**
 * The Development surface's detail region.
 *
 * Machines are rendered by {@link MachineKeepAliveHost}, NOT by the
 * `[machineId]` route — exactly as the drive view does it (see `CenterPanel`,
 * which likewise refuses to render `MachineView` inline). The route segment
 * remounts on every machine-to-machine navigation, so a `MachineView` rendered
 * from it would tear its xterm buffer, its socket, and its workspace down each
 * time you clicked another machine — on the one surface whose entire purpose is
 * keeping terminals alive. The host instead keeps a bounded LRU of machines
 * mounted and CSS-hides the inactive ones, so switching machines is instant and
 * the sessions you left running are still running.
 *
 * This layout sits ABOVE the `[machineId]` segment, so it (and the host, and
 * every warm machine) survives that navigation.
 */
export default function DevelopmentLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const pathname = usePathname() ?? '';
  const driveIdParams = params.driveId;
  const driveId = Array.isArray(driveIdParams) ? driveIdParams[0] : driveIdParams;
  const selectedMachineId = parseSelectedMachineId(pathname, driveId);

  useDrainPendingSession(selectedMachineId);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {children}
      <MachineKeepAliveHost driveId={driveId} activePageId={selectedMachineId} />
    </div>
  );
}

/**
 * Honours a session the user clicked in the sidebar, once the machine it belongs
 * to actually has a workspace to open it into.
 *
 * The decision is the pure `resolvePendingSession`; this is the plumbing. It
 * re-evaluates whenever the workspace changes, so an intent applied against a
 * workspace that is then torn down and rebuilt (a remount — StrictMode's
 * double-invoke does this on first mount) re-applies to the new one instead of
 * being silently lost.
 */
function useDrainPendingSession(selectedMachineId: string | null) {
  const pending = usePendingSessionStore((state) => state.pending);
  const clearPending = usePendingSessionStore((state) => state.clearPending);
  const openTerminal = useMachineWorkspaceStore((state) => state.openTerminal);
  const workspace = useMachineWorkspaceStore((state) =>
    pending ? state.workspaces[pending.machineId] : undefined,
  );

  useEffect(() => {
    const action = resolvePendingSession(pending, selectedMachineId, workspace);
    if (action.type === 'open') openTerminal(action.machineId, action.scope);
    // 'clear' with no pending intent is a no-op, so this cannot loop.
    else if (action.type === 'clear') clearPending();
  }, [pending, selectedMachineId, workspace, openTerminal, clearPending]);
}

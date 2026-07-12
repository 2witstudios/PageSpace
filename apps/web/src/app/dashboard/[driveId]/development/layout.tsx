'use client';

import { useEffect, useMemo } from 'react';
import { useParams, usePathname } from 'next/navigation';
import { Cpu } from 'lucide-react';
import MachineKeepAliveHost from '@/components/layout/middle-content/MachineKeepAliveHost';
import { useAuth } from '@/hooks/useAuth';
import { useDriveMachines } from '@/hooks/useDriveMachines';
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

  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  // Same SWR key (and same admin gate) as the sidebar, so this is a cache read
  // rather than a second request — and a non-admin still fires none. It is also
  // the host's source of truth for what counts as a machine (its `machineIds`
  // prop): the surface must not disagree with itself about which machines exist.
  const { machines, isLoading, error } = useDriveMachines(isAdmin ? driveId ?? null : null);
  const machineIds = useMemo(() => machines.map((machine) => machine.id), [machines]);

  useDrainPendingSession(selectedMachineId);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {children}

      {selectedMachineId && (
        <DetailState
          isAdmin={isAdmin}
          isLoading={isLoading}
          error={error}
          isKnownMachine={machineIds.includes(selectedMachineId)}
        />
      )}

      <MachineKeepAliveHost driveId={driveId} activePageId={selectedMachineId} machineIds={machineIds} />
    </div>
  );
}

/**
 * What the detail pane shows when the machine itself can't be. Rendered UNDER
 * the keep-alive host (which is `absolute inset-0 z-10` and opaque), so a state
 * here is covered the moment the machine actually mounts. Without it, every one
 * of these cases is an unexplained blank region — the route renders null and the
 * host declines to mount.
 */
function DetailState({
  isAdmin,
  isLoading,
  error,
  isKnownMachine,
}: {
  isAdmin: boolean;
  isLoading: boolean;
  error: Error | undefined;
  isKnownMachine: boolean;
}) {
  if (!isAdmin) return <DetailNotice title="Machine access requires administrator privileges" />;
  // Before "not found": a failed fetch leaves `machines` empty with isLoading
  // false, which is indistinguishable from "this machine doesn't exist" unless
  // the error is checked FIRST. Getting this order wrong told users their
  // perfectly good machine had been deleted.
  if (error) {
    return (
      <DetailNotice title="Failed to load machines" description="Check your connection and try again." />
    );
  }
  if (isLoading) return <DetailNotice title="Opening machine…" />;
  if (!isKnownMachine) {
    return (
      <DetailNotice
        title="Machine not found"
        description="It may have been deleted, or you may not have access to it."
      />
    );
  }
  // The machine exists and the host is mounting it — it will paint over this.
  return <DetailNotice title="Opening machine…" />;
}

function DetailNotice({ title, description }: { title: string; description?: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
      <Cpu className="size-10 text-muted-foreground" />
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
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
 *
 * Leaving the surface drops any unconverged intent: the store is a module
 * singleton, so an intent left behind here would otherwise still be sitting
 * there on the user's next visit, ready to fire into whatever pane was active.
 */
function useDrainPendingSession(selectedMachineId: string | null) {
  const pending = usePendingSessionStore((state) => state.pending);
  const clearPending = usePendingSessionStore((state) => state.clearPending);
  const openTerminal = useMachineWorkspaceStore((state) => state.openTerminal);
  const workspace = useMachineWorkspaceStore((state) =>
    pending ? state.workspaces[pending.machineId] : undefined,
  );

  useEffect(() => {
    const action = resolvePendingSession(pending, selectedMachineId, workspace, Date.now());
    if (action.type === 'open') openTerminal(action.machineId, action.scope);
    // A 'clear' with no pending intent is a no-op, so this cannot loop.
    else if (action.type === 'clear') clearPending();
  }, [pending, selectedMachineId, workspace, openTerminal, clearPending]);

  useEffect(() => () => clearPending(), [clearPending]);
}

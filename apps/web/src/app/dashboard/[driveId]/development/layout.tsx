'use client';

import { useParams, usePathname } from 'next/navigation';
import MachineKeepAliveHost from '@/components/layout/middle-content/MachineKeepAliveHost';
import { useAuth } from '@/hooks/useAuth';
import { useDriveMachines } from '@/hooks/useDriveMachines';
import { parseSelectedMachineId } from '@/lib/development/development-route';
import { useStickyMachineIds } from '@/lib/development/use-sticky-machine-ids';
import { useDrainPendingSession } from '@/lib/development/use-drain-pending-session';
import { DetailState } from '@/lib/development/DetailState';

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

  const { user, isLoading: authLoading } = useAuth();
  const isAdmin = user?.role === 'admin';

  // Same SWR key (and same admin gate) as the sidebar, so this is a cache read
  // rather than a second request — and a non-admin still fires none. It is also
  // the host's source of truth for what counts as a machine (its `machineIds`
  // prop): the surface must not disagree with itself about which machines exist.
  const { machines, isLoading, error } = useDriveMachines(isAdmin ? driveId ?? null : null);
  // Add-only within this drive; resets if the drive changes (see the hook's
  // doc comment) — a PTY stream must not outlive its drive context.
  const stickyMachineIds = useStickyMachineIds(machines, driveId);

  // Two different questions, two different answers — conflating them is what made
  // an earlier version both kill live terminals AND never report a deleted one.
  //
  // "Does this machine still exist?" is answered by the LATEST fetch: a machine
  // that's gone must stop being shown, or "Machine not found" is unreachable.
  // "Which machines may stay mounted?" is answered by the STICKY set, because a
  // machine can drop out of a fetch without being deleted (see below) and
  // unmounting it would disconnect a running terminal.
  //
  // So a machine that vanishes stops being *displayed* immediately, while its
  // terminal stays warm (hidden) until the LRU ages it out. A fetch blip
  // therefore costs the user a notice, never a dead session — and the notice IS
  // transient, because `useDriveMachines` polls (without that, a single blip
  // would hide a live machine for the rest of the session, and both ways out —
  // reload, or leave and return — unmount this host and kill every warm
  // terminal).
  const isKnownMachine = selectedMachineId !== null && machines.some((m) => m.id === selectedMachineId);
  // What the host actually DISPLAYS — not merely what the URL selects. The drain
  // must gate on this same value: opening a session into a machine the host is
  // keeping hidden would mount an xterm inside a `display:none` container, where
  // `fit()` measures a zero-sized box and the PTY is created at a bogus geometry
  // — wrapping its output for the life of the session.
  const displayedMachineId = isKnownMachine ? selectedMachineId : null;

  useDrainPendingSession(displayedMachineId);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {children}

      {selectedMachineId && (
        <DetailState
          authLoading={authLoading}
          isAdmin={isAdmin}
          isLoading={isLoading}
          error={error}
          isKnownMachine={isKnownMachine}
        />
      )}

      <MachineKeepAliveHost driveId={driveId} activePageId={displayedMachineId} machineIds={stickyMachineIds} />
    </div>
  );
}

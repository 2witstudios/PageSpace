'use client';

import { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import MachineKeepAliveHost from '@/components/layout/middle-content/MachineKeepAliveHost';
import { useAuth } from '@/hooks/useAuth';
import { useAllMachines } from '@/hooks/useDriveMachines';
import { parseSelectedMachineId } from '@/lib/development/development-route';
import { useStickyMachineIds } from '@/lib/development/use-sticky-machine-ids';
import { useDrainPendingSession } from '@/lib/development/use-drain-pending-session';
import { DetailState } from '@/lib/development/DetailState';
import { resolveDisplayedMachine } from '@/lib/development/displayed-machine';

/**
 * The GLOBAL Development surface's detail region — the driveless twin of
 * `[driveId]/development/layout.tsx`. Same composition (see that file's doc
 * comment for the terminal-keep-alive reasoning this shares), sourced from
 * `useAllMachines()` — every drive's machines — instead of one drive's.
 *
 * Deliberately its OWN layout rather than folding into the drive-scoped one:
 * Next.js remounts a segment when the route TREE changes, not just its
 * params, so a machine opened from here stays at
 * `/dashboard/development/{machineId}` — never crossing into the
 * `/dashboard/{driveId}/development` tree — or this host (and every terminal
 * it's keeping warm) would be torn down the moment the URL picked up a drive
 * segment.
 *
 * KNOWN TRADEOFF this doesn't solve: the user can still leave this route tree
 * directly, e.g. by switching drives (or clicking the sidebar's "Development"
 * nav item while a drive is active), which points at
 * `/dashboard/{driveId}/development` — a different tree — and unmounts this
 * host, disconnecting every terminal it was keeping warm across EVERY drive,
 * not just the one being left. This mirrors an already-accepted tradeoff
 * elsewhere in this surface (switching drives already tears down the OTHER
 * drive's warm terminals — "a PTY stream must not outlive its drive context",
 * see `useStickyMachineIds`), and the disconnect is recoverable (the PTY
 * itself survives server-side and the terminal reconnects on remount) rather
 * than data loss. Solving it for real would mean hoisting a single
 * `MachineKeepAliveHost` above BOTH route trees, which is a larger change than
 * this fix warrants — noted here rather than attempted.
 */
export default function GlobalDevelopmentLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const selectedMachineId = parseSelectedMachineId(pathname, undefined);

  const { user, isLoading: authLoading } = useAuth();
  const isAdmin = user?.role === 'admin';

  // Same SWR key (and same admin gate) as the sidebar's global mode, so this
  // is a cache read rather than a second request — and a non-admin still
  // fires none.
  const { drives, isLoading, error } = useAllMachines(isAdmin);
  const machines = useMemo(() => drives.flatMap((drive) => drive.machines), [drives]);
  // Add-only for the life of this layout — see the hook's doc comment for why
  // a fetch blip must not evict a warm terminal. `undefined` (rather than a
  // constant sentinel string) is this hook's own idiom for "no scope to reset
  // on" — global browsing has no per-drive context to leave.
  const stickyMachineIds = useStickyMachineIds(machines, undefined);

  const { isKnownMachine, displayedMachineId } = resolveDisplayedMachine(machines, selectedMachineId);

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

      <MachineKeepAliveHost driveId={undefined} activePageId={displayedMachineId} machineIds={stickyMachineIds} />
    </div>
  );
}

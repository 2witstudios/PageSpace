'use client';

import { useEffect, useState } from 'react';
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

  const { user, isLoading: authLoading } = useAuth();
  const isAdmin = user?.role === 'admin';

  // Same SWR key (and same admin gate) as the sidebar, so this is a cache read
  // rather than a second request — and a non-admin still fires none. It is also
  // the host's source of truth for what counts as a machine (its `machineIds`
  // prop): the surface must not disagree with itself about which machines exist.
  const { machines, isLoading, error } = useDriveMachines(isAdmin ? driveId ?? null : null);
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

/**
 * Every machine id seen in this drive — the set the host is allowed to keep
 * MOUNTED. Add-only, and only within a drive.
 *
 * The host unmounts (and so DISCONNECTS) anything missing from this set. But a
 * machine can drop out of `/api/machines` without having been deleted: the
 * per-page permission check swallows DB errors and reports "cannot view", so a
 * transient hiccup silently omits a live machine. Evicting on that would kill a
 * running terminal — the exact failure this list was introduced to prevent.
 *
 * Being add-only doesn't strand a deleted machine on screen: what is DISPLAYED
 * is decided by the latest fetch (see `isKnownMachine`), so a deleted machine
 * stops being shown at once and merely lingers, hidden, until the bounded LRU
 * ages it out. Changing drive resets the set — that eviction is deliberate, since
 * a PTY stream must not outlive its drive context.
 */
function useStickyMachineIds(machines: { id: string }[], driveId: string | undefined): string[] {
  // Keyed on the fetched ids (not the array identity — SWR hands back a fresh
  // array on every revalidation) and the drive. Derived with the same
  // "adjust state during render" pattern MachineKeepAliveHost uses for its LRU:
  // the key guards the re-render, and state (unlike a ref) is discarded if a
  // concurrent render is abandoned, so an interrupted navigation can't leave a
  // machine set behind that was never committed.
  const key = `${driveId ?? ''}\u0000${machines.map((machine) => machine.id).join('|')}`;
  const [sticky, setSticky] = useState<{ key: string; driveId: string | undefined; ids: string[] }>({
    key: '',
    driveId,
    ids: [],
  });

  if (sticky.key !== key) {
    const ids = sticky.driveId === driveId ? [...sticky.ids] : [];
    for (const machine of machines) {
      if (!ids.includes(machine.id)) ids.push(machine.id);
    }
    setSticky({ key, driveId, ids });
    return ids;
  }

  return sticky.ids;
}

/**
 * What the detail pane shows when the machine itself can't be. Rendered UNDER
 * the keep-alive host (which is `absolute inset-0 z-10` and opaque), so a state
 * here is covered the moment the machine actually mounts. Without it, every one
 * of these cases is an unexplained blank region — the route renders null and the
 * host declines to mount.
 */
function DetailState({
  authLoading,
  isAdmin,
  isLoading,
  error,
  isKnownMachine,
}: {
  authLoading: boolean;
  isAdmin: boolean;
  isLoading: boolean;
  error: Error | undefined;
  isKnownMachine: boolean;
}) {
  // `role` isn't persisted across a reload, so on every cold load it is briefly
  // unknown. Refusing the user in that window would flash "you're not an admin"
  // at an admin refreshing the page — the same gate the sidebar applies.
  if (authLoading) return <DetailNotice title="Opening machine…" />;
  if (!isAdmin) return <DetailNotice title="Machine access requires administrator privileges" />;
  // Ahead of "not found", because a failed fetch leaves `machines` empty with
  // isLoading false — indistinguishable from "this machine doesn't exist" unless
  // the error is checked first. But only when the machine ISN'T known: the list
  // polls, and SWR keeps the last good data while setting `error` on a failed
  // revalidation, so a blip must not blank out a machine we can still show.
  if (error && !isKnownMachine) {
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
    const action = resolvePendingSession(pending, selectedMachineId, workspace);
    if (action.type === 'open') openTerminal(action.machineId, action.scope);
    // A 'clear' with no pending intent is a no-op, so this cannot loop.
    else if (action.type === 'clear') clearPending();
  }, [pending, selectedMachineId, workspace, openTerminal, clearPending]);

  useEffect(() => () => clearPending(), [clearPending]);
}

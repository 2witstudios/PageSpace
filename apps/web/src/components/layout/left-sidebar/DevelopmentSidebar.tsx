'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';

import { ScrollArea } from '@/components/ui/scroll-area';
import { cn, isElectron } from '@/lib/utils';
import type { SidebarProps } from './index';
import DriveSwitcher from '@/components/layout/navbar/DriveSwitcher';
import DashboardFooter from './DashboardFooter';
import DriveFooter from './DriveFooter';
import PrimaryNavigation from './PrimaryNavigation';
import { useAuth } from '@/hooks/useAuth';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useDriveStore } from '@/hooks/useDrive';
import { canManageDrive } from '@/hooks/usePermissions';
import { useDriveMachines, useAllMachines, type DriveMachine, type DriveMachineGroup } from '@/hooks/useDriveMachines';
import { usePendingSessionStore } from '@/stores/development/usePendingSessionStore';
import { useMachineTabStore } from '@/stores/machine-workspace/useMachineTabStore';
import { parseSelectedMachineId, buildMachineHref } from '@/lib/development/development-route';
import type { OpenTerminalScope } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import MachineTree, { type MachineTreeNode } from '@/components/layout/middle-content/page-views/machine/workspace/MachineTree';
import SessionLeaves from '@/components/layout/middle-content/page-views/machine/workspace/SessionLeaves';

/**
 * The Development surface's left sidebar. Two modes, one component (mirroring
 * how `MemoizedSidebar` routes both Development URL shapes here):
 *
 * - **Drive-scoped** (`driveId` present): every Machine in that drive, each
 *   expanding into the SAME `MachineTree` the Machine page's Terminal tab
 *   uses, with the SAME session leaves hanging off its nodes.
 * - **Global** (`driveId` absent, i.e. `/dashboard/development`): every
 *   Machine across every drive the admin can access, grouped under a drive
 *   header — the aggregated list `useAllMachines` serves.
 *
 * The aggregation is the only new part in either mode — the tree below each
 * machine is the existing component.
 *
 * It sits above the routed detail pane, so clicking through machines swaps only
 * the pane and the tree keeps its expansion state. The terminals themselves
 * survive because the detail region renders machines through
 * `MachineKeepAliveHost` (see this surface's layouts) rather than from the route
 * segment — which remounts, and would otherwise tear down the xterm buffer and
 * socket on every machine switch.
 */
export default function DevelopmentSidebar({ className }: SidebarProps) {
  const params = useParams();
  const [isElectronMac, setIsElectronMac] = useState(false);
  const isSheetBreakpoint = useBreakpoint('(max-width: 1023px)');

  const driveIdParams = params.driveId;
  const driveId = Array.isArray(driveIdParams) ? driveIdParams[0] : driveIdParams;

  const drives = useDriveStore((state) => state.drives);
  const drive = drives.find((d) => d.id === driveId);
  const canManage = canManageDrive(drive);

  const { user, isLoading: authLoading } = useAuth();
  const isAdmin = user?.role === 'admin';

  // The same gate MachineView applies, moved one level earlier: a non-admin who
  // can VIEW a Machine page must not be able to enumerate any drive's machines —
  // nor have this tree fetch their projects/branches/sessions on their behalf,
  // which is structure the Machine page itself withholds from them. Passing a
  // disabled key is what keeps those requests from ever being made. Both hooks
  // are called unconditionally (Rules of Hooks); only one is ever enabled.
  const { machines, isLoading: driveMachinesLoading, error: driveMachinesError } = useDriveMachines(
    isAdmin && driveId ? driveId : null,
  );
  const { drives: machineDrives, isLoading: allMachinesLoading, error: allMachinesError } = useAllMachines(
    isAdmin && !driveId,
  );

  const pathname = usePathname() ?? '';
  const selectedMachineId = parseSelectedMachineId(pathname, driveId);

  useEffect(() => {
    setIsElectronMac(isElectron() && /Mac/.test(navigator.platform));
  }, []);

  return (
    <aside
      className={cn(
        'flex h-full w-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-sidebar-foreground liquid-glass-regular rounded-tr-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none overflow-hidden',
        className
      )}
    >
      <div className="flex h-full flex-col px-3 py-3">
        <div className={cn('mb-3', isElectronMac && isSheetBreakpoint && 'pl-[60px]')}>
          <DriveSwitcher />
        </div>

        <PrimaryNavigation driveId={driveId} />

        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-1">
            {driveId ? (
              <DriveMachineList
                authLoading={authLoading}
                isAdmin={isAdmin}
                driveId={driveId}
                machines={machines}
                isLoading={driveMachinesLoading}
                error={driveMachinesError}
                selectedMachineId={selectedMachineId}
                isSheetBreakpoint={isSheetBreakpoint}
              />
            ) : (
              <GlobalMachineList
                authLoading={authLoading}
                isAdmin={isAdmin}
                drives={machineDrives}
                isLoading={allMachinesLoading}
                error={allMachinesError}
                selectedMachineId={selectedMachineId}
                isSheetBreakpoint={isSheetBreakpoint}
              />
            )}
          </div>
        </ScrollArea>

        {driveId ? <DriveFooter canManage={canManage} /> : <DashboardFooter />}
      </div>
    </aside>
  );
}

/** A resting state of the machine list: one line of muted text, no tree. */
function ListNotice({ children }: { children: string }) {
  return <div className="py-8 text-center text-sm text-muted-foreground">{children}</div>;
}

/**
 * The one ordering-sensitive guard chain both list bodies need, shared so a
 * future fix to the ordering (e.g. why error is checked ahead of loading, or
 * loading ahead of empty) only has to be made once. Returns the notice to
 * show, or `null` when the caller should render its actual list.
 *
 * Order matters: auth-pending and non-admin come first so a cold load or a
 * refused user never sees "Failed"/"empty" wording instead. Error is checked
 * ahead of loading and empty because SWR reports `isLoading: false` with no
 * data on its error path — indistinguishable from "genuinely empty" unless
 * error is checked first — but only when there's nothing to show yet: a
 * background poll's error must not tear down a list the caller already has.
 */
function resolveListNotice({
  authLoading,
  isAdmin,
  hasError,
  isLoading,
  isEmpty,
  emptyMessage,
}: {
  authLoading: boolean;
  isAdmin: boolean;
  hasError: boolean;
  isLoading: boolean;
  isEmpty: boolean;
  emptyMessage: string;
}): string | null {
  if (authLoading) return 'Loading…';
  // Same wording MachineView uses, so the surface and the page refuse a
  // non-admin identically.
  if (!isAdmin) return 'Machine access requires administrator privileges';
  if (hasError && isEmpty) return 'Failed to load machines';
  if (isLoading) return 'Loading…';
  if (isEmpty) return emptyMessage;
  return null;
}

/** The drive-scoped list body: every machine in one drive. */
function DriveMachineList({
  authLoading,
  isAdmin,
  driveId,
  machines,
  isLoading,
  error,
  selectedMachineId,
  isSheetBreakpoint,
}: {
  authLoading: boolean;
  isAdmin: boolean;
  driveId: string;
  machines: DriveMachine[];
  isLoading: boolean;
  error: Error | undefined;
  selectedMachineId: string | null;
  isSheetBreakpoint: boolean;
}) {
  const notice = resolveListNotice({
    authLoading,
    isAdmin,
    hasError: !!error,
    isLoading,
    isEmpty: machines.length === 0,
    emptyMessage: 'No machines in this drive yet',
  });
  if (notice) return <ListNotice>{notice}</ListNotice>;

  return (
    <>
      {machines.map((machine) => (
        <MachineTreeSection
          key={machine.id}
          driveId={driveId}
          machineId={machine.id}
          title={machine.title}
          selected={machine.id === selectedMachineId}
          isSheetBreakpoint={isSheetBreakpoint}
        />
      ))}
    </>
  );
}

/** The GLOBAL list body: every drive's machines, grouped under a drive header. */
function GlobalMachineList({
  authLoading,
  isAdmin,
  drives,
  isLoading,
  error,
  selectedMachineId,
  isSheetBreakpoint,
}: {
  authLoading: boolean;
  isAdmin: boolean;
  drives: DriveMachineGroup[];
  isLoading: boolean;
  error: Error | undefined;
  selectedMachineId: string | null;
  isSheetBreakpoint: boolean;
}) {
  const notice = resolveListNotice({
    authLoading,
    isAdmin,
    hasError: !!error,
    isLoading,
    isEmpty: drives.length === 0,
    emptyMessage: 'No machines across your drives yet',
  });
  if (notice) return <ListNotice>{notice}</ListNotice>;

  return (
    <>
      {drives.map((drive) => (
        <div key={drive.driveId} className="space-y-1">
          <div className="px-2 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {drive.driveName}
          </div>
          {drive.machines.map((machine) => (
            <MachineTreeSection
              key={machine.id}
              driveId={undefined}
              machineId={machine.id}
              title={machine.title}
              selected={machine.id === selectedMachineId}
              isSheetBreakpoint={isSheetBreakpoint}
            />
          ))}
        </div>
      ))}
    </>
  );
}

const MACHINE_NODE: MachineTreeNode = { level: 'machine' };

/** Only the machine row addresses a URL, so only it is selectable. */
const isMachineNode = (node: MachineTreeNode) => node.level === 'machine';

/**
 * One machine in the aggregated tree. Selecting the machine row routes to its
 * detail pane; the projects/branches below it are the shared `MachineTree`, and
 * are NOT selectable — only the machine row addresses a URL, so making the other
 * rows "selectable" would hand them a click action that goes nowhere (and would
 * cost them their expand-on-label-click affordance).
 *
 * `driveId` is the drive this row's caller is scoped to — `undefined` in
 * global mode. It's only ever used to build the href via the centralized
 * `buildMachineHref` (which is also what keeps global mode from routing into
 * `/dashboard/{driveId}/development/{machineId}` even though the drive is
 * known — see that function's doc comment for why).
 */
function MachineTreeSection({
  driveId,
  machineId,
  title,
  selected,
  isSheetBreakpoint,
}: {
  driveId: string | undefined;
  machineId: string;
  title: string;
  selected: boolean;
  /** Passed down rather than re-derived: one matchMedia listener for the sidebar, not one per machine. */
  isSheetBreakpoint: boolean;
}) {
  const router = useRouter();
  const setLeftSheetOpen = useLayoutStore((state) => state.setLeftSheetOpen);
  const requestSession = usePendingSessionStore((state) => state.requestSession);
  const clearPending = usePendingSessionStore((state) => state.clearPending);
  const focusTerminal = useMachineTabStore((state) => state.focusTerminal);

  const navigateToMachine = useCallback(() => {
    router.push(buildMachineHref(driveId, machineId));
    if (isSheetBreakpoint) setLeftSheetOpen(false);
  }, [router, driveId, machineId, isSheetBreakpoint, setLeftSheetOpen]);

  const openMachine = useCallback(() => {
    // Picking the machine itself (not one of its sessions) says the user wants
    // this machine as it is — so an older, still-unconverged session intent must
    // not follow them here and take over the pane.
    clearPending();
    navigateToMachine();
  }, [clearPending, navigateToMachine]);

  const onOpenTerminal = useCallback(
    (scope: OpenTerminalScope) => {
      // Bring the machine's Terminal tab forward FIRST. Only that tab mounts the
      // machine's workspace, so on a machine parked on Code/Diff/Settings the
      // session would otherwise have nowhere to land — the click would do
      // nothing at all.
      focusTerminal(machineId);
      // Then record the intent and navigate; the surface's layout opens the
      // session once that machine's pane region exists. Writing the pane straight
      // into the workspace store from here would not survive — MachineWorkspace
      // disposes its workspace on unmount and rebuilds it on mount, destroying
      // anything authored ahead of it.
      requestSession(machineId, scope);
      navigateToMachine();
    },
    [focusTerminal, requestSession, machineId, navigateToMachine],
  );

  const renderNodeChildren = useCallback(
    (node: MachineTreeNode) => (
      <SessionLeaves machineId={machineId} node={node} onOpenTerminal={onOpenTerminal} />
    ),
    [machineId, onOpenTerminal],
  );

  return (
    <MachineTree
      machineId={machineId}
      machineLabel={title}
      // N machines on screen: collapsed until asked for, so mounting the surface
      // doesn't fire a project fetch per machine.
      defaultExpanded={false}
      // MachineTree passes the clicked node; only the machine row is selectable
      // here, so the node adds nothing the closure doesn't already know.
      onSelectNode={openMachine}
      isNodeSelectable={isMachineNode}
      selectedNode={selected ? MACHINE_NODE : null}
      renderNodeChildren={renderNodeChildren}
    />
  );
}

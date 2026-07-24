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
import { usePendingWorkspaceStore } from '@/stores/development/usePendingWorkspaceStore';
import { useMachineTabStore } from '@/stores/machine-workspace/useMachineTabStore';
import { parseSelectedMachineId, buildMachineHref } from '@/lib/development/development-route';
import MachineTree, { type MachineTreeNode } from '@/components/layout/middle-content/page-views/machine/workspace/MachineTree';
import WorkspaceLeaves, { WorkspaceNodeExtras } from '@/components/layout/middle-content/page-views/machine/workspace/WorkspaceLeaves';
import { SidebarLoading, SidebarNotice } from '@/components/layout/middle-content/page-views/machine/tabs/tab-states';
import { useMachineWorkspaceSync } from '@/hooks/useMachineWorkspaceSync';

/**
 * The Development surface's left sidebar. Two modes, one component (mirroring
 * how `MemoizedSidebar` routes both Development URL shapes here):
 *
 * - **Drive-scoped** (`driveId` present): every Machine in that drive, each
 *   expanding into the SAME `MachineTree` the Machine page's Terminal tab
 *   uses, with the SAME workspace-item leaves hanging off its nodes —
 *   selecting one switches the machine's ENTIRE middle view to that
 *   workspace's grid.
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
 * socket on every machine switch. The Terminal tab it lands on renders
 * `embedded` (see `TerminalTab`), so this sidebar is the ONLY workspace nav
 * visible — no redundant second tree inside the detail pane.
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
  const {
    machines,
    isLoading: driveMachinesLoading,
    error: driveMachinesError,
    mutate: retryDriveMachines,
  } = useDriveMachines(isAdmin && driveId ? driveId : null);
  const {
    drives: machineDrives,
    isLoading: allMachinesLoading,
    error: allMachinesError,
    mutate: retryAllMachines,
  } = useAllMachines(isAdmin && !driveId);

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
                onRetry={retryDriveMachines}
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
                onRetry={retryAllMachines}
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

/**
 * The one ordering-sensitive guard chain both list bodies need, shared so a
 * future fix to the ordering (e.g. why loading is checked ahead of error, or
 * error ahead of empty) only has to be made once. Returns the notice to
 * show, or `null` when the caller should render its actual list.
 *
 * Order matters: auth-pending and non-admin come first so a cold load or a
 * refused user never sees "Failed"/"empty" wording instead. Loading is
 * checked ahead of error so that a Retry click — which sets `isLoading` back
 * to `true` (SWR does this whenever cached `data` is still `undefined`,
 * exactly the "nothing loaded yet" state a failed fetch leaves behind) while
 * `error` stays at its stale, pre-retry value until the new attempt settles —
 * shows the loading state and not a rerun of the same "Failed" text with no
 * visible reaction to the click. Error is then checked ahead of empty because
 * SWR reports `isLoading: false` with no data on its error path —
 * indistinguishable from "genuinely empty" unless error is checked first —
 * but only when there's nothing to show yet: a background poll's error must
 * not tear down a list the caller already has.
 *
 * Built on the Machine page's shared `SidebarLoading`/`SidebarNotice`
 * vocabulary (see `tab-states.tsx`) rather than a bespoke notice, so this
 * list reads like every other compact sidebar state in the app: a spinner row
 * while loading, and a muted/destructive row — with a retry action on the
 * failure branch — otherwise.
 */
function resolveListNotice({
  authLoading,
  isAdmin,
  hasError,
  isLoading,
  isEmpty,
  emptyTitle,
  onRetry,
}: {
  authLoading: boolean;
  isAdmin: boolean;
  hasError: boolean;
  isLoading: boolean;
  isEmpty: boolean;
  emptyTitle: string;
  onRetry: () => void;
}): React.ReactNode {
  if (authLoading) return <SidebarLoading message="Loading…" />;
  // Same wording MachineView uses, so the surface and the page refuse a
  // non-admin identically.
  if (!isAdmin) return <SidebarNotice title="Machine access requires administrator privileges" />;
  if (isLoading) return <SidebarLoading message="Loading machines…" />;
  if (hasError && isEmpty) {
    return (
      <SidebarNotice
        title="Failed to load machines"
        description="Check your connection and try again."
        tone="destructive"
        actionLabel="Retry"
        onAction={onRetry}
      />
    );
  }
  if (isEmpty) return <SidebarNotice title={emptyTitle} />;
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
  onRetry,
  selectedMachineId,
  isSheetBreakpoint,
}: {
  authLoading: boolean;
  isAdmin: boolean;
  driveId: string;
  machines: DriveMachine[];
  isLoading: boolean;
  error: Error | undefined;
  onRetry: () => void;
  selectedMachineId: string | null;
  isSheetBreakpoint: boolean;
}) {
  const notice = resolveListNotice({
    authLoading,
    isAdmin,
    hasError: !!error,
    isLoading,
    isEmpty: machines.length === 0,
    emptyTitle: 'No machines in this drive yet',
    onRetry,
  });
  if (notice) return notice;

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
  onRetry,
  selectedMachineId,
  isSheetBreakpoint,
}: {
  authLoading: boolean;
  isAdmin: boolean;
  drives: DriveMachineGroup[];
  isLoading: boolean;
  error: Error | undefined;
  onRetry: () => void;
  selectedMachineId: string | null;
  isSheetBreakpoint: boolean;
}) {
  const notice = resolveListNotice({
    authLoading,
    isAdmin,
    hasError: !!error,
    isLoading,
    isEmpty: drives.length === 0,
    // Backend note (`listMachinesAcrossDrives`): a drive with zero VISIBLE
    // machines is dropped from the payload entirely rather than served as an
    // empty group, so there is no reachable "drive with no machines" state to
    // render here — only the whole-list empty case above.
    emptyTitle: 'No machines across your drives yet',
    onRetry,
  });
  if (notice) return notice;

  return (
    <>
      {drives.map((drive) => (
        <div key={drive.driveId} className="space-y-1">
          <div className="px-2 pt-1 text-xs font-normal uppercase tracking-wide text-muted-foreground leading-none">
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
  const requestWorkspace = usePendingWorkspaceStore((state) => state.requestWorkspace);
  const clearPending = usePendingWorkspaceStore((state) => state.clearPending);
  const focusTerminal = useMachineTabStore((state) => state.focusTerminal);
  // `WorkspaceLeaves`/`WorkspaceNodeExtras` below render the SAME server-synced
  // workspace tree `MachineView`'s Terminal tab does (see this file's own doc
  // comment), but `MachineView` — the sync hook's OTHER mount point — is only
  // mounted once the user actually navigates INTO a machine. Without mounting it
  // here too, expanding a machine's row in this sidebar without ever visiting
  // its page would render, and push from, a never-hydrated local store.
  //
  // (`ensureMachine` no longer fabricates a phantom "Workspace 1" for a machine
  // this browser hasn't hydrated — an un-hydrated machine now simply shows no
  // rows. So the failure this guards against is narrower than it was: acting on
  // stale local state, not inventing rows. The machine currently open therefore
  // has TWO instances of the sync hook — this one and `MachineView`'s — which is
  // by design and documented as such in that hook's module doc: entity
  // promotion (#2202) made every hydrate/verb application rev-gated, so two
  // instances converge on the same state with no cross-instance coordination
  // needed at all, unlike the blob era's module-level bootstrap-decline registry.)
  //
  // Mounted once per machine row (this component's own lifetime in the sidebar
  // list, not tied to the tree node's expand/collapse) so it doesn't re-join the
  // socket room or re-fetch on every expand.
  useMachineWorkspaceSync(machineId);

  const navigateToMachine = useCallback(() => {
    router.push(buildMachineHref(driveId, machineId));
    if (isSheetBreakpoint) setLeftSheetOpen(false);
  }, [router, driveId, machineId, isSheetBreakpoint, setLeftSheetOpen]);

  const openMachine = useCallback(() => {
    // Picking the machine itself (not one of its workspaces) says the user
    // wants this machine as it is — so an older, still-unconverged workspace
    // intent must not follow them here and take over the pane.
    clearPending();
    navigateToMachine();
  }, [clearPending, navigateToMachine]);

  const onSelectWorkspace = useCallback(
    (workspaceId: string) => {
      // Bring the machine's Terminal tab forward FIRST. Only that tab mounts the
      // machine's workspace grid, so on a machine parked on Files/Diff/Settings
      // the click would otherwise have nowhere to land.
      focusTerminal(machineId);
      // Then record the intent and navigate; the surface's layout activates the
      // workspace once that machine's pane region exists.
      requestWorkspace(machineId, workspaceId);
      navigateToMachine();
    },
    [focusTerminal, requestWorkspace, machineId, navigateToMachine],
  );

  const renderNodeChildren = useCallback(
    (node: MachineTreeNode) => (
      <WorkspaceLeaves machineId={machineId} node={node} onSelectWorkspace={onSelectWorkspace} />
    ),
    [machineId, onSelectWorkspace],
  );

  const renderNodeExtra = useCallback(
    (node: MachineTreeNode) => <WorkspaceNodeExtras machineId={machineId} node={node} />,
    [machineId],
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
      renderNodeExtra={renderNodeExtra}
      onWorkspaceCreated={onSelectWorkspace}
    />
  );
}

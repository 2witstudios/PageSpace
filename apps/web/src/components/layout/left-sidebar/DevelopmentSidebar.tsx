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
import { useDriveMachines, type DriveMachine } from '@/hooks/useDriveMachines';
import { usePendingSessionStore } from '@/stores/development/usePendingSessionStore';
import { useMachineTabStore } from '@/stores/machine-workspace/useMachineTabStore';
import { parseSelectedMachineId } from '@/lib/development/development-route';
import type { OpenTerminalScope } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import MachineTree, { type MachineTreeNode } from '@/components/layout/middle-content/page-views/machine/workspace/MachineTree';
import SessionLeaves from '@/components/layout/middle-content/page-views/machine/workspace/SessionLeaves';

/**
 * The Development surface's left sidebar: every Machine in the drive, each
 * expanding into the SAME `MachineTree` the Machine page's Terminal tab uses,
 * with the SAME session leaves hanging off its nodes. The aggregation is the
 * only new part — the tree below each machine is the existing component.
 *
 * It sits above the routed detail pane, so clicking through machines swaps only
 * the pane and the tree keeps its expansion state. The terminals themselves
 * survive because the detail region renders machines through
 * `MachineKeepAliveHost` (see this surface's layout) rather than from the route
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
  // can VIEW a Machine page must not be able to enumerate the drive's machines —
  // nor have this tree fetch their projects/branches/sessions on their behalf,
  // which is structure the Machine page itself withholds from them. Passing a
  // null driveId is what keeps those requests from ever being made.
  const { machines, isLoading, error } = useDriveMachines(isAdmin ? driveId ?? null : null);
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
            <MachineList
              authLoading={authLoading}
              isAdmin={isAdmin}
              driveId={driveId}
              machines={machines}
              isLoading={isLoading}
              error={error}
              selectedMachineId={selectedMachineId}
              isSheetBreakpoint={isSheetBreakpoint}
            />
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
 * The list body. Its states are mutually exclusive, so they're early returns
 * rather than a stack of `&&` guards each having to re-state every earlier
 * condition's negation.
 */
function MachineList({
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
  driveId: string | undefined;
  machines: DriveMachine[];
  isLoading: boolean;
  error: Error | undefined;
  selectedMachineId: string | null;
  isSheetBreakpoint: boolean;
}) {
  // Until auth resolves, `role` is simply unknown — saying "you're not an admin"
  // then would flash the refusal at an admin on every cold load.
  if (authLoading) return <ListNotice>Loading…</ListNotice>;
  // Same wording MachineView uses, so the surface and the page refuse a
  // non-admin identically.
  if (!isAdmin) return <ListNotice>Machine access requires administrator privileges</ListNotice>;
  // The driveless entry redirects, so a missing driveId is the redirect in
  // flight — not a state the user can sit in.
  if (!driveId) return <ListNotice>Opening Development…</ListNotice>;
  if (error) return <ListNotice>Failed to load machines</ListNotice>;
  if (isLoading) return <ListNotice>Loading…</ListNotice>;
  if (machines.length === 0) return <ListNotice>No machines in this drive yet</ListNotice>;

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

const MACHINE_NODE: MachineTreeNode = { level: 'machine' };

/** Only the machine row addresses a URL, so only it is selectable. */
const isMachineNode = (node: MachineTreeNode) => node.level === 'machine';

/**
 * One machine in the aggregated tree. Selecting the machine row routes to its
 * detail pane; the projects/branches below it are the shared `MachineTree`, and
 * are NOT selectable — only the machine row addresses a URL, so making the other
 * rows "selectable" would hand them a click action that goes nowhere (and would
 * cost them their expand-on-label-click affordance).
 */
function MachineTreeSection({
  driveId,
  machineId,
  title,
  selected,
  isSheetBreakpoint,
}: {
  driveId: string;
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
    router.push(`/dashboard/${driveId}/development/${machineId}`);
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

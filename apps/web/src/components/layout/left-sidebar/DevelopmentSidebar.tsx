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
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useDriveStore } from '@/hooks/useDrive';
import { canManageDrive } from '@/hooks/usePermissions';
import { useDriveMachines } from '@/hooks/useDriveMachines';
import { useMachineWorkspaceStore, type OpenTerminalScope } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import MachineTree, { type MachineTreeNode } from '@/components/layout/middle-content/page-views/machine/workspace/MachineTree';
import SessionLeaves from '@/components/layout/middle-content/page-views/machine/workspace/SessionLeaves';

/** The machine whose detail pane is open, from `/dashboard/{driveId}/development/{machineId}`. */
function useSelectedMachineId(driveId: string | undefined): string | null {
  const pathname = usePathname() ?? '';
  if (!driveId) return null;
  const prefix = `/dashboard/${driveId}/development/`;
  if (!pathname.startsWith(prefix)) return null;
  return pathname.slice(prefix.length).split('/')[0] || null;
}

/**
 * The Development surface's left sidebar: every Machine in the drive, each
 * expanding into the SAME `MachineTree` the Machine page's Terminal tab uses,
 * with the SAME session leaves hanging off its nodes. The aggregation is the
 * only new part — the tree below each machine is the existing component.
 *
 * It sits above the routed detail pane in the layout, so clicking through
 * machines swaps only the pane: the tree keeps its expansion state and its open
 * terminal panes survive the navigation.
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

  const { machines, isLoading, error } = useDriveMachines(driveId ?? null);
  const selectedMachineId = useSelectedMachineId(driveId);

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
            {/* The driveless entry redirects, so a missing driveId here means the
                redirect hasn't landed yet — not a state the user can sit in. */}
            {!driveId && (
              <div className="py-8 text-center text-sm text-muted-foreground">Opening Development…</div>
            )}

            {driveId && error && (
              <div className="py-8 text-center text-sm text-muted-foreground">Failed to load machines</div>
            )}

            {driveId && !error && isLoading && (
              <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
            )}

            {driveId && !error && !isLoading && machines.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No machines in this drive yet
              </div>
            )}

            {driveId &&
              machines.map((machine) => (
                <MachineTreeSection
                  key={machine.id}
                  driveId={driveId}
                  machineId={machine.id}
                  title={machine.title}
                  selected={machine.id === selectedMachineId}
                />
              ))}
          </div>
        </ScrollArea>

        {driveId ? <DriveFooter canManage={canManage} /> : <DashboardFooter />}
      </div>
    </aside>
  );
}

const MACHINE_NODE: MachineTreeNode = { level: 'machine' };

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
}: {
  driveId: string;
  machineId: string;
  title: string;
  selected: boolean;
}) {
  const router = useRouter();
  const isSheetBreakpoint = useBreakpoint('(max-width: 1023px)');
  const setLeftSheetOpen = useLayoutStore((state) => state.setLeftSheetOpen);
  const ensureWorkspace = useMachineWorkspaceStore((state) => state.ensureWorkspace);
  const openTerminal = useMachineWorkspaceStore((state) => state.openTerminal);

  const openMachine = useCallback(() => {
    router.push(`/dashboard/${driveId}/development/${machineId}`);
    if (isSheetBreakpoint) setLeftSheetOpen(false);
  }, [router, driveId, machineId, isSheetBreakpoint, setLeftSheetOpen]);

  const onSelectNode = useCallback(() => openMachine(), [openMachine]);

  const onOpenTerminal = useCallback(
    (scope: OpenTerminalScope) => {
      // Open the session into the machine's workspace BEFORE routing: the pane
      // region hasn't mounted yet if the user is coming from another machine,
      // and a transition against a workspace that doesn't exist is a no-op.
      // `ensureWorkspace` is idempotent, so the pane region adopts this
      // workspace on mount rather than replacing it.
      ensureWorkspace(machineId);
      openTerminal(machineId, scope);
      openMachine();
    },
    [ensureWorkspace, openTerminal, machineId, openMachine],
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
      onSelectNode={onSelectNode}
      isNodeSelectable={(node) => node.level === 'machine'}
      selectedNode={selected ? MACHINE_NODE : null}
      renderNodeChildren={renderNodeChildren}
    />
  );
}

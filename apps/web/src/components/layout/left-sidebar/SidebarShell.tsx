"use client";

import type { ReactNode } from "react";

import DriveSwitcher from "@/components/layout/navbar/DriveSwitcher";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useIsMac } from "@/hooks/useIsMac";
import { useDriveStore } from "@/hooks/useDrive";
import { useFavoritesSync } from "@/hooks/useFavorites";
import { canManageDrive } from "@/hooks/usePermissions";
import { focusDriveId, useFocus } from "@/lib/dashboard/focus";
import { cn, isElectron } from "@/lib/utils";
import { SHEET_BREAKPOINT_QUERY } from "@/stores/agents/useAgentSurfaceStore";

import DashboardFooter from "./DashboardFooter";
import DriveFooter from "./DriveFooter";
import PrimaryNavigation from "./PrimaryNavigation";

const ASIDE_CLASS =
  "flex h-full w-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-sidebar-foreground liquid-glass-regular rounded-tr-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none overflow-hidden";

interface SidebarShellProps {
  className?: string;
  /** The variant's body. It brings its own horizontal padding. */
  children: ReactNode;
}

/**
 * The chrome every left sidebar shares — the drive switcher, the primary
 * navigation, and the footer for the current focus — rendered once, here.
 *
 * Four sidebars (pages, channels, DMs, agents) used to each render these
 * three themselves, so "which footer goes with which focus" lived in four
 * places. Now a variant supplies only what differs: its body.
 */
export default function SidebarShell({ className, children }: SidebarShellProps) {
  // The same query the agent surface store consults, so the sheet padding
  // and the store's "is this a sheet" answer can never disagree.
  const isSheetBreakpoint = useBreakpoint(SHEET_BREAKPOINT_QUERY);
  const isElectronMac = useIsMac() && isElectron();
  const focus = useFocus();
  const driveId = focusDriveId(focus);
  // Every sidebar mounts this shell, so this is where favourites revalidate
  // on load and on refocus (the page tree's star menus read the result).
  useFavoritesSync();
  const drive = useDriveStore((state) => (driveId ? state.drives.find((d) => d.id === driveId) : undefined));
  const canManage = canManageDrive(drive);

  // Footer follows the focus: a drive's footer in a drive, the dashboard's
  // for All drives. DMs only ever render under All drives, so they need no
  // special case.
  const footer = focus.kind === "drive" ? <DriveFooter driveId={focus.driveId} canManage={canManage} /> : <DashboardFooter />;

  return (
    <aside className={cn(ASIDE_CLASS, className)}>
      <div className="flex h-full flex-col py-3">
        {/* On macOS Electron in sheet mode, clear the stoplight buttons. */}
        <div className={cn("px-3 mb-3", isElectronMac && isSheetBreakpoint && "pl-[60px]")}>
          <DriveSwitcher />
        </div>

        <div className="px-3">
          <PrimaryNavigation driveId={driveId} />
        </div>

        {children}

        <div className="px-3">{footer}</div>
      </div>
    </aside>
  );
}

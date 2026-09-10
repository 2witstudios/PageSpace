"use client";

import { useEffect, useState, type ReactNode } from "react";

import DriveSwitcher from "@/components/layout/navbar/DriveSwitcher";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useDriveStore } from "@/hooks/useDrive";
import { canManageDrive } from "@/hooks/usePermissions";
import { focusDriveId, useFocus } from "@/lib/dashboard/focus";
import { cn, isElectron } from "@/lib/utils";

import DashboardFooter from "./DashboardFooter";
import DriveFooter from "./DriveFooter";
import PrimaryNavigation from "./PrimaryNavigation";

const ASIDE_CLASS =
  "flex h-full w-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-sidebar-foreground liquid-glass-regular rounded-tr-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none overflow-hidden";

interface SidebarShellProps {
  className?: string;
  /**
   * Which footer closes the sidebar. `focus` (default) follows the focus:
   * a drive's footer in a drive, the dashboard's for All drives. DMs are
   * user-scoped whichever drive is open, so they pin `dashboard`.
   */
  footer?: "focus" | "dashboard";
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
export default function SidebarShell({ className, footer = "focus", children }: SidebarShellProps) {
  const [isElectronMac, setIsElectronMac] = useState(false);
  const isSheetBreakpoint = useBreakpoint("(max-width: 1023px)");
  const focus = useFocus();
  const driveId = focusDriveId(focus);
  const drive = useDriveStore((state) => (driveId ? state.drives.find((d) => d.id === driveId) : undefined));
  const canManage = canManageDrive(drive);

  useEffect(() => {
    setIsElectronMac(isElectron() && /Mac/.test(navigator.platform));
  }, []);

  const showDriveFooter = footer === "focus" && focus.kind === "drive";

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

        <div className="px-3">{showDriveFooter ? <DriveFooter canManage={canManage} /> : <DashboardFooter />}</div>
      </div>
    </aside>
  );
}

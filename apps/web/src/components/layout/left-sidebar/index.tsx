"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSWRConfig } from "swr";
import { Home, Inbox, Lock, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, isElectron } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { getPermissionErrorMessage, canManageDrive } from "@/hooks/usePermissions";
import { useDriveStore } from "@/hooks/useDrive";
import { useLayoutStore } from "@/stores/useLayoutStore";

import CreatePageDialog from "./CreatePageDialog";
import DashboardFooter from "./DashboardFooter";
import DashboardSidebar from "./DashboardSidebar";
import DriveFooter from "./DriveFooter";
import PageTree from "./page-tree/PageTree";
import DriveSwitcher from "@/components/layout/navbar/DriveSwitcher";

export interface SidebarProps {
  className?: string;
  variant?: "desktop" | "overlay";
}

export default function Sidebar({ className }: SidebarProps) {
  const [isCreatePageOpen, setCreatePageOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isElectronMac, setIsElectronMac] = useState(false);
  const params = useParams();
  const { driveId: driveIdParams } = params;
  const { user } = useAuth();
  const isSheetBreakpoint = useBreakpoint("(max-width: 1023px)");
  const setLeftSheetOpen = useLayoutStore((state) => state.setLeftSheetOpen);

  // Use selective Zustand subscriptions to prevent unnecessary re-renders
  const drives = useDriveStore((state) => state.drives);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);

  const driveId = Array.isArray(driveIdParams) ? driveIdParams[0] : driveIdParams;
  const { mutate } = useSWRConfig();

  const drive = drives.find((d) => d.id === driveId);
  const canManage = canManageDrive(drive);

  useEffect(() => {
    if (user?.id) {
      fetchDrives();
    }
  }, [user?.id, fetchDrives]);

  // Detect macOS Electron for stoplight button accommodation
  useEffect(() => {
    setIsElectronMac(isElectron() && /Mac/.test(navigator.platform));
  }, []);

  const handlePageCreated = () => {
    if (driveId) {
      void mutate(`/api/drives/${driveId}/pages`);
    }
  };

  return (
    <aside
      className={cn(
        "flex h-full w-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-sidebar-foreground liquid-glass-regular rounded-tr-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none overflow-hidden",
        className
      )}
    >
      <div className="flex h-full flex-col px-3 py-3">
        {/* Drive Switcher - always visible, at top */}
        {/* On macOS Electron in sheet mode, add left padding to clear stoplight buttons */}
        <div className={cn("mb-3", isElectronMac && isSheetBreakpoint && "pl-[60px]")}>
          <DriveSwitcher />
        </div>

        {/* Dashboard link - always visible */}
        <Link
          href="/dashboard"
          onClick={() => isSheetBreakpoint && setLeftSheetOpen(false)}
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Home className="h-4 w-4" />
          Dashboard
        </Link>

        {/* Inbox link - always visible */}
        <Link
          href={driveId ? `/dashboard/${driveId}/inbox` : "/dashboard/inbox"}
          onClick={() => isSheetBreakpoint && setLeftSheetOpen(false)}
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground mb-3"
        >
          <Inbox className="h-4 w-4" />
          Inbox
        </Link>

        {/* Main content area */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {driveId ? (
            <>
              {/* Drive view: Search + PageTree */}
              <div className="flex items-center gap-2 mb-3 flex-shrink-0">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search pages..."
                    className="h-8 pl-8"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                </div>
                {canManage ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => setCreatePageOpen(true)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                ) : (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled
                          className="h-8 w-8 shrink-0 cursor-not-allowed opacity-50"
                        >
                          <Lock className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{getPermissionErrorMessage("create")}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>

              <div className="flex-1 min-h-0 overflow-hidden">
                <PageTree driveId={driveId as string} searchQuery={searchQuery} />
              </div>
            </>
          ) : (
            /* Dashboard view: Pulse, Favorites, Recents */
            <DashboardSidebar />
          )}
        </div>

        {/* Drive footer - only shown when in a drive */}
        {driveId && <DriveFooter canManage={canManage} />}

        {/* Dashboard footer - only shown when NOT in a drive */}
        {!driveId && <DashboardFooter />}

        {/* Create page dialog */}
        <CreatePageDialog
          parentId={null}
          isOpen={isCreatePageOpen}
          setIsOpen={setCreatePageOpen}
          onPageCreated={handlePageCreated}
          driveId={driveId as string}
        />
      </div>
    </aside>
  );
}
